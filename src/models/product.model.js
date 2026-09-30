const { query, inTx } = require('../config/db');
const { buildInsert, buildUpdate } = require('../utils/sql');
const { AppError, notFound } = require('../utils/errors');
const stock = require('./stock.model');

const FIELDS = ['sku', 'barcode', 'name', 'description', 'category_id', 'brand_id', 'unit_id', 'tax_rate_id',
  'cost_price', 'selling_price', 'min_price', 'reorder_level', 'reorder_qty', 'tracks_expiry', 'image_url', 'is_active', 'created_by'];

const STOCK_SUBQUERY = `(SELECT product_id, SUM(on_hand)::INT AS on_hand FROM stock_levels GROUP BY product_id)`;

/** Product list with category/brand/unit and total stock. Filters: search, category_id, brand_id, active, low_stock. */
async function list({ search, category_id, brand_id, active = true, low_stock, limit = 50, offset = 0 } = {}, db) {
  const where = []; const params = [];
  if (active !== 'all' && active !== undefined) { params.push(active); where.push(`p.is_active = $${params.length}`); }
  if (category_id) { params.push(category_id); where.push(`p.category_id = $${params.length}`); }
  if (brand_id) { params.push(brand_id); where.push(`p.brand_id = $${params.length}`); }
  if (low_stock) where.push('COALESCE(sl.on_hand, 0) <= p.reorder_level');
  if (search) {
    params.push(`%${search}%`);
    where.push(`(p.name ILIKE $${params.length} OR p.sku ILIKE $${params.length} OR p.barcode ILIKE $${params.length})`);
  }
  params.push(limit, offset);
  const { rows } = await query(
    `SELECT p.id, p.sku, p.barcode, p.name, p.cost_price, p.selling_price, p.reorder_level, p.tracks_expiry, p.is_active,
            c.name AS category, b.name AS brand, u.abbreviation AS unit, COALESCE(sl.on_hand, 0) AS on_hand,
            COUNT(*) OVER()::INT AS total_count
       FROM products p
       LEFT JOIN categories c ON c.id = p.category_id LEFT JOIN brands b ON b.id = p.brand_id
       LEFT JOIN units u ON u.id = p.unit_id LEFT JOIN ${STOCK_SUBQUERY} sl ON sl.product_id = p.id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY p.name LIMIT $${params.length - 1} OFFSET $${params.length}`, params, db);
  return { items: rows.map(({ total_count, ...r }) => r), total: rows[0] ? rows[0].total_count : 0 };
}

async function getById(id, db) {
  const { rows: [p] } = await query(
    `SELECT p.*, c.name AS category, b.name AS brand, u.name AS unit, t.name AS tax_name, t.rate AS tax_rate
       FROM products p LEFT JOIN categories c ON c.id = p.category_id LEFT JOIN brands b ON b.id = p.brand_id
       LEFT JOIN units u ON u.id = p.unit_id LEFT JOIN tax_rates t ON t.id = p.tax_rate_id WHERE p.id = $1`, [id], db);
  if (!p) throw notFound('Product');
  const [levels, batches, suppliers, groupPrices] = await Promise.all([
    stock.getLevels({ product_id: id }, db),
    stock.listBatches({ product_id: id }, db),
    query(`SELECT ps.*, s.name AS supplier_name FROM product_suppliers ps JOIN suppliers s ON s.id = ps.supplier_id
            WHERE ps.product_id = $1 ORDER BY ps.is_preferred DESC, s.name`, [id], db).then((r) => r.rows),
    query(`SELECT g.customer_group_id, cg.name AS group_name, g.price FROM product_group_prices g
             JOIN customer_groups cg ON cg.id = g.customer_group_id WHERE g.product_id = $1`, [id], db).then((r) => r.rows),
  ]);
  return { ...p, stock_by_location: levels, batches, suppliers, group_prices: groupPrices,
    total_on_hand: levels.reduce((s, l) => s + l.on_hand, 0) };
}

/**
 * Counter search used by the POS: exact barcode/SKU hits first, then name matches.
 * Returns the price THIS customer group should pay and stock at the selling location.
 */
async function posSearch(term, { location_id, customer_group_id, limit = 20 } = {}, db) {
  const t = String(term || '').trim();
  if (!t) return [];
  const { rows } = await query(
    `SELECT p.id, p.sku, p.barcode, p.name, p.tracks_expiry, p.min_price,
            COALESCE(pgp.price, ROUND(p.selling_price * (1 - COALESCE(cg.discount_percent, 0) / 100), 2), p.selling_price) AS price,
            COALESCE(sl.on_hand, 0) AS on_hand
       FROM products p
       LEFT JOIN customer_groups cg ON cg.id = $3
       LEFT JOIN product_group_prices pgp ON pgp.product_id = p.id AND pgp.customer_group_id = $3
       LEFT JOIN stock_levels sl ON sl.product_id = p.id AND sl.location_id = $2
      WHERE p.is_active AND (p.barcode = $1 OR p.sku ILIKE $1 OR p.name ILIKE '%' || $1 || '%')
      ORDER BY (p.barcode = $1) DESC, (p.sku ILIKE $1) DESC, p.name LIMIT $4`,
    [t, location_id || null, customer_group_id || null, limit], db);
  return rows;
}

