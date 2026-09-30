const { query } = require('../config/db');

/** Fire-and-forget friendly: call with await if you need to be sure it landed. */
async function log({ user_id = null, action, entity_type, entity_id = null, old_data = null, new_data = null, ip_address = null }, db) {
  await query(
    `INSERT INTO audit_logs (user_id, action, entity_type, entity_id, old_data, new_data, ip_address)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [user_id, action, entity_type, entity_id,
      old_data && JSON.stringify(old_data), new_data && JSON.stringify(new_data), ip_address], db);
}

async function list({ entity_type, entity_id, user_id, limit = 50, offset = 0 } = {}, db) {
  const where = []; const params = [];
  if (entity_type) { params.push(entity_type); where.push(`a.entity_type = $${params.length}`); }
  if (entity_id) { params.push(entity_id); where.push(`a.entity_id = $${params.length}`); }
  if (user_id) { params.push(user_id); where.push(`a.user_id = $${params.length}`); }
  params.push(limit, offset);
  const { rows } = await query(
    `SELECT a.*, u.name AS user_name FROM audit_logs a LEFT JOIN users u ON u.id = a.user_id
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY a.created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`, params, db);
  return rows;
}

module.exports = { log, list };
