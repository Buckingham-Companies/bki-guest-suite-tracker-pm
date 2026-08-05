const { app } = require('@azure/functions');
const { sql, withTransaction, query } = require('../shared/db');
const { requireUser, requireAdmin } = require('../shared/auth');
const { recordAudit } = require('../shared/audit');
const { withErrorHandling } = require('../shared/httpHandler');

// GET is open to any authenticated user — staff need to see rates to know what
// a stay will cost, they just can't change them (requireAdmin below).
app.http('ratesList', {
    methods: ['GET'],
    route: 'rates',
    authLevel: 'anonymous',
    handler: withErrorHandling(async (request, context) => {
        requireUser(request);
        const unitId = request.query.get('unitId');
        const propertyId = request.query.get('propertyId');
        const from = request.query.get('from');
        const to = request.query.get('to');

        const result = await query(`
            SELECT r.UnitId, r.RateDate, r.NightlyRate
            FROM Rates r
            JOIN Units u ON u.UnitId = r.UnitId
            WHERE (@unitId IS NULL OR r.UnitId = @unitId)
              AND (@propertyId IS NULL OR u.PropertyId = @propertyId)
              AND (@from IS NULL OR r.RateDate >= @from)
              AND (@to IS NULL OR r.RateDate <= @to)
            ORDER BY r.RateDate
        `, { unitId, propertyId, from, to });

        return {
            jsonBody: result.recordset.map(r => ({
                unitId: r.UnitId,
                date: r.RateDate.toISOString().slice(0, 10),
                rate: r.NightlyRate
            }))
        };
    })
});

// Sets (upserts) the nightly rate for one unit across a date range in one call —
// mirrors the "Set rate" toolbar in the original prototype (from/to/$ per night).
// Admin-only: this is exactly the "pricing" Marliss and Katie said only the
// property manager and Marliss herself should be able to touch.
app.http('ratesSet', {
    methods: ['POST'],
    route: 'rates',
    authLevel: 'anonymous',
    handler: withErrorHandling(async (request, context) => {
        const user = requireAdmin(request);
        const body = await request.json();
        const { unitIds, from, to, rate } = body;

        if (!Array.isArray(unitIds) || unitIds.length === 0 || !from || !to || rate == null || rate < 0) {
            return { status: 400, jsonBody: { error: 'unitIds (array), from, to and a non-negative rate are required.' } };
        }
        if (from > to) {
            return { status: 400, jsonBody: { error: '"from" must not be after "to".' } };
        }

        await withTransaction(async (req, tx) => {
            for (const unitId of unitIds) {
                let cursor = from;
                while (cursor <= to) {
                    const existingReq = new sql.Request(tx);
                    const existing = await existingReq
                        .input('unitId', sql.Int, unitId)
                        .input('date', sql.Date, cursor)
                        .query('SELECT * FROM Rates WHERE UnitId = @unitId AND RateDate = @date');

                    const upsertReq = new sql.Request(tx);
                    const result = await upsertReq
                        .input('unitId', sql.Int, unitId)
                        .input('date', sql.Date, cursor)
                        .input('rate', sql.Decimal(10, 2), rate)
                        .input('createdBy', sql.NVarChar(255), user.email)
                        .query(`
                            MERGE Rates AS target
                            USING (SELECT @unitId AS UnitId, @date AS RateDate) AS src
                            ON target.UnitId = src.UnitId AND target.RateDate = src.RateDate
                            WHEN MATCHED THEN UPDATE SET NightlyRate = @rate, CreatedBy = @createdBy, CreatedAt = SYSUTCDATETIME()
                            WHEN NOT MATCHED THEN INSERT (UnitId, RateDate, NightlyRate, CreatedBy)
                                VALUES (@unitId, @date, @rate, @createdBy)
                            OUTPUT INSERTED.*;
                        `);

                    const after = result.recordset[0];
                    await recordAudit(tx, {
                        entityType: 'Rate',
                        entityId: after.RateId,
                        action: existing.recordset.length ? 'Update' : 'Insert',
                        changedBy: user.email,
                        oldValues: existing.recordset[0] ? { rate: existing.recordset[0].NightlyRate } : null,
                        newValues: { unitId, date: cursor, rate }
                    });

                    // Parsed/incremented/re-serialized entirely in UTC so this is correct
                    // regardless of the host's local timezone (mixing local setDate()
                    // with a UTC-parsed "YYYY-MM-DD" string is what caused a real
                    // off-by-one bug in the frontend's equivalent date math — see
                    // parseDateKey() in frontend/app.js).
                    const d = new Date(cursor + 'T00:00:00Z');
                    d.setUTCDate(d.getUTCDate() + 1);
                    cursor = d.toISOString().slice(0, 10);
                }
            }
        });

        return { status: 204 };
    })
});

