const { AppError } = require('./errors');

// Table and column names passed to these helpers always come from whitelists
// in the models (never from request bodies), so interpolating them is safe.
// All VALUES are parameterised.

function pick(data, allowed) {
  return Object.keys(data || {}).filter((k) => allowed.includes(k) && data[k] !== undefined);
}

function buildInsert(table, data, allowed) {
  const keys = pick(data, allowed);
  if (!keys.length) throw new AppError('No valid fields provided', 400, 'NO_FIELDS');
  return {
    text: `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`,
    values: keys.map((k) => data[k]),
  };
}

function buildUpdate(table, id, data, allowed) {
  const keys = pick(data, allowed);
  if (!keys.length) return null; // nothing to change
  return {
    text: `UPDATE ${table} SET ${keys.map((k, i) => `${k} = $${i + 1}`).join(', ')} WHERE id = $${keys.length + 1} RETURNING *`,
    values: [...keys.map((k) => data[k]), id],
  };
}

function paginate({ page = 1, limit = 20 } = {}) {
  const l = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 200);
  const p = Math.max(parseInt(page, 10) || 1, 1);
  return { limit: l, offset: (p - 1) * l };
}

module.exports = { buildInsert, buildUpdate, paginate };
