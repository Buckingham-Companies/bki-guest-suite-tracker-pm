const { app } = require('@azure/functions');
const { query } = require('../shared/db');
const { requireUser, requireUnitAccess } = require('../shared/auth');
const { withErrorHandling } = require('../shared/httpHandler');

// History for one booking or rate — what the frontend's "History" link on a
// booking calls. Open to any authenticated user (of THIS property) — knowing
// who booked/changed something and when isn't sensitive the way changing a
// price is, but it's still guest PII, so it's scoped by property like
// everything else (single-property Beverly didn't need this: "any
// authenticated user" and "any user of this property" were the same set).
app.http('auditHistory', {
    methods: ['GET'],
    route: 'audit/{entityType}/{entityId}',
    authLevel: 'anonymous',
    handler: withErrorHandling(async (request, context) => {
        const user = requireUser(request);
        const { entityType, entityId } = request.params;
        if (!['Booking', 'Rate'].includes(entityType)) {
            return { status: 400, jsonBody: { error: 'entityType must be Booking or Rate.' } };
        }

        const result = await query(`
            SELECT Action, ChangedBy, ChangedAt, OldValues, NewValues
            FROM AuditLog
            WHERE EntityType = @entityType AND EntityId = @entityId
            ORDER BY ChangedAt DESC
        `, { entityType, entityId });

        if (result.recordset.length === 0) {
            return { jsonBody: [] };
        }

        // AuditLog has no PropertyId column, and a cleared Rate no longer has a
        // live row to join back through Units to Properties — but every audit
        // snapshot (old or new) already carries unitId (see toBookingRow /
        // ratesSet's newValues), so read it from there instead of a table join.
        // Works uniformly whether the entity is still live or was deleted, and
        // fails closed if a snapshot is ever missing it.
        const sample = result.recordset[0];
        const snapshot = JSON.parse(sample.NewValues || sample.OldValues || '{}');
        if (!snapshot.unitId) {
            const err = new Error('You do not have access to this history.');
            err.statusCode = 403;
            throw err;
        }
        await requireUnitAccess(user, snapshot.unitId);

        return {
            jsonBody: result.recordset.map(r => ({
                action: r.Action,
                changedBy: r.ChangedBy,
                changedAt: r.ChangedAt,
                oldValues: r.OldValues ? JSON.parse(r.OldValues) : null,
                newValues: r.NewValues ? JSON.parse(r.NewValues) : null
            }))
        };
    })
});
