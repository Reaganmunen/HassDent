// WARNING: drops everything in the "public" schema and reloads db/schema.sql.
// Only use on a development / test database.
const fs = require('fs');
const path = require('path');
const { pool } = require('../src/config/db');

(async () => {
  const sql = fs.readFileSync(path.join(__dirname, '../db/schema.sql'), 'utf8');
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await pool.query(sql);
  console.log('Database reset and schema loaded.');
  await pool.end();
})().catch((e) => { console.error(e); process.exit(1); });
