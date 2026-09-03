// Applies every migrations/*.sql file in filename order, exactly once.
// Safe to re-run: applied filenames are tracked in the _migrations table.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { pool } = require('../server/db');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');

async function main() {
  const client = await pool.connect();
  try {
    await client.query(`
      create table if not exists _migrations (
        filename   text primary key,
        applied_at timestamptz not null default now()
      )
    `);

    const { rows } = await client.query('select filename from _migrations');
    const applied = new Set(rows.map(r => r.filename));

    const files = fs.readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql')).sort();
    const pending = files.filter(f => !applied.has(f));

    if (pending.length === 0) {
      console.log(`Up to date (${files.length} migration(s) already applied).`);
      return;
    }

    for (const filename of pending) {
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, filename), 'utf8');
      // Each migration is one transaction, so a failure part-way leaves nothing behind.
      await client.query('begin');
      try {
        await client.query(sql);
        await client.query('insert into _migrations (filename) values ($1)', [filename]);
        await client.query('commit');
        console.log(`Applied ${filename}`);
      } catch (err) {
        await client.query('rollback');
        throw new Error(`Migration ${filename} failed: ${err.message}`);
      }
    }
    console.log(`Done, ${pending.length} migration(s) applied.`);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(err => {
  console.error(err.message);
  process.exit(1);
});
