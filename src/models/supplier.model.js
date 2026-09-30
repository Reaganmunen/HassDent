const { makeCrud } = require('./crud');
const { query } = require('../config/db');

const crud = makeCrud({
  table: 'suppliers',
  fields: ['name', 'contact_person', 'phone', 'email', 'address', 'kra_pin', 'payment_terms', 'notes', 'is_active'],
  searchCols: ['name', 'contact_person', 'phone'],
  orderBy: 'name',
  hasActive: true,
});

/** What we still owe a supplier: goods received - payments made - return credits. */
async function getBalance(supplier_id, db) {
  const { rows: [r] } = await query(
    `SELECT (SELECT COALESCE(SUM(total_cost), 0) FROM goods_received_notes WHERE supplier_id = $1) AS purchased,
            (SELECT COALESCE(SUM(amount), 0) FROM supplier_payments WHERE supplier_id = $1) AS paid,
            (SELECT COALESCE(SUM(credit_amount), 0) FROM supplier_returns WHERE supplier_id = $1) AS credits`, [supplier_id], db);
  const owed = (Number(r.purchased) * 100 - Number(r.paid) * 100 - Number(r.credits) * 100) / 100;
  return { supplier_id, purchased: r.purchased, paid: r.paid, credits: r.credits, owed: owed.toFixed(2) };
}

module.exports = { ...crud, getBalance };
