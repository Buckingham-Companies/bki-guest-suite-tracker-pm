const { app } = require('@azure/functions');
const { query } = require('../shared/db');
const { requireUser } = require('../shared/auth');
const { withErrorHandling } = require('../shared/httpHandler');

// Properties + their units, nested. The frontend builds its property selector
// and unit dropdowns from this instead of hardcoding unit numbers — adding
// Foundry (or any future property) later is a row in Properties/Units
// (see database/seed_beverly.sql for the pattern), never a frontend change.
app.http('propertiesList', {
    methods: ['GET'],
    route: 'properties',
    authLevel: 'anonymous',
    handler: withErrorHandling(async (request, context) => {
        requireUser(request);

        const result = await query(`
            SELECT p.PropertyId, p.Name, p.ShortCode, u.UnitId, u.UnitLabel
            FROM Properties p
            JOIN Units u ON u.PropertyId = p.PropertyId AND u.IsActive = 1
            ORDER BY p.Name, u.UnitLabel
        `);

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
