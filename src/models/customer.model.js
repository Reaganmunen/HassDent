const { query, inTx } = require('../config/db');
const { buildInsert, buildUpdate } = require('../utils/sql');
const { AppError, notFound } = require('../utils/errors');
const { normalisePhone } = require('../utils/phone');

const FIELDS = ['full_name', 'customer_type', 'organization_name', 'phone', 'alt_phone', 'email', 'address',
  'customer_group_id', 'credit_limit', 'is_active', 'created_by'];

// visit_count, total_spent, loyalty_points etc. are maintained by database triggers,
// so they are deliberately NOT in FIELDS.

function prepare(data) {
  const d = { ...data };
  if ('phone' in d) d.phone = normalisePhone(d.phone);
  if ('alt_phone' in d) d.alt_phone = normalisePhone(d.alt_phone);
  if (typeof d.email === 'string') d.email = d.email.trim() || null;
  return d;
}

async function create(data, db) {
  return inTx(db, async (c) => {
    const d = prepare(data);
    if (!d.full_name || !String(d.full_name).trim()) throw new AppError('Customer name is required', 400);
    if (d.customer_group_id === undefined) {
      const { rows: [g] } = await query('SELECT id FROM customer_groups WHERE is_default LIMIT 1', [], c);
      if (g) d.customer_group_id = g.id;
    }
    const q = buildInsert('customers', d, FIELDS);
    const { rows: [row] } = await query(q.text, q.values, c);
    return getById(row.id, c);
  });
}

async function update(id, data, db) {
  const q = buildUpdate('customers', id, prepare(data), FIELDS.filter((f) => f !== 'created_by'));
  if (q) {
    const { rowCount } = await query(q.text, q.values, db);
    if (!rowCount) throw notFound('Customer');
  }
  return getById(id, db);
}

/** Full customer card: summary numbers, group, notes still open. */
async function getById(id, db) {
  const { rows: [c] } = await query(
    `SELECT s.*, g.name AS group_name, g.discount_percent AS group_discount
       FROM v_customer_summary s LEFT JOIN customer_groups g ON g.id = s.customer_group_id WHERE s.id = $1`, [id], db);
  if (!c) throw notFound('Customer');
  const { rows: notes } = await query(
    `SELECT * FROM customer_notes WHERE customer_id = $1 AND NOT is_resolved ORDER BY created_at DESC`, [id], db);
  return { ...c, notes };
}

async function findByPhone(phone, db) {
  const { rows: [c] } = await query('SELECT id FROM customers WHERE phone = $1 AND is_active', [normalisePhone(phone)], db);
  return c ? getById(c.id, db) : null;
}

/**
 * The search box at the counter. Type part of a phone number (0712..., 712..., 254712...)
 * or part of a name. Frequent customers come first.
 */
async function quickSearch(term, { limit = 10 } = {}, db) {
  const t = String(term || '').trim();
  if (!t) return [];
  const digits = t.replace(/\D/g, '');
  const looksLikePhone = digits.length >= 3 && /^[\d\s+\-()]+$/.test(t);
  let rows;
  if (looksLikePhone) {
    const core = digits.replace(/^(254|0)/, '');
    ({ rows } = await query(
      `SELECT * FROM v_customer_summary WHERE phone LIKE '%' || $1 || '%' OR alt_phone LIKE '%' || $1 || '%'
       ORDER BY visit_count DESC, full_name LIMIT $2`, [core, limit], db));
  } else {
    ({ rows } = await query(
      `SELECT * FROM v_customer_summary WHERE full_name ILIKE '%' || $1 || '%' OR organization_name ILIKE '%' || $1 || '%'
       ORDER BY visit_count DESC, full_name LIMIT $2`, [t, limit], db));
  }
  return rows;
}

async function list({ search, frequent, group_id, limit = 50, offset = 0 } = {}, db) {
  const where = []; const params = [];
  if (search) {
    params.push(`%${search}%`);
    where.push(`(full_name ILIKE $${params.length} OR phone ILIKE $${params.length} OR organization_name ILIKE $${params.length})`);
  }
  if (frequent) where.push('is_frequent');
  if (group_id) { params.push(group_id); where.push(`customer_group_id = $${params.length}`); }
  params.push(limit, offset);
  const { rows } = await query(
    `SELECT *, COUNT(*) OVER()::INT AS total_count FROM v_customer_summary
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY full_name LIMIT $${params.length - 1} OFFSET $${params.length}`, params, db);
  return { items: rows.map(({ total_count, ...r }) => r), total: rows[0] ? rows[0].total_count : 0 };
}

