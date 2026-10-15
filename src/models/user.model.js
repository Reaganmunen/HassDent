const { query } = require('../config/db');
const { buildInsert, buildUpdate } = require('../utils/sql');
const { notFound } = require('../utils/errors');

// Password hashing (bcrypt/argon2) belongs in the auth service. Models only ever
// see and store the hash.
const SAFE_COLUMNS = `u.id, u.name, u.email, u.phone, u.role_id, r.name AS role, u.is_active,
  u.last_login_at, u.created_at,
  COALESCE(array_agg(p.code ORDER BY p.code) FILTER (WHERE p.code IS NOT NULL), '{}') AS permissions`;
const JOIN = `FROM users u JOIN roles r ON r.id = u.role_id
  LEFT JOIN role_permissions rp ON rp.role_id = r.id
  LEFT JOIN permissions p ON p.id = rp.permission_id`;

async function create(data, db) {
  const q = buildInsert('users', { ...data, email: data.email && data.email.trim() },
    ['name', 'email', 'phone', 'password_hash', 'role_id']);
  const { rows: [row] } = await query(q.text, q.values, db);
  return findById(row.id, db);
}

/** For login only: includes password_hash. */
async function findByEmail(email, db) {
  const { rows: [row] } = await query(
    `SELECT ${SAFE_COLUMNS}, u.password_hash ${JOIN}
     WHERE LOWER(u.email) = LOWER($1) GROUP BY u.id, r.name`, [email && email.trim()], db);
  return row || null;
}

async function findById(id, db) {
  const { rows: [row] } = await query(`SELECT ${SAFE_COLUMNS} ${JOIN} WHERE u.id = $1 GROUP BY u.id, r.name`, [id], db);
  if (!row) throw notFound('User');
  return row;
}

async function list({ active, limit = 100, offset = 0 } = {}, db) {
  const params = [];
  let where = '';
  if (active !== undefined) { params.push(active); where = `WHERE u.is_active = $1`; }
  params.push(limit, offset);
  const { rows } = await query(
    `SELECT ${SAFE_COLUMNS} ${JOIN} ${where} GROUP BY u.id, r.name
     ORDER BY u.name LIMIT $${params.length - 1} OFFSET $${params.length}`, params, db);
  return rows;
}

async function update(id, data, db) {
  const q = buildUpdate('users', id, data, ['name', 'email', 'phone', 'role_id', 'is_active', 'password_hash']);
  if (q) {
    const { rowCount } = await query(q.text, q.values, db);
    if (!rowCount) throw notFound('User');
  }
  return findById(id, db);
}

const touchLastLogin = (id, db) => query('UPDATE users SET last_login_at = NOW() WHERE id = $1', [id], db);

// ---- roles & permissions ----
async function listRoles(db) {
  const { rows } = await query(
    `SELECT r.id, r.name, r.description,
            COALESCE(array_agg(p.code ORDER BY p.code) FILTER (WHERE p.code IS NOT NULL), '{}') AS permissions
     FROM roles r LEFT JOIN role_permissions rp ON rp.role_id = r.id
     LEFT JOIN permissions p ON p.id = rp.permission_id GROUP BY r.id ORDER BY r.id`, [], db);
  return rows;
}
const listPermissions = async (db) => (await query('SELECT * FROM permissions ORDER BY code', [], db)).rows;

// ---- refresh / password-reset tokens (store only the hash) ----
async function saveToken({ user_id, type, token_hash, expires_at }, db) {
  const { rows: [row] } = await query(
    `INSERT INTO user_tokens (user_id, type, token_hash, expires_at) VALUES ($1,$2,$3,$4) RETURNING id`,
    [user_id, type, token_hash, expires_at], db);
  return row;
}

async function findValidToken(token_hash, type, db) {
  const { rows: [row] } = await query(
    `SELECT * FROM user_tokens WHERE token_hash = $1 AND type = $2 AND used_at IS NULL AND expires_at > NOW()`,
    [token_hash, type], db);
  return row || null;
}

const markTokenUsed = (id, db) => query('UPDATE user_tokens SET used_at = NOW() WHERE id = $1', [id], db);
const revokeUserTokens = (user_id, type, db) =>
  query('UPDATE user_tokens SET used_at = NOW() WHERE user_id = $1 AND type = $2 AND used_at IS NULL', [user_id, type], db);

module.exports = { create, findByEmail, findById, list, update, touchLastLogin,
  listRoles, listPermissions, saveToken, findValidToken, markTokenUsed, revokeUserTokens };
