const audit = require('../models/audit.model');

const pick = (obj, keys) => Object.fromEntries(keys.filter((k) => obj && k in obj).map((k) => [k, obj[k]]));

/**
 * Best-effort audit trail: never lets a logging problem break the request.
 * `before` / `after` are trimmed to the keys the caller actually changed.
 */
async function record(req, action, entity_type, entity_id, before = null, after = null) {
  try {
    await audit.log({
      user_id: req.user ? req.user.id : null, action, entity_type, entity_id,
      old_data: before, new_data: after, ip_address: req.ip || null,
    });
  } catch (err) {
    console.error('[audit] failed to write log:', err.message);
  }
}

module.exports = { record, pick };
