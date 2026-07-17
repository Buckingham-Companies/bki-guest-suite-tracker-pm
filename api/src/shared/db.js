const sql = require('mssql');

let poolPromise = null;

// Reuses one connection pool across function invocations within the same
// Functions host instance, rather than reconnecting per request.
function getPool() {
    if (!poolPromise) {
        const connectionString = process.env.SQL_CONNECTION_STRING;
        if (!connectionString) {
            throw new Error('SQL_CONNECTION_STRING app setting is not configured.');
        }
        poolPromise = sql.connect(connectionString);
    }
    return poolPromise;
}

// Runs `work(request, transaction)` inside a SQL transaction and commits/rolls
// back automatically. Every multi-step write (booking/rate + its audit row)
// should go through this so the two writes can never get out of sync.
async function withTransaction(work) {
    const pool = await getPool();
    const transaction = new sql.Transaction(pool);
    await transaction.begin();
    try {
        const request = new sql.Request(transaction);
        const result = await work(request, transaction);
        await transaction.commit();
        return result;
    } catch (err) {
        await transaction.rollback();
        throw err;
    }
}

async function query(text, params = {}) {
    const pool = await getPool();
    const request = pool.request();
    for (const [name, value] of Object.entries(params)) {
        request.input(name, value);
    }
    return request.query(text);
}

module.exports = { sql, getPool, withTransaction, query };
