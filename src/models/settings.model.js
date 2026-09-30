const { query } = require('../config/db');
const { buildUpdate } = require('../utils/sql');

const FIELDS = ['shop_name', 'address', 'phone', 'email', 'kra_pin', 'currency', 'receipt_footer',
  'loyalty_points_per_kes', 'loyalty_kes_per_point', 'frequent_customer_min_visits', 'expiry_alert_days'];

async function get(db) {
  const { rows: [row] } = await query('SELECT * FROM shop_settings WHERE id = 1', [], db);
  return row;
}

async function update(data, db) {
  const q = buildUpdate('shop_settings', 1, data, FIELDS);
  if (!q) return get(db);
  const { rows: [row] } = await query(q.text, q.values, db);
  return row;
}

module.exports = { get, update };
