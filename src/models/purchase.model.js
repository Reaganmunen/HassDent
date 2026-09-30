const { query, inTx } = require('../config/db');
const { AppError, notFound } = require('../utils/errors');
const { toCents, fromCents } = require('../utils/money');
const stock = require('./stock.model');

// Purchase prices are entered EXCLUSIVE of VAT (input VAT is reclaimable, so it is not part of stock cost).

// ---------------------------------------------------------------- purchase orders
async function createPO({ supplier_id, expected_date, notes, items, created_by, status = 'draft' }, db) {
  if (!items || !items.length) throw new AppError('A purchase order needs at least one item', 400);
  return inTx(db, async (c) => {
    let subtotal = 0; let tax = 0;
    const lines = items.map((it) => {
      const line = toCents(it.unit_cost) * it.quantity;
      subtotal += line; tax += Math.round((line * Number(it.tax_rate || 0)) / 100);
      return { ...it, line };
    });
    const { rows: [po] } = await query(
      `INSERT INTO purchase_orders (supplier_id, status, order_date, expected_date, subtotal, tax_total, total, notes, created_by)
       VALUES ($1,$2::varchar,CASE WHEN $2::varchar = 'ordered' THEN CURRENT_DATE END,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [supplier_id, status, expected_date || null, fromCents(subtotal), fromCents(tax), fromCents(subtotal + tax), notes || null, created_by || null], c);
    for (const l of lines) {
      await query(
        `INSERT INTO purchase_order_items (purchase_order_id, product_id, quantity_ordered, unit_cost, tax_rate, line_total)
         VALUES ($1,$2,$3,$4,$5,$6)`, [po.id, l.product_id, l.quantity, l.unit_cost, l.tax_rate || 0, fromCents(l.line)], c);
    }
    return getPO(po.id, c);
  });
}

async function getPO(id, db) {
  const { rows: [po] } = await query(
    `SELECT po.*, s.name AS supplier_name FROM purchase_orders po JOIN suppliers s ON s.id = po.supplier_id WHERE po.id = $1`, [id], db);
  if (!po) throw notFound('Purchase order');
  const { rows: items } = await query(
    `SELECT i.*, p.name AS product_name, p.sku FROM purchase_order_items i JOIN products p ON p.id = i.product_id
      WHERE i.purchase_order_id = $1 ORDER BY i.id`, [id], db);
  return { ...po, items };
}

async function listPOs({ status, supplier_id, limit = 50, offset = 0 } = {}, db) {
  const where = []; const params = [];
  if (status) { params.push(status); where.push(`po.status = $${params.length}`); }
  if (supplier_id) { params.push(supplier_id); where.push(`po.supplier_id = $${params.length}`); }
  params.push(limit, offset);
  const { rows } = await query(
    `SELECT po.*, s.name AS supplier_name FROM purchase_orders po JOIN suppliers s ON s.id = po.supplier_id
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY po.id DESC LIMIT $${params.length - 1} OFFSET $${params.length}`, params, db);
  return rows;
}

async function setPOStatus(id, status, approved_by, db) {
  const allowed = { ordered: ['draft'], cancelled: ['draft', 'ordered'] };
  if (!allowed[status]) throw new AppError('Unsupported status change', 400);
  const { rows: [po] } = await query(
    `UPDATE purchase_orders SET status = $2::varchar, approved_by = COALESCE($3, approved_by),
            order_date = CASE WHEN $2::varchar = 'ordered' THEN CURRENT_DATE ELSE order_date END
      WHERE id = $1 AND status = ANY($4::text[]) RETURNING *`, [id, status, approved_by || null, allowed[status]], db);
  if (!po) throw new AppError(`Purchase order cannot be moved to "${status}" from its current state`, 409, 'INVALID_STATE');
  return po;
}

// ---------------------------------------------------------------- receiving goods
/**
 * The event that actually adds stock. For every line: creates/uses the batch (expiry products),
 * writes a 'purchase' ledger movement, updates the product's weighted-average cost, and rolls
 * quantity_received forward on the linked purchase order.
 *
 * items: [{ product_id, quantity, unit_cost, batch_number?, expiry_date?, purchase_order_item_id? }]
 */
async function receiveGoods({ purchase_order_id, supplier_id, location_id, supplier_invoice_no, received_date, notes, items, received_by }, db) {
  if (!items || !items.length) throw new AppError('Add at least one item to receive', 400);
  return inTx(db, async (c) => {
    let po = null;
    if (purchase_order_id) {
      const { rows: [row] } = await query('SELECT * FROM purchase_orders WHERE id = $1 FOR UPDATE', [purchase_order_id], c);
      if (!row) throw notFound('Purchase order');
      if (!['ordered', 'partially_received'].includes(row.status)) {
        throw new AppError(`Purchase order is "${row.status}" and cannot receive goods`, 409, 'INVALID_STATE');
      }
      po = row;
    }
    const supplierId = supplier_id || (po && po.supplier_id);
    if (!supplierId) throw new AppError('supplier_id is required', 400);

    const { rows: [grn] } = await query(
      `INSERT INTO goods_received_notes (purchase_order_id, supplier_id, supplier_invoice_no, location_id, received_date, notes, received_by)
       VALUES ($1,$2,$3,$4,COALESCE($5, CURRENT_DATE),$6,$7) RETURNING *`,
      [purchase_order_id || null, supplierId, supplier_invoice_no || null, location_id, received_date || null, notes || null, received_by || null], c);

    let totalCost = 0;
    for (const it of items) {
      if (!(it.quantity > 0)) throw new AppError('Received quantity must be positive', 400);
      const { rows: [p] } = await query('SELECT id, name, tracks_expiry, cost_price FROM products WHERE id = $1', [it.product_id], c);
      if (!p) throw notFound('Product');

      let batchId = null;
      if (p.tracks_expiry) {
        if (!it.batch_number || !it.expiry_date) {
          throw new AppError(`"${p.name}" tracks expiry: batch number and expiry date are required`, 422, 'BATCH_REQUIRED');
        }
        const b = await stock.findOrCreateBatch(c, { product_id: p.id, batch_number: it.batch_number, expiry_date: it.expiry_date,
          manufactured_date: it.manufactured_date, unit_cost: it.unit_cost, supplier_id: supplierId });
        batchId = b.id;
      }

      // Weighted-average cost: computed BEFORE the new units enter stock.
      const { rows: [oh] } = await query('SELECT COALESCE(SUM(on_hand), 0)::INT AS qty FROM stock_levels WHERE product_id = $1', [p.id], c);
      const oldValue = oh.qty * toCents(p.cost_price);
      const newValue = it.quantity * toCents(it.unit_cost);
      const avgCents = oh.qty + it.quantity > 0 ? Math.round((oldValue + newValue) / (oh.qty + it.quantity)) : toCents(it.unit_cost);

      // Link to the PO line (explicit id, or match on product).
      let poItemId = it.purchase_order_item_id || null;
      if (po && !poItemId) {
        const { rows: [m] } = await query(
          'SELECT id FROM purchase_order_items WHERE purchase_order_id = $1 AND product_id = $2 ORDER BY id LIMIT 1', [po.id, p.id], c);
        poItemId = m ? m.id : null;
      }

      await query(
        `INSERT INTO grn_items (grn_id, purchase_order_item_id, product_id, batch_id, quantity, unit_cost) VALUES ($1,$2,$3,$4,$5,$6)`,
        [grn.id, poItemId, p.id, batchId, it.quantity, it.unit_cost], c);
      await stock.applyMovement(c, { product_id: p.id, batch_id: batchId, location_id, quantity: it.quantity, movement_type: 'purchase',
        unit_cost: it.unit_cost, source_type: 'grn', source_id: grn.id, created_by: received_by });
      await query('UPDATE products SET cost_price = $2 WHERE id = $1', [p.id, fromCents(avgCents)], c);
      await query(
        `INSERT INTO product_suppliers (product_id, supplier_id, last_cost) VALUES ($1,$2,$3)
         ON CONFLICT (product_id, supplier_id) DO UPDATE SET last_cost = EXCLUDED.last_cost`, [p.id, supplierId, it.unit_cost], c);
      if (poItemId) {
        await query('UPDATE purchase_order_items SET quantity_received = quantity_received + $2 WHERE id = $1', [poItemId, it.quantity], c);
      }
      totalCost += toCents(it.unit_cost) * it.quantity;
    }

    await query('UPDATE goods_received_notes SET total_cost = $2 WHERE id = $1', [grn.id, fromCents(totalCost)], c);

    if (po) {
      const { rows: [open] } = await query(
        'SELECT COUNT(*)::INT AS n FROM purchase_order_items WHERE purchase_order_id = $1 AND quantity_received < quantity_ordered', [po.id], c);
      await query('UPDATE purchase_orders SET status = $2::varchar, received_at = CASE WHEN $2::varchar = \'received\' THEN NOW() ELSE received_at END WHERE id = $1',
        [po.id, open.n === 0 ? 'received' : 'partially_received'], c);
    }
    return getGRN(grn.id, c);
  });
}

async function getGRN(id, db) {
  const { rows: [grn] } = await query(
    `SELECT g.*, s.name AS supplier_name, l.name AS location FROM goods_received_notes g
       JOIN suppliers s ON s.id = g.supplier_id JOIN locations l ON l.id = g.location_id WHERE g.id = $1`, [id], db);
  if (!grn) throw notFound('Goods received note');
  const { rows: items } = await query(
    `SELECT i.*, p.name AS product_name, b.batch_number, b.expiry_date FROM grn_items i
       JOIN products p ON p.id = i.product_id LEFT JOIN batches b ON b.id = i.batch_id WHERE i.grn_id = $1 ORDER BY i.id`, [id], db);
  return { ...grn, items };
}

const listGRNs = async ({ supplier_id, limit = 50, offset = 0 } = {}, db) => (await query(
  `SELECT g.*, s.name AS supplier_name FROM goods_received_notes g JOIN suppliers s ON s.id = g.supplier_id
    ${supplier_id ? 'WHERE g.supplier_id = $3' : ''} ORDER BY g.id DESC LIMIT $1 OFFSET $2`,
  supplier_id ? [limit, offset, supplier_id] : [limit, offset], db)).rows;

// ---------------------------------------------------------------- supplier payments & returns
async function recordSupplierPayment({ supplier_id, purchase_order_id, grn_id, amount, method, reference, notes, paid_by }, db) {
  const { rows: [row] } = await query(
    `INSERT INTO supplier_payments (supplier_id, purchase_order_id, grn_id, amount, method, reference, notes, paid_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [supplier_id, purchase_order_id || null, grn_id || null, amount, method, reference || null, notes || null, paid_by || null], db);
  return row;
}
const listSupplierPayments = async (supplier_id, db) => (await query(
  'SELECT * FROM supplier_payments WHERE supplier_id = $1 ORDER BY paid_at DESC', [supplier_id], db)).rows;

/** Send goods back to a supplier: stock goes down (FEFO for expiry products unless a batch is given). */
async function createSupplierReturn({ supplier_id, grn_id, location_id, reason, credit_amount = 0, notes, items, created_by }, db) {
  if (!items || !items.length) throw new AppError('Add at least one item', 400);
  return inTx(db, async (c) => {
    const { rows: [ret] } = await query(
      `INSERT INTO supplier_returns (supplier_id, grn_id, location_id, reason, credit_amount, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`, [supplier_id, grn_id || null, location_id, reason, credit_amount, notes || null, created_by || null], c);
    for (const it of items) {
      const slices = await stock.expandToBatches(c, { product_id: it.product_id, location_id, quantity: -it.quantity, batch_id: it.batch_id });
      for (const s of slices) {
        await query(`INSERT INTO supplier_return_items (supplier_return_id, product_id, batch_id, quantity, unit_cost) VALUES ($1,$2,$3,$4,$5)`,
          [ret.id, it.product_id, s.batch_id, -s.quantity, it.unit_cost], c);
        await stock.applyMovement(c, { product_id: it.product_id, batch_id: s.batch_id, location_id, quantity: s.quantity,
          movement_type: 'supplier_return', unit_cost: it.unit_cost, source_type: 'supplier_return', source_id: ret.id, created_by });
      }
    }
    return ret;
  });
}

module.exports = { createPO, getPO, listPOs, setPOStatus, receiveGoods, getGRN, listGRNs,
  recordSupplierPayment, listSupplierPayments, createSupplierReturn };