/** Price each product would sell at for a customer group (group price > group discount > list price). */
async function resolvePrices(db, productIds, customerGroupId) {
  const { rows } = await query(
    `SELECT p.id AS product_id,
            COALESCE(pgp.price, ROUND(p.selling_price * (1 - COALESCE(cg.discount_percent, 0) / 100), 2), p.selling_price) AS price
       FROM products p
       LEFT JOIN customer_groups cg ON cg.id = $2
       LEFT JOIN product_group_prices pgp ON pgp.product_id = p.id AND pgp.customer_group_id = $2
      WHERE p.id = ANY($1::int[])`, [productIds, customerGroupId || null], db);
  return new Map(rows.map((r) => [r.product_id, Number(r.price)]));
}

/**
 * Create a product. If tax_rate_id is omitted the default tax rate is used.
 * Optional opening stock (non-expiry products only; expiry products get stock via a goods-received note).
 */
async function create(data, { opening_stock = 0, location_id, user_id } = {}, db) {
  return inTx(db, async (c) => {
    const payload = { ...data, created_by: data.created_by || user_id };
    if (payload.tax_rate_id === undefined) {
      const { rows: [t] } = await query('SELECT id FROM tax_rates WHERE is_default LIMIT 1', [], c);
      if (t) payload.tax_rate_id = t.id;
    }
    const q = buildInsert('products', payload, FIELDS);
    const { rows: [p] } = await query(q.text, q.values, c);

    if (opening_stock > 0) {
      if (p.tracks_expiry) throw new AppError('Receive expiry-tracked stock through a goods-received note (needs batch and expiry)', 422, 'BATCH_REQUIRED');
      if (!location_id) throw new AppError('location_id is required for opening stock', 400);
      await stock.applyMovement(c, { product_id: p.id, location_id, quantity: opening_stock, movement_type: 'opening',
        unit_cost: p.cost_price, note: 'Opening stock', created_by: user_id });
    }
    return p;
  });
}

async function update(id, data, db) {
  const q = buildUpdate('products', id, data, FIELDS.filter((f) => f !== 'created_by'));
  if (q) {
    const { rowCount } = await query(q.text, q.values, db);
    if (!rowCount) throw notFound('Product');
  }
  return getById(id, db);
}

const setActive = (id, is_active, db) => update(id, { is_active }, db);

const priceHistory = async (product_id, db) => (await query(
  'SELECT * FROM product_price_history WHERE product_id = $1 ORDER BY changed_at DESC', [product_id], db)).rows;

async function setGroupPrice({ product_id, customer_group_id, price }, db) {
  const { rows: [r] } = await query(
    `INSERT INTO product_group_prices (product_id, customer_group_id, price) VALUES ($1,$2,$3)
     ON CONFLICT (product_id, customer_group_id) DO UPDATE SET price = EXCLUDED.price RETURNING *`,
    [product_id, customer_group_id, price], db);
  return r;
}
const removeGroupPrice = (product_id, customer_group_id, db) =>
  query('DELETE FROM product_group_prices WHERE product_id = $1 AND customer_group_id = $2', [product_id, customer_group_id], db);

async function linkSupplier({ product_id, supplier_id, supplier_sku, last_cost, lead_time_days, is_preferred = false }, db) {
  const { rows: [r] } = await query(
    `INSERT INTO product_suppliers (product_id, supplier_id, supplier_sku, last_cost, lead_time_days, is_preferred)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (product_id, supplier_id) DO UPDATE SET
       supplier_sku = EXCLUDED.supplier_sku, last_cost = EXCLUDED.last_cost,
       lead_time_days = EXCLUDED.lead_time_days, is_preferred = EXCLUDED.is_preferred RETURNING *`,
    [product_id, supplier_id, supplier_sku || null, last_cost ?? null, lead_time_days ?? null, is_preferred], db);
  return r;
}
const unlinkSupplier = (product_id, supplier_id, db) =>
  query('DELETE FROM product_suppliers WHERE product_id = $1 AND supplier_id = $2', [product_id, supplier_id], db);

module.exports = { list, getById, posSearch, resolvePrices, create, update, setActive, priceHistory,
  setGroupPrice, removeGroupPrice, linkSupplier, unlinkSupplier };
