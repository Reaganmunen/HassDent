const { query } = require('../config/db');

// Date args are 'YYYY-MM-DD' calendar days in Nairobi time, inclusive of both ends. Null = unbounded.
const RANGE = (col, a, b) =>
  `(${a}::date IS NULL OR ${col} >= (${a}::date)::timestamp AT TIME ZONE 'Africa/Nairobi')
   AND (${b}::date IS NULL OR ${col} < ((${b}::date) + 1)::timestamp AT TIME ZONE 'Africa/Nairobi')`;

/** Headline numbers for a period. Profit = money in (line_total) minus cost of goods, minus sale-level discounts. */
async function salesSummary({ from, to } = {}, db) {
  const p = [from || null, to || null];
  const { rows: [s] } = await query(
    `SELECT COUNT(*)::INT AS sales_count, COALESCE(SUM(total),0) AS gross_sales,
            COALESCE(SUM(discount_amount + loyalty_discount),0) AS sale_discounts, COALESCE(SUM(tax_total),0) AS vat
       FROM sales WHERE status = 'completed' AND ${RANGE('sold_at', '$1', '$2')}`, p, db);
  const { rows: [r] } = await query(
    `SELECT COALESCE(SUM(refund_amount),0) AS refunds FROM sale_returns WHERE ${RANGE('processed_at', '$1', '$2')}`, p, db);
  // Profit = what the customer paid (line_total) minus what we paid for the goods.
  // VAT is intentionally NOT subtracted — the shop is not VAT-registered.
  const { rows: [i] } = await query(
    `SELECT COALESCE(SUM(
              si.line_total * (si.quantity - si.quantity_returned) / si.quantity
              - si.unit_cost * (si.quantity - si.quantity_returned)), 0)::NUMERIC(12,2) AS item_profit
       FROM sale_items si JOIN sales sa ON sa.id = si.sale_id
      WHERE sa.status = 'completed' AND ${RANGE('sa.sold_at', '$1', '$2')}`, p, db);
  const net = (Number(s.gross_sales) * 100 - Number(r.refunds) * 100) / 100;
  const est = (Number(i.item_profit) * 100 - Number(s.sale_discounts) * 100) / 100;
  return { ...s, refunds: r.refunds, net_sales: net.toFixed(2), estimated_gross_profit: est.toFixed(2) };
}

const salesByDay = async ({ from, to } = {}, db) => (await query(
  `SELECT * FROM v_sales_daily WHERE ($1::date IS NULL OR sale_date >= $1) AND ($2::date IS NULL OR sale_date <= $2) ORDER BY sale_date DESC`,
  [from || null, to || null], db)).rows;

async function topProducts({ from, to, by = 'revenue', limit = 10 } = {}, db) {
  const order = by === 'quantity' ? 'units_sold' : 'revenue';
  const { rows } = await query(
    `SELECT p.id AS product_id, p.name, SUM(si.quantity - si.quantity_returned)::INT AS units_sold,
            SUM(si.line_total * (si.quantity - si.quantity_returned) / si.quantity)::NUMERIC(12,2) AS revenue
       FROM sale_items si JOIN sales sa ON sa.id = si.sale_id AND sa.status = 'completed' JOIN products p ON p.id = si.product_id
      WHERE ${RANGE('sa.sold_at', '$1', '$2')} GROUP BY p.id ORDER BY ${order} DESC LIMIT $3`, [from || null, to || null, limit], db);
  return rows;
}

const paymentBreakdown = async ({ from, to } = {}, db) => (await query(
  `SELECT p.method, SUM(p.amount)::NUMERIC(12,2) AS amount, COUNT(*)::INT AS payments
     FROM payments p JOIN sales sa ON sa.id = p.sale_id
    WHERE p.status = 'completed' AND sa.status = 'completed' AND ${RANGE('p.paid_at', '$1', '$2')}
    GROUP BY p.method ORDER BY amount DESC`, [from || null, to || null], db)).rows;

const topCustomers = async ({ limit = 10 } = {}, db) => (await query(
  `SELECT id, customer_code, full_name, phone, total_spent, purchase_count, visit_count, last_purchase_at
     FROM customers WHERE is_active AND purchase_count > 0 ORDER BY total_spent DESC LIMIT $1`, [limit], db)).rows;

/** Estimated gross profit minus expenses for the period. */
async function profitAndLoss({ from, to } = {}, db) {
  const s = await salesSummary({ from, to }, db);
  const { rows: [e] } = await query(
    `SELECT COALESCE(SUM(amount),0) AS expenses FROM expenses
      WHERE ($1::date IS NULL OR expense_date >= $1) AND ($2::date IS NULL OR expense_date <= $2)`, [from || null, to || null], db);
  const net = (Number(s.estimated_gross_profit) * 100 - Number(e.expenses) * 100) / 100;
  return { from, to, net_sales: s.net_sales, estimated_gross_profit: s.estimated_gross_profit, expenses: e.expenses, estimated_net_profit: net.toFixed(2) };
}

/** Single call for the dashboard landing page. */
async function dashboard(db) {
  const { rows: [r] } = await query(
    `WITH today AS (SELECT (date_trunc('day', NOW() AT TIME ZONE 'Africa/Nairobi')) AT TIME ZONE 'Africa/Nairobi' AS start)
     SELECT
       (SELECT COALESCE(SUM(total),0) FROM sales, today WHERE status = 'completed' AND sold_at >= today.start) AS today_sales,
       (SELECT COUNT(*)::INT FROM sales, today WHERE status = 'completed' AND sold_at >= today.start) AS today_count,
       (SELECT COUNT(*)::INT FROM v_low_stock) AS low_stock_count,
       (SELECT COUNT(*)::INT FROM v_expiring_batches) AS expiring_batches,
       (SELECT COALESCE(SUM(total - amount_paid),0) FROM sales WHERE status = 'completed' AND amount_paid < total) AS unpaid_total,
       (SELECT COUNT(*)::INT FROM customers WHERE is_active) AS customers,
       (SELECT COALESCE(SUM(stock_value),0) FROM v_stock_valuation) AS stock_value`, [], db);
  return r;
}

module.exports = { salesSummary, salesByDay, topProducts, paymentBreakdown, topCustomers, profitAndLoss, dashboard };