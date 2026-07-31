const { app } = require('@azure/functions');
const { sql, withTransaction, query } = require('../shared/db');
const { requireUser } = require('../shared/auth');
const { recordAudit } = require('../shared/audit');
const { withErrorHandling } = require('../shared/httpHandler');

// Sums whatever nightly rates are on file for a unit across [checkin, checkout).
// This is the "auto-calculated price" every non-admin booking is priced at —
// nightly rates are the only pricing lever staff don't control (see rates.js).
async function computeAutoPrice(request, unitId, checkin, checkout) {
    const result = await request
        .input('unitId', sql.Int, unitId)
        .input('checkin', sql.Date, checkin)
        .input('checkout', sql.Date, checkout)
        .query(`
            SELECT SUM(NightlyRate) AS Total
            FROM Rates
            WHERE UnitId = @unitId AND RateDate >= @checkin AND RateDate < @checkout
        `);
    return result.recordset[0].Total; // null if no rates are set for any night in range
}

function toBookingRow(r) {
    return {
        id: r.BookingId,
        unitId: r.UnitId,
        checkin: r.CheckIn.toISOString().slice(0, 10),
        checkout: r.CheckOut.toISOString().slice(0, 10),
        price: r.TotalPrice,
        firstName: r.FirstName,
        lastName: r.LastName,
        email: r.Email,
        phone: r.Phone,
        birthMonth: r.BirthMonth,
        birthYear: r.BirthYear,
        createdBy: r.CreatedBy,
        createdAt: r.CreatedAt,
        modifiedBy: r.ModifiedBy,
        modifiedAt: r.ModifiedAt
    };
}

app.http('bookingsList', {
    methods: ['GET'],
    route: 'bookings',
    authLevel: 'anonymous',
    handler: withErrorHandling(async (request, context) => {
        requireUser(request);
        const propertyId = request.query.get('propertyId');
        const from = request.query.get('from');
        const to = request.query.get('to');

        const result = await query(`
            SELECT b.*
            FROM Bookings b
            JOIN Units u ON u.UnitId = b.UnitId
            WHERE b.IsDeleted = 0
              AND (@propertyId IS NULL OR u.PropertyId = @propertyId)
              AND (@from IS NULL OR b.CheckOut > @from)
              AND (@to IS NULL OR b.CheckIn < @to)
            ORDER BY b.CheckIn
        `, { propertyId, from, to });

        return { jsonBody: result.recordset.map(toBookingRow) };
    })
});

app.http('bookingsCreate', {
    methods: ['POST'],
    route: 'bookings',
    authLevel: 'anonymous',
    handler: withErrorHandling(async (request, context) => {
        const user = requireUser(request);
        const body = await request.json();

        if (!body.unitId || !body.checkin || !body.checkout || !body.firstName) {
            return { status: 400, jsonBody: { error: 'unitId, checkin, checkout and firstName are required.' } };
        }
        if (body.checkin >= body.checkout) {
            return { status: 400, jsonBody: { error: 'checkout must be after checkin.' } };
        }

        const inserted = await withTransaction(async (req, tx) => {
            const autoPrice = await computeAutoPrice(req, body.unitId, body.checkin, body.checkout);
            const finalPrice = (user.isAdmin && body.totalPrice != null) ? body.totalPrice : autoPrice;

            const insertReq = new sql.Request(tx);
            const result = await insertReq
                .input('unitId', sql.Int, body.unitId)
                .input('checkin', sql.Date, body.checkin)
                .input('checkout', sql.Date, body.checkout)
                .input('price', sql.Decimal(10, 2), finalPrice)
                .input('firstName', sql.NVarChar(100), body.firstName)
                .input('lastName', sql.NVarChar(100), body.lastName || null)
                .input('email', sql.NVarChar(255), body.email || null)
                .input('phone', sql.NVarChar(30), body.phone || null)
                .input('birthMonth', sql.NVarChar(20), body.birthMonth || null)
                .input('birthYear', sql.SmallInt, body.birthYear || null)
                .input('createdBy', sql.NVarChar(255), user.email)
                .query(`
                    INSERT INTO Bookings
                        (UnitId, CheckIn, CheckOut, TotalPrice, FirstName, LastName, Email, Phone, BirthMonth, BirthYear, CreatedBy)
                    OUTPUT INSERTED.*
                    VALUES
                        (@unitId, @checkin, @checkout, @price, @firstName, @lastName, @email, @phone, @birthMonth, @birthYear, @createdBy)
                `);

            const row = result.recordset[0];
            await recordAudit(tx, {
                entityType: 'Booking',
                entityId: row.BookingId,
                action: 'Insert',
                changedBy: user.email,
                newValues: toBookingRow(row)
            });
            return row;
        });

        return { status: 201, jsonBody: toBookingRow(inserted) };
    })
});

