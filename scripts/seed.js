// Seeds one login per role so you can sign in and build/test the frontend.
//
//   npm run db:seed
//
// Safe to run repeatedly: users are matched by email. Existing ones get their
// password, name, role and active flag reset; missing ones are created.
// Requires db/schema.sql to have been loaded already (it creates the roles).
//
// Override the admin login without editing this file:
//   SEED_ADMIN_EMAIL=me@hassdent.co.ke SEED_ADMIN_PASSWORD='SomethingStrong1' npm run db:seed
//
// DEVELOPMENT ONLY: these passwords are known. Refuses to run when NODE_ENV=production
// (set SEED_ALLOW_PRODUCTION=1 to force it, then change the passwords immediately).

const { pool } = require('../src/config/db');
const auth = require('../src/services/auth.service');

const USERS = [
  {
    role: 'admin',
    name: 'Admin User',
    email: process.env.SEED_ADMIN_EMAIL || 'admin@hassdent.co.ke',
    password: process.env.SEED_ADMIN_PASSWORD || 'Admin@12345',
    phone: '0700000001',
  },
  { role: 'manager',      name: 'Mary Manager',  email: 'manager@hassdent.co.ke', password: 'Manager@12345', phone: '0700000002' },
  { role: 'cashier',      name: 'Carl Cashier',  email: 'cashier@hassdent.co.ke', password: 'Cashier@12345', phone: '0700000003' },
  { role: 'stock_keeper', name: 'Sam Stockkeeper', email: 'stock@hassdent.co.ke',  password: 'Stock@12345',   phone: '0700000004' },
];

(async () => {
  if (process.env.NODE_ENV === 'production' && process.env.SEED_ALLOW_PRODUCTION !== '1') {
    throw new Error('Refusing to seed known passwords in production (set SEED_ALLOW_PRODUCTION=1 to override).');
  }

  const { rows: roles } = await pool.query('SELECT id, name FROM roles');
  if (!roles.length) throw new Error('No roles found. Load db/schema.sql first (npm run db:reset).');
  const roleId = Object.fromEntries(roles.map((r) => [r.name, r.id]));

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const u of USERS) {
      if (!roleId[u.role]) throw new Error(`Role "${u.role}" does not exist in the database.`);
      auth.validatePasswordStrength(u.password);
      const hash = await auth.hashPassword(u.password);

      const { rows: [existing] } = await client.query('SELECT id FROM users WHERE LOWER(email) = LOWER($1)', [u.email]);
      if (existing) {
        await client.query(
          `UPDATE users SET name=$1, phone=$2, password_hash=$3, role_id=$4, is_active=TRUE, updated_at=NOW() WHERE id=$5`,
          [u.name, u.phone, hash, roleId[u.role], existing.id]);
      } else {
        await client.query(
          `INSERT INTO users (name, email, phone, password_hash, role_id) VALUES ($1,$2,$3,$4,$5)`,
          [u.name, u.email, u.phone, hash, roleId[u.role]]);
      }
      u.status = existing ? 'updated' : 'created';
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }

  console.log('\nSeeded users:\n');
  console.table(USERS.map((u) => ({ role: u.role, email: u.email, password: u.password, status: u.status })));
  console.log('Sign in at http://localhost:%s/login.html\n', process.env.PORT || 4000);
  await pool.end();
})().catch(async (e) => { console.error('Seed failed:', e.message); try { await pool.end(); } catch (_) {} process.exit(1); });