const deactivate = (id, db) => update(id, { is_active: false }, db);

// ---------------------------------------------------------------- notes
async function addNote({ customer_id, note, show_on_checkin = false, created_by }, db) {
  const { rows: [row] } = await query(
    `INSERT INTO customer_notes (customer_id, note, show_on_checkin, created_by) VALUES ($1,$2,$3,$4) RETURNING *`,
    [customer_id, note, show_on_checkin, created_by || null], db);
  return row;
}
const listNotes = async (customer_id, db) => (await query(
  'SELECT * FROM customer_notes WHERE customer_id = $1 ORDER BY is_resolved, created_at DESC', [customer_id], db)).rows;
const resolveNote = (id, db) => query('UPDATE customer_notes SET is_resolved = TRUE WHERE id = $1', [id], db);
const deleteNote = (id, db) => query('DELETE FROM customer_notes WHERE id = $1', [id], db);

// ---------------------------------------------------------------- visits / check-in
const topProducts = async (customer_id, limit = 5, db) => (await query(
  `SELECT product_id, name, qty_bought, last_bought_at FROM v_customer_top_products
    WHERE customer_id = $1 ORDER BY qty_bought DESC LIMIT $2`, [customer_id, limit], db)).rows;

const purchases = async (customer_id, { limit = 20, offset = 0 } = {}, db) => (await query(
  `SELECT id, sale_number, sold_at, total, amount_paid, payment_status, status FROM sales
    WHERE customer_id = $1 AND status <> 'held' ORDER BY sold_at DESC LIMIT $2 OFFSET $3`, [customer_id, limit, offset], db)).rows;

const visits = async (customer_id, limit = 20, db) => (await query(
  `SELECT v.*, u.name AS served_by_name FROM customer_visits v LEFT JOIN users u ON u.id = v.served_by
    WHERE v.customer_id = $1 ORDER BY v.visited_at DESC LIMIT $2`, [customer_id, limit], db)).rows;

/**
 * "Customer just walked in": log the visit and return everything the screen should prompt:
 * their card, notes flagged show_on_checkin, what they usually buy, recent purchases and any balance owed.
 */
async function checkIn({ customer_id, purpose, served_by, notes }, db) {
  return inTx(db, async (c) => {
    await query(`INSERT INTO customer_visits (customer_id, purpose, served_by, notes) VALUES ($1,$2,$3,$4)`,
      [customer_id, purpose || null, served_by || null, notes || null], c);
    const customer = await getById(customer_id, c);
    return {
      customer,
      alerts: customer.notes.filter((n) => n.show_on_checkin),
      usually_buys: await topProducts(customer_id, 5, c),
      recent_purchases: await purchases(customer_id, { limit: 3 }, c),
      outstanding_balance: customer.outstanding_balance,
    };
  });
}

// ---------------------------------------------------------------- loyalty
/** Low-level: writes a ledger row; a trigger keeps customers.loyalty_points and balance_after in sync. */
async function addLoyalty(db, { customer_id, sale_id = null, type, points, note = null, created_by = null }) {
  const { rows: [row] } = await query(
    `INSERT INTO loyalty_transactions (customer_id, sale_id, type, points, note, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [customer_id, sale_id, type, points, note, created_by], db);
  return row;
}
const loyaltyAdjust = ({ customer_id, points, note, created_by }, db) =>
  addLoyalty(db, { customer_id, type: 'adjust', points, note, created_by });
const loyaltyHistory = async (customer_id, limit = 50, db) => (await query(
  'SELECT * FROM loyalty_transactions WHERE customer_id = $1 ORDER BY id DESC LIMIT $2', [customer_id, limit], db)).rows;

module.exports = { create, update, getById, findByPhone, quickSearch, list, deactivate,
  addNote, listNotes, resolveNote, deleteNote, topProducts, purchases, visits, checkIn,
  addLoyalty, loyaltyAdjust, loyaltyHistory };
