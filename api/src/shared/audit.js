const { sql } = require('./db');

// Writes one AuditLog row. Callers pass the same `transaction` they used for
// the actual write, inside the same withTransaction() call — see db.js — so
// a booking/rate change and its audit entry always land together or not at all.
// A fresh Request is created here (rather than reusing the caller's) so its
// parameter names never collide with whatever the caller already bound.
async function recordAudit(transaction, { entityType, entityId, action, changedBy, oldValues, newValues }) {
    const request = new sql.Request(transaction);
    await request
        .input('entityType', entityType)
        .input('entityId', String(entityId))
        .input('action', action)
        .input('changedBy', changedBy)
        .input('oldValues', oldValues ? JSON.stringify(oldValues) : null)
        .input('newValues', newValues ? JSON.stringify(newValues) : null)
        .query(`
            INSERT INTO AuditLog (EntityType, EntityId, Action, ChangedBy, OldValues, NewValues)
            VALUES (@entityType, @entityId, @action, @changedBy, @oldValues, @newValues)
        `);
}

module.exports = { recordAudit };
