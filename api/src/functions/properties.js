const { app } = require('@azure/functions');
const { query } = require('../shared/db');
const { requireUser } = require('../shared/auth');
const { withErrorHandling } = require('../shared/httpHandler');

// Properties + their units, nested, filtered down to the properties this user
// is actually assigned to (via user.yardiNumbers — see shared/auth.js). The
// frontend builds its property selector and unit dropdowns entirely from this
// response, so a Property Manager only ever sees their own site, a Regional
// or Multi-Site Manager sees every site in their YardiNumber list, and adding
// a new property later is a row in Properties/Units (see
// database/seed_portrait_midtown.sql for the pattern) — never a frontend
// change or an Okta group-rule edit.
app.http('propertiesList', {
    methods: ['GET'],
    route: 'properties',
    authLevel: 'anonymous',
    handler: withErrorHandling(async (request, context) => {
        const user = requireUser(request);

        if (!user.isGlobalAdmin && user.yardiNumbers.length === 0) {
            return { jsonBody: [] };
        }

        // Global admins (see getRoles.js) see every property regardless of
        // their own YardiNumber claim.
        const result = user.isGlobalAdmin
            ? await query(`
                SELECT p.PropertyId, p.Name, p.ShortCode, u.UnitId, u.UnitLabel
                FROM Properties p
                JOIN Units u ON u.PropertyId = p.PropertyId AND u.IsActive = 1
                ORDER BY p.Name, u.UnitLabel
            `)
            : await query(`
                SELECT p.PropertyId, p.Name, p.ShortCode, u.UnitId, u.UnitLabel
                FROM Properties p
                JOIN Units u ON u.PropertyId = p.PropertyId AND u.IsActive = 1
                WHERE p.YardiNumber IN (${user.yardiNumbers.map((_, i) => `@yn${i}`).join(', ')})
                ORDER BY p.Name, u.UnitLabel
            `, Object.fromEntries(user.yardiNumbers.map((yn, i) => [`yn${i}`, yn])));

        const byProperty = new Map();
        for (const row of result.recordset) {
            if (!byProperty.has(row.PropertyId)) {
                byProperty.set(row.PropertyId, {
                    propertyId: row.PropertyId,
                    name: row.Name,
                    shortCode: row.ShortCode,
                    units: []
                });
            }
            byProperty.get(row.PropertyId).units.push({ unitId: row.UnitId, unitLabel: row.UnitLabel });
        }

        return { jsonBody: Array.from(byProperty.values()) };
    })
});
