require('dotenv').config();
const { Pool, types } = require('pg');
const { mapPgError } = require('../utils/errors');

// BIGINT (BIGSERIAL ids, COUNT(*)) -> JS number. NUMERIC stays a string on purpose
// so money never passes through floating point unless we choose it to.
types.setTypeParser(20, (v) => parseInt(v, 10));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: Number(process.env.DB_POOL_MAX || 10),
  // Everything the shop does happens in Nairobi time. Set via the startup
  // packet so the session timezone is active for the very first query on
  // every pooled connection. Doing this in a 'connect' listener fires a
  // fire-and-forget client.query() that can race with the next query on the
  // same client (pg@9 deprecation warning, and a real correctness bug).
  options: '-c timezone=Africa/Nairobi',
});

/**
 * Run a query. `db` is optional: pass a transaction client to run inside that
 * transaction, or omit it to use the pool. Postgres errors are translated into AppErrors.
 */
async function query(text, params = [], db = pool) {
  try {
    return await db.query(text, params);
  } catch (err) {
    throw mapPgError(err);
  }
}

/** Run `fn(client)` inside BEGIN/COMMIT, rolling back if it throws. */
async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* connection already broken */ }
    throw mapPgError(err);
  } finally {
    client.release();
  }
}

/**
 * Convention used by multi-step model functions: if the caller already has a
 * transaction (`db` is a client) join it, otherwise open our own.
 */
function inTx(db, fn) {
  return db ? fn(db) : withTransaction(fn);
}

module.exports = { pool, query, withTransaction, inTx };