app.http('bookingsUpdate', {
    methods: ['PUT'],
    route: 'bookings/{id}',
    authLevel: 'anonymous',
    handler: withErrorHandling(async (request, context) => {
        const user = requireUser(request);
        const id = request.params.id;
        const body = await request.json();

        if (!body.unitId || !body.checkin || !body.checkout || !body.firstName) {
            return { status: 400, jsonBody: { error: 'unitId, checkin, checkout and firstName are required.' } };
        }
        if (body.checkin >= body.checkout) {
            return { status: 400, jsonBody: { error: 'checkout must be after checkin.' } };
        }

        const updated = await withTransaction(async (req, tx) => {
            const existingReq = new sql.Request(tx);
            const existing = await existingReq
                .input('id', sql.UniqueIdentifier, id)
                .query('SELECT * FROM Bookings WHERE BookingId = @id AND IsDeleted = 0');
            if (existing.recordset.length === 0) {
                const err = new Error('Booking not found.');
                err.statusCode = 404;
                throw err;
            }
            const before = existing.recordset[0];

            const autoPrice = await computeAutoPrice(req, body.unitId, body.checkin, body.checkout);
            const finalPrice = (user.isAdmin && body.totalPrice != null) ? body.totalPrice : autoPrice;

            const updateReq = new sql.Request(tx);
            const result = await updateReq
                .input('id', sql.UniqueIdentifier, id)
                .input('unitId', sql.Int, body.unitId)
                .input('checkin', sql.Date, body.checkin)
                .input('checkout', sql.Date, body.checkout)
                .input('price', sql.Decimal(10, 2), finalPrice)
                .input('firstName', sql.NVarChar(100), body.firstName)
                .input('lastName', sql.NVarChar(100), body.lastName || null)
                .input('email', sql.NVarChar(255), body.email || null)
                .input('phone', sql.NVarChar(30), body.phone || null)
                .input('birthMonth', sql.NVarChar(20), body.birthMonth || null)
                .input('birthYear', sql.SmallInt, body.birthYear || null)
                .input('modifiedBy', sql.NVarChar(255), user.email)
                .query(`
                    UPDATE Bookings SET
                        UnitId = @unitId, CheckIn = @checkin, CheckOut = @checkout, TotalPrice = @price,
                        FirstName = @firstName, LastName = @lastName, Email = @email, Phone = @phone,
                        BirthMonth = @birthMonth, BirthYear = @birthYear,
                        ModifiedBy = @modifiedBy, ModifiedAt = SYSUTCDATETIME()
                    OUTPUT INSERTED.*
                    WHERE BookingId = @id
                `);

            const after = result.recordset[0];
            await recordAudit(tx, {
                entityType: 'Booking',
                entityId: id,
                action: 'Update',
                changedBy: user.email,
                oldValues: toBookingRow(before),
                newValues: toBookingRow(after)
            });
            return after;
        });

        return { jsonBody: toBookingRow(updated) };
    })
});

app.http('bookingsDelete', {
    methods: ['DELETE'],
    route: 'bookings/{id}',
    authLevel: 'anonymous',
    handler: withErrorHandling(async (request, context) => {
        const user = requireUser(request);
        const id = request.params.id;

        await withTransaction(async (req, tx) => {
            const existingReq = new sql.Request(tx);
            const existing = await existingReq
                .input('id', sql.UniqueIdentifier, id)
                .query('SELECT * FROM Bookings WHERE BookingId = @id AND IsDeleted = 0');
            if (existing.recordset.length === 0) {
                const err = new Error('Booking not found.');
                err.statusCode = 404;
                throw err;
            }
            const before = existing.recordset[0];

            const deleteReq = new sql.Request(tx);
            await deleteReq
                .input('id', sql.UniqueIdentifier, id)
                .input('modifiedBy', sql.NVarChar(255), user.email)
                .query(`
                    UPDATE Bookings SET IsDeleted = 1, ModifiedBy = @modifiedBy, ModifiedAt = SYSUTCDATETIME()
                    WHERE BookingId = @id
                `);

            await recordAudit(tx, {
                entityType: 'Booking',
                entityId: id,
                action: 'Delete',
                changedBy: user.email,
                oldValues: toBookingRow(before)
            });
        });

        return { status: 204 };
    })
});
