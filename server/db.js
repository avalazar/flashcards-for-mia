const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set. Copy .env.example to .env and fill it in.');
  process.exit(1);
}

// Neon requires TLS. `sslmode=require` in the URL is not enough for node-postgres,
// which needs the ssl option set explicitly. Local Postgres in Docker has no TLS,
// so only enable it for remote hosts.
const isLocal = /@(localhost|127\.0\.0\.1)[:/]/.test(process.env.DATABASE_URL);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: isLocal ? false : { rejectUnauthorized: true },
  // Neon's free compute suspends after ~5 min idle and takes ~1s to wake.
  // Keep the pool small and let idle connections go so we don't hold it awake.
  max: 5,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 15_000,
});

pool.on('error', err => {
  // An idle client dropped (common when Neon suspends). The pool replaces it.
  console.error('Postgres idle client error:', err.message);
});

// Small helper so route modules don't each import Pool.
function query(text, params) {
  return pool.query(text, params);
}

// Runs fn inside a transaction, rolling back on any throw.
async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (err) {
    try { await client.query('rollback'); } catch { /* connection already gone */ }
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { pool, query, withTransaction };
