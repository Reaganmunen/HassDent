const { query, withTransaction } = require('../config/db');
const { buildInsert, buildUpdate } = require('../utils/sql');
const { notFound } = require('../utils/errors');

/**
 * Small factory for the simple lookup tables (categories, brands, units, ...).
 * Every function takes an optional trailing `db` (a transaction client).
 */
function makeCrud({ table, fields, searchCols = [], orderBy = 'id', hasActive = false, hasDefault = false }) {
  const api = {
    async list({ search, active, limit = 200, offset = 0 } = {}, db) {
      const where = [];
      const params = [];
      if (search && searchCols.length) {
        params.push(`%${search}%`);
        where.push('(' + searchCols.map((c) => `${c} ILIKE $${params.length}`).join(' OR ') + ')');
      }
      if (hasActive && active !== undefined) {
        params.push(active);
        where.push(`is_active = $${params.length}`);
      }
      params.push(limit, offset);
      const { rows } = await query(
        `SELECT * FROM ${table} ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
         ORDER BY ${orderBy} LIMIT $${params.length - 1} OFFSET $${params.length}`, params, db);
      return rows;
    },

    async getById(id, db) {
      const { rows: [row] } = await query(`SELECT * FROM ${table} WHERE id = $1`, [id], db);
      if (!row) throw notFound(table);
      return row;
    },

    async create(data, db) {
      const q = buildInsert(table, data, fields);
      const { rows: [row] } = await query(q.text, q.values, db);
      return row;
    },

    async update(id, data, db) {
      const q = buildUpdate(table, id, data, fields);
      if (!q) return api.getById(id, db);
      const { rows: [row] } = await query(q.text, q.values, db);
      if (!row) throw notFound(table);
      return row;
    },

    async remove(id, db) {
      const { rowCount } = await query(`DELETE FROM ${table} WHERE id = $1`, [id], db);
      if (!rowCount) throw notFound(table);
      return true;
    },
  };

  if (hasDefault) {
    // Only one row may be the default (enforced by a partial unique index),
    // so clear the old one and set the new one atomically.
    api.setDefault = (id) => withTransaction(async (c) => {
      await query(`UPDATE ${table} SET is_default = FALSE WHERE is_default`, [], c);
      const { rows: [row] } = await query(`UPDATE ${table} SET is_default = TRUE WHERE id = $1 RETURNING *`, [id], c);
      if (!row) throw notFound(table);
      return row;
    });
  }
  return api;
}

module.exports = { makeCrud };
