const { app } = require('@azure/functions');
const { query } = require('../shared/db');
const { requireUser } = require('../shared/auth');
const { withErrorHandling } = require('../shared/httpHandler');

// History for one booking or rate — what the frontend's "History" link on a
// booking calls. Open to any authenticated user: knowing who booked/changed
// something and when isn't sensitive the way changing a price is.
app.http('auditHistory', {
    methods: ['GET'],
    route: 'audit/{entityType}/{entityId}',
    authLevel: 'anonymous',
    handler: withErrorHandling(async (request, context) => {
        requireUser(request);
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
