const { query } = require('../config/db');
const { buildInsert } = require('../utils/sql');
const { notFound } = require('../utils/errors');

const FIELDS = ['category_id', 'amount', 'expense_date', 'method', 'reference', 'description', 'receipt_url', 'recorded_by'];

async function create(data, db) {
  const q = buildInsert('expenses', data, FIELDS);
  const { rows: [row] } = await query(q.text, q.values, db);
  return row;
}

async function list({ from, to, category_id, limit = 50, offset = 0 } = {}, db) {
  const where = []; const params = [];
  if (from) { params.push(from); where.push(`e.expense_date >= $${params.length}`); }
  if (to) { params.push(to); where.push(`e.expense_date <= $${params.length}`); }
  if (category_id) { params.push(category_id); where.push(`e.category_id = $${params.length}`); }
  params.push(limit, offset);
  const { rows } = await query(
    `SELECT e.*, c.name AS category FROM expenses e JOIN expense_categories c ON c.id = e.category_id
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY e.expense_date DESC, e.id DESC LIMIT $${params.length - 1} OFFSET $${params.length}`, params, db);
  return rows;
}

async function remove(id, db) {
  const { rowCount } = await query('DELETE FROM expenses WHERE id = $1', [id], db);
  if (!rowCount) throw notFound('Expense');
  return true;
}

const summaryByCategory = async ({ from, to } = {}, db) => (await query(
  `SELECT c.name AS category, SUM(e.amount)::NUMERIC(12,2) AS total, COUNT(*)::INT AS entries
     FROM expenses e JOIN expense_categories c ON c.id = e.category_id
    WHERE ($1::date IS NULL OR e.expense_date >= $1) AND ($2::date IS NULL OR e.expense_date <= $2)
    GROUP BY c.name ORDER BY total DESC`, [from || null, to || null], db)).rows;

module.exports = { create, list, remove, summaryByCategory };
