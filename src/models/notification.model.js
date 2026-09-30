const { query } = require('../config/db');

async function create({ user_id = null, type, title, message, entity_type, entity_id }, db) {
  const { rows: [row] } = await query(
    `INSERT INTO notifications (user_id, type, title, message, entity_type, entity_id)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`, [user_id, type, title, message, entity_type, entity_id], db);
  return row;
}

/** Notifications for a user, plus the shop-wide ones (user_id IS NULL). */
async function listForUser(user_id, { unread_only = false, limit = 50 } = {}, db) {
  const { rows } = await query(
    `SELECT * FROM notifications WHERE (user_id = $1 OR user_id IS NULL) ${unread_only ? 'AND NOT is_read' : ''}
     ORDER BY created_at DESC LIMIT $2`, [user_id, limit], db);
  return rows;
}

const markRead = (id, db) => query('UPDATE notifications SET is_read = TRUE WHERE id = $1', [id], db);
const markAllRead = (user_id, db) =>
  query('UPDATE notifications SET is_read = TRUE WHERE (user_id = $1 OR user_id IS NULL) AND NOT is_read', [user_id], db);

/**
 * Create low-stock and expiry alerts, skipping any that already have an unread
 * notification. Safe to run on a schedule (e.g. every hour or at shop opening).
 */
async function syncStockAlerts(db) {
  const low = await query(
    `INSERT INTO notifications (type, title, message, entity_type, entity_id)
     SELECT 'low_stock', 'Low stock: ' || ls.name, ls.on_hand || ' left (reorder level ' || ls.reorder_level || ')', 'product', ls.product_id
     FROM v_low_stock ls
     WHERE NOT EXISTS (SELECT 1 FROM notifications n WHERE n.type = 'low_stock' AND n.entity_type = 'product'
                       AND n.entity_id = ls.product_id AND NOT n.is_read)`, [], db);
  const exp = await query(
    `INSERT INTO notifications (type, title, message, entity_type, entity_id)
     SELECT 'expiry',
            CASE WHEN e.is_expired THEN 'Expired: ' ELSE 'Expiring soon: ' END || e.name,
            'Batch ' || e.batch_number || ', ' || e.on_hand || ' units, expiry ' || e.expiry_date, 'batch', e.batch_id
     FROM v_expiring_batches e
     WHERE NOT EXISTS (SELECT 1 FROM notifications n WHERE n.type = 'expiry' AND n.entity_type = 'batch'
                       AND n.entity_id = e.batch_id AND NOT n.is_read)`, [], db);
  return { low_stock_created: low.rowCount, expiry_created: exp.rowCount };
}

module.exports = { create, listForUser, markRead, markAllRead, syncStockAlerts };