// Bulk upsert from the CSV rate-import template (frontend/app.js downloadRateTemplate
// / importRateCsv). Unlike ratesSet, the caller already provides one row per
// unit+date (no range to expand), since that's exactly what a spreadsheet gives you.
// Bad rows are skipped and reported back rather than failing the whole import —
// a single typo in a 300-row seasonal pricing sheet shouldn't block the other 299.
app.http('ratesBulkSet', {
    methods: ['POST'],
    route: 'rates/bulk',
    authLevel: 'anonymous',
    handler: withErrorHandling(async (request, context) => {
        const user = requireAdmin(request);
        const body = await request.json();
        const rows = body.rates;

        if (!Array.isArray(rows) || rows.length === 0) {
            return { status: 400, jsonBody: { error: '"rates" must be a non-empty array of {unitId, date, rate}.' } };
        }
        if (rows.length > 5000) {
            return { status: 400, jsonBody: { error: 'Too many rows in one import (max 5000) — split into smaller files.' } };
        }

        const errors = [];
        let imported = 0;

        // Fetched once up front so an unknown unitId can be skipped as a normal
        // per-row error instead of throwing a foreign-key violation mid-transaction
        // — which would otherwise roll back every row already imported in this batch.
        const validUnitIds = new Set((await query('SELECT UnitId FROM Units')).recordset.map(r => r.UnitId));

        await withTransaction(async (req, tx) => {
            for (let i = 0; i < rows.length; i++) {
                const { unitId, date, rate } = rows[i];
                const rowNum = i + 2; // +1 for 0-index, +1 for the CSV header row
                if (!unitId || !date || !/^\d{4}-\d{2}-\d{2}$/.test(date) || rate == null || isNaN(rate) || rate < 0) {
                    errors.push({ row: rowNum, reason: 'Missing or invalid unit/date/rate.' });
                    continue;
                }
                if (!validUnitIds.has(unitId)) {
                    errors.push({ row: rowNum, reason: `Unit ${unitId} does not exist.` });
                    continue;
                }

                const existingReq = new sql.Request(tx);
                const existing = await existingReq
                    .input('unitId', sql.Int, unitId)
                    .input('date', sql.Date, date)
                    .query('SELECT * FROM Rates WHERE UnitId = @unitId AND RateDate = @date');

                const upsertReq = new sql.Request(tx);
                const result = await upsertReq
                    .input('unitId', sql.Int, unitId)
                    .input('date', sql.Date, date)
                    .input('rate', sql.Decimal(10, 2), rate)
                    .input('createdBy', sql.NVarChar(255), user.email)
                    .query(`
                        MERGE Rates AS target
                        USING (SELECT @unitId AS UnitId, @date AS RateDate) AS src
                        ON target.UnitId = src.UnitId AND target.RateDate = src.RateDate
                        WHEN MATCHED THEN UPDATE SET NightlyRate = @rate, CreatedBy = @createdBy, CreatedAt = SYSUTCDATETIME()
                        WHEN NOT MATCHED THEN INSERT (UnitId, RateDate, NightlyRate, CreatedBy)
                            VALUES (@unitId, @date, @rate, @createdBy)
                        OUTPUT INSERTED.*;
                    `);

                const after = result.recordset[0];
                await recordAudit(tx, {
                    entityType: 'Rate',
                    entityId: after.RateId,
                    action: existing.recordset.length ? 'Update' : 'Insert',
                    changedBy: user.email,
                    oldValues: existing.recordset[0] ? { rate: existing.recordset[0].NightlyRate } : null,
                    newValues: { unitId, date, rate, source: 'csv-import' }
                });
                imported++;
            }
        });

        return { jsonBody: { imported, errors } };
    })
});

// Clears every rate in a range for the given unit(s) — mirrors "Clear rates".
app.http('ratesClear', {
    methods: ['DELETE'],
    route: 'rates',
    authLevel: 'anonymous',
    handler: withErrorHandling(async (request, context) => {
        const user = requireAdmin(request);
        const body = await request.json();
        const { unitIds, from, to } = body;

        if (!Array.isArray(unitIds) || unitIds.length === 0 || !from || !to) {
            return { status: 400, jsonBody: { error: 'unitIds (array), from and to are required.' } };
        }

        await withTransaction(async (req, tx) => {
            for (const unitId of unitIds) {
                const existingReq = new sql.Request(tx);
                const existing = await existingReq
                    .input('unitId', sql.Int, unitId)
                    .input('from', sql.Date, from)
                    .input('to', sql.Date, to)
                    .query('SELECT * FROM Rates WHERE UnitId = @unitId AND RateDate BETWEEN @from AND @to');

                const deleteReq = new sql.Request(tx);
                await deleteReq
                    .input('unitId', sql.Int, unitId)
                    .input('from', sql.Date, from)
                    .input('to', sql.Date, to)
                    .query('DELETE FROM Rates WHERE UnitId = @unitId AND RateDate BETWEEN @from AND @to');

                for (const row of existing.recordset) {
                    await recordAudit(tx, {
                        entityType: 'Rate',
                        entityId: row.RateId,
                        action: 'Delete',
                        changedBy: user.email,
                        oldValues: { unitId: row.UnitId, date: row.RateDate, rate: row.NightlyRate }
                    });
                }
            }
        });

        return { status: 204 };
    })
});
