const { query, inTx } = require('../config/db');
const { AppError, notFound } = require('../utils/errors');
const { toCents, formatCents } = require('../utils/money');

async function open({ opened_by, opening_float = 0 }, db) {
  const { rows: [existing] } = await query(`SELECT id FROM cash_register_sessions WHERE opened_by = $1 AND status = 'open'`, [opened_by], db);
  if (existing) throw new AppError('You already have an open register session', 409, 'ALREADY_OPEN', { session_id: existing.id });
  const { rows: [row] } = await query(
    `INSERT INTO cash_register_sessions (opened_by, opening_float) VALUES ($1,$2) RETURNING *`, [opened_by, opening_float], db);
  return row;
}

const getOpen = async (user_id, db) => (await query(
  `SELECT * FROM cash_register_sessions WHERE opened_by = $1 AND status = 'open'`, [user_id], db)).rows[0] || null;

/** Money movements for a session: takings by method, plus cash refunds since it opened. */
async function summary(id, db) {
  const { rows: [s] } = await query('SELECT * FROM cash_register_sessions WHERE id = $1', [id], db);
  if (!s) throw notFound('Register session');
  const { rows: byMethod } = await query(
    `SELECT p.method, COALESCE(SUM(p.amount), 0) AS amount, COUNT(*)::INT AS payments
       FROM payments p JOIN sales sa ON sa.id = p.sale_id
      WHERE sa.register_session_id = $1 AND p.status = 'completed' AND sa.status = 'completed' GROUP BY p.method`, [id], db);
  const { rows: [ref] } = await query(
    `SELECT COALESCE(SUM(refund_amount), 0) AS cash_refunds FROM sale_returns
      WHERE refund_method = 'cash' AND processed_at >= $1 AND processed_at <= COALESCE($2, NOW())`, [s.opened_at, s.closed_at], db);
  const cashIn = toCents((byMethod.find((m) => m.method === 'cash') || { amount: 0 }).amount);
  const expected = toCents(s.opening_float) + cashIn - toCents(ref.cash_refunds);
  return { session: s, by_method: byMethod, cash_refunds: ref.cash_refunds, expected_cash: formatCents(expected) };
}

/** Close the till: expected cash = opening float + cash sales - cash refunds. Variance = counted - expected. */
async function close({ id, closed_by, counted_cash, notes }, db) {
  return inTx(db, async (c) => {
    const { rows: [s] } = await query('SELECT * FROM cash_register_sessions WHERE id = $1 FOR UPDATE', [id], c);
    if (!s) throw notFound('Register session');
    if (s.status !== 'open') throw new AppError('Session is already closed', 409, 'ALREADY_CLOSED');
    const { expected_cash } = await summary(id, c);
    const { rows: [row] } = await query(
      `UPDATE cash_register_sessions SET status = 'closed', closed_by = $2, closed_at = NOW(),
              expected_cash = $3, counted_cash = $4, notes = $5 WHERE id = $1 RETURNING *`,
      [id, closed_by, expected_cash, counted_cash, notes || null], c);
    return row;
  });
}

const list = async ({ limit = 30 } = {}, db) => (await query(
  `SELECT r.*, u.name AS opened_by_name FROM cash_register_sessions r JOIN users u ON u.id = r.opened_by ORDER BY r.id DESC LIMIT $1`, [limit], db)).rows;

module.exports = { open, getOpen, summary, close, list };
