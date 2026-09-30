const { query, inTx } = require('../config/db');
const { AppError, notFound } = require('../utils/errors');
const { toCents, fromCents, formatCents, taxInside } = require('../utils/money');
const stock = require('./stock.model');
const customers = require('./customer.model');
const products = require('./product.model');
const settingsModel = require('./settings.model');
const catalog = require('./catalog.model');

/**
 * SALES — the heart of the system. Everything below runs inside ONE transaction, so a sale either
 * fully happens (items, stock, loyalty, payments) or not at all.
 *
 * Conventions
 *  - Prices are VAT-inclusive. sale_items.tax_amount is the VAT already inside line_total.
 *  - sales.subtotal = sum(line_total). total = subtotal - discount_amount - loyalty_discount.
 *    sales.tax_total is scaled down proportionally when a sale-level discount applies.
 *  - Stock movements for a line carry source_type 'sale_item' / source_id = sale_items.id, so each
 *    line can be traced, voided or returned exactly.
 *  - Amounts are computed in integer cents.
 *  - A sale is either for a saved customer (customer_id) or a walk-in with a free-text name
 *    (customer_name). Never both — enforced by chk_sales_customer_exclusive on the sales table.
 */

const METHODS = ['cash', 'mpesa', 'card', 'bank_transfer'];

// ------------------------------------------------------------------ pricing
async function priceLines(c, rawItems, customer, opts) {
  const ids = [...new Set(rawItems.map((i) => i.product_id))];
  const { rows: prods } = await query(
    `SELECT p.*, COALESCE(t.rate, 0) AS tax_rate_pct FROM products p LEFT JOIN tax_rates t ON t.id = p.tax_rate_id
      WHERE p.id = ANY($1::int[])`, [ids], c);
  const byId = new Map(prods.map((p) => [p.id, p]));
  const prices = await products.resolvePrices(c, ids, customer && customer.customer_group_id);

  return rawItems.map((it) => {
    const p = byId.get(it.product_id);
    if (!p) throw notFound(`Product ${it.product_id}`);
    if (!p.is_active) throw new AppError(`"${p.name}" is inactive and cannot be sold`, 422, 'PRODUCT_INACTIVE');
    if (!Number.isInteger(it.quantity) || it.quantity <= 0) throw new AppError(`Invalid quantity for "${p.name}"`, 400, 'INVALID_QUANTITY');

    let unitCents = toCents(prices.get(p.id));
    if (it.unit_price !== undefined && it.unit_price !== null) {
      if (!opts.allow_price_override) throw new AppError('You are not allowed to change prices', 403, 'PRICE_OVERRIDE_DENIED');
      unitCents = toCents(it.unit_price);
    }
    if (p.min_price !== null && unitCents < toCents(p.min_price) && !opts.allow_below_min) {
      throw new AppError(`"${p.name}" cannot be sold below KES ${p.min_price}`, 422, 'BELOW_MIN_PRICE');
    }
    const gross = unitCents * it.quantity;
    const discount = toCents(it.discount_amount || 0);
    if (discount > gross) throw new AppError(`Discount exceeds the line total for "${p.name}"`, 422, 'DISCOUNT_TOO_LARGE');
    const lineTotal = gross - discount;
    return {
      product: p, quantity: it.quantity, unitCents, discountCents: discount, lineTotal,
      taxRate: Number(p.tax_rate_pct), taxCents: taxInside(lineTotal, p.tax_rate_pct),
      unitCostCents: toCents(p.cost_price),
    };
  });
}

function computeTotals(lines, input, customer, settings) {
  const subtotal = lines.reduce((s, l) => s + l.lineTotal, 0);
  const saleDiscount = toCents(input.discount_amount || 0);
  const points = input.loyalty_points_to_redeem || 0;
  if (points < 0) throw new AppError('Invalid loyalty points', 400);
  if (points > 0) {
    if (!customer) throw new AppError('Loyalty points can only be redeemed by a saved customer', 422, 'CUSTOMER_REQUIRED');
    if (points > customer.loyalty_points) throw new AppError('Customer does not have enough loyalty points', 409, 'INSUFFICIENT_POINTS');
  }
  const loyaltyDiscount = Math.round(points * Number(settings.loyalty_kes_per_point) * 100);
  if (saleDiscount + loyaltyDiscount > subtotal) throw new AppError('Discounts exceed the sale total', 422, 'DISCOUNT_TOO_LARGE');
  const total = subtotal - saleDiscount - loyaltyDiscount;
  const rawTax = lines.reduce((s, l) => s + l.taxCents, 0);
  const tax = subtotal > 0 ? Math.round((rawTax * total) / subtotal) : 0;
  return { subtotal, saleDiscount, points, loyaltyDiscount, total, tax };
}

// ------------------------------------------------------------------ payments
async function recordPayments(c, sale, rawPayments, customer, userId) {
  const list = (rawPayments || []).map((p) => {
    if (!METHODS.includes(p.method)) throw new AppError(`Unsupported payment method "${p.method}"`, 400, 'INVALID_METHOD');
    const cents = toCents(p.amount);
    if (cents <= 0) throw new AppError('Payment amount must be positive', 400);
    return { ...p, cents, status: p.status || 'completed' };
  });
  const total = toCents(sale.total);
  const tendered = list.reduce((s, p) => s + p.cents, 0);

  // Over-tendering is only legitimate for cash (customer hands over a bigger note). Trim it and report change.
  let excess = Math.max(tendered - total, 0);
  const changeDue = excess;
  for (let i = list.length - 1; i >= 0 && excess > 0; i--) {
    if (list[i].method === 'cash') { const cut = Math.min(excess, list[i].cents); list[i].cents -= cut; excess -= cut; }
  }
  if (excess > 0) throw new AppError('Payments exceed the sale total', 422, 'OVERPAYMENT');
  const effective = list.filter((p) => p.cents > 0);

  // Anything not covered (completed OR pending M-Pesa) is credit and needs a saved customer with room on their limit.
  const unpaid = total - effective.reduce((s, p) => s + p.cents, 0);
  if (unpaid > 0) {
    if (!customer) throw new AppError('Full payment is required unless the sale is for a saved customer', 422, 'PAYMENT_REQUIRED');
    const { rows: [b] } = await query(
      `SELECT COALESCE(SUM(total - amount_paid), 0) AS outstanding FROM sales
        WHERE customer_id = $1 AND status = 'completed' AND amount_paid < total AND id <> $2`, [customer.id, sale.id], c);
    if (toCents(b.outstanding) + unpaid > toCents(customer.credit_limit)) {
      throw new AppError('Credit limit exceeded for this customer', 409, 'CREDIT_LIMIT_EXCEEDED',
        { credit_limit: customer.credit_limit, outstanding: b.outstanding, this_sale_unpaid: fromCents(unpaid) });
    }
  }

  for (const p of effective) {
    await query(
      `INSERT INTO payments (sale_id, method, amount, reference, mpesa_transaction_id, status, received_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [sale.id, p.method, fromCents(p.cents), p.reference || null, p.mpesa_transaction_id || null, p.status, userId || null], c);
    if (p.mpesa_transaction_id) {
      await query('UPDATE mpesa_transactions SET sale_id = $1 WHERE id = $2 AND sale_id IS NULL', [sale.id, p.mpesa_transaction_id], c);
    }
  }
  return { changeDue: formatCents(changeDue), creditAmount: formatCents(Math.max(unpaid, 0)) };
}

// ------------------------------------------------------------------ finalising (stock + loyalty + payments)
async function finalise(c, sale, items, { payments, customer, settings, userId }) {
  // Sorted by product so concurrent sales lock rows in the same order (avoids deadlocks).
  const ordered = [...items].sort((a, b) => a.product_id - b.product_id);
  for (const it of ordered) {
    const slices = await stock.expandToBatches(c, { product_id: it.product_id, location_id: sale.location_id, quantity: -it.quantity });
    for (const s of slices) {
      await stock.applyMovement(c, { product_id: it.product_id, batch_id: s.batch_id, location_id: sale.location_id, quantity: s.quantity,
        movement_type: 'sale', unit_cost: it.unit_cost, source_type: 'sale_item', source_id: it.id, created_by: userId });
    }
  }

  if (sale.loyalty_points_used > 0) {
    await customers.addLoyalty(c, { customer_id: customer.id, sale_id: sale.id, type: 'redeem', points: -sale.loyalty_points_used, created_by: userId });
  }

  const pay = await recordPayments(c, sale, payments, customer, userId);

  if (customer) {
    const earned = Math.floor(Number(sale.total) * Number(settings.loyalty_points_per_kes));
    if (earned > 0) await customers.addLoyalty(c, { customer_id: customer.id, sale_id: sale.id, type: 'earn', points: earned, created_by: userId });
    // A sale counts as a visit unless one was already logged in the last 12 hours (e.g. via check-in).
    await query(
      `INSERT INTO customer_visits (customer_id, served_by, purpose)
       SELECT $1, $2, 'Purchase' WHERE NOT EXISTS
         (SELECT 1 FROM customer_visits WHERE customer_id = $1 AND visited_at > NOW() - INTERVAL '12 hours')`, [customer.id, userId || null], c);
  }
  return pay;
}

// ------------------------------------------------------------------ create
/**
 * input: {
 *   customer_id?, customer_name?, location_id?, register_session_id?, status?: 'completed'|'held', notes?, sold_by,
 *   items: [{ product_id, quantity, unit_price?, discount_amount? }],
 *   discount_amount?, loyalty_points_to_redeem?,
 *   payments: [{ method, amount, reference?, mpesa_transaction_id?, status?: 'pending' }],
 *   allow_price_override?, allow_below_min?   // set by the controller from the caller's permissions
 * }
 *
 * customer_id and customer_name are mutually exclusive. If neither is given, the sale is an
 * anonymous walk-in (name is not printed on the receipt).
 */
async function createSale(input, db) {
  if (!Array.isArray(input.items) || !input.items.length) throw new AppError('A sale needs at least one item', 400, 'NO_ITEMS');
  return inTx(db, async (c) => {
    const status = input.status === 'held' ? 'held' : 'completed';
    const settings = await settingsModel.get(c);
    const location_id = input.location_id || (await catalog.defaultLocationId(c));
    if (!location_id) throw new AppError('No default selling location is configured', 500, 'NO_LOCATION');

    let customer = null;
    if (input.customer_id) {
      const { rows: [cu] } = await query('SELECT * FROM customers WHERE id = $1 AND is_active FOR UPDATE', [input.customer_id], c);
      if (!cu) throw notFound('Customer');
      customer = cu;
    }

    // Walk-in name: only stored when there is no saved customer attached.
    let walkinName = null;
    if (!customer && input.customer_name) {
      const trimmed = String(input.customer_name).trim();
      if (trimmed.length > 150) throw new AppError('Customer name is too long (max 150)', 400, 'CUSTOMER_NAME_TOO_LONG');
      walkinName = trimmed || null;
    }

    const lines = await priceLines(c, input.items, customer, input);
    const t = computeTotals(lines, input, customer, settings);

    const { rows: [sale] } = await query(
      `INSERT INTO sales (customer_id, customer_name, register_session_id, location_id, status, subtotal, discount_amount,
                          loyalty_points_used, loyalty_discount, tax_total, total, notes, sold_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
      [customer ? customer.id : null, walkinName, input.register_session_id || null, location_id, status,
        fromCents(t.subtotal), fromCents(t.saleDiscount), t.points, fromCents(t.loyaltyDiscount), fromCents(t.tax), fromCents(t.total),
        input.notes || null, input.sold_by || null], c);

    const items = [];
    for (const l of lines) {
      const { rows: [row] } = await query(
        `INSERT INTO sale_items (sale_id, product_id, quantity, unit_price, unit_cost, discount_amount, tax_rate, tax_amount, line_total)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [sale.id, l.product.id, l.quantity, fromCents(l.unitCents), fromCents(l.unitCostCents), fromCents(l.discountCents),
          l.taxRate, fromCents(l.taxCents), fromCents(l.lineTotal)], c);
      items.push(row);
    }

    let extra = { changeDue: '0.00', creditAmount: '0.00' };
    if (status === 'completed') {
      extra = await finalise(c, sale, items, { payments: input.payments, customer, settings, userId: input.sold_by });
    }
    const full = await getById(sale.id, c);
    return { ...full, change_due: extra.changeDue, credit_amount: extra.creditAmount };
  });
}

/** Turn a parked ("held") sale into a real one: prices stay as they were quoted. */
async function completeHeld(id, { payments, sold_by, register_session_id }, db) {
  return inTx(db, async (c) => {
    const { rows: [sale] } = await query('SELECT * FROM sales WHERE id = $1 FOR UPDATE', [id], c);
    if (!sale) throw notFound('Sale');
    if (sale.status !== 'held') throw new AppError('Only held sales can be completed', 409, 'INVALID_STATE');
    const settings = await settingsModel.get(c);
    let customer = null;
    if (sale.customer_id) {
      ({ rows: [customer] } = await query('SELECT * FROM customers WHERE id = $1 FOR UPDATE', [sale.customer_id], c));
    }
    if (sale.loyalty_points_used > 0 && (!customer || customer.loyalty_points < sale.loyalty_points_used)) {
      throw new AppError('Customer no longer has enough loyalty points for this held sale', 409, 'INSUFFICIENT_POINTS');
    }
    const { rows: items } = await query('SELECT * FROM sale_items WHERE sale_id = $1 ORDER BY id', [id], c);
    const { rows: [done] } = await query(
      `UPDATE sales SET status = 'completed', sold_at = NOW(), sold_by = COALESCE($2, sold_by),
              register_session_id = COALESCE($3, register_session_id) WHERE id = $1 RETURNING *`,
      [id, sold_by || null, register_session_id || null], c);
    const extra = await finalise(c, done, items, { payments, customer, settings, userId: sold_by });
    const full = await getById(id, c);
    return { ...full, change_due: extra.changeDue, credit_amount: extra.creditAmount };
  });
}

async function deleteHeld(id, db) {
  const { rowCount } = await query(`DELETE FROM sales WHERE id = $1 AND status = 'held'`, [id], db);
  if (!rowCount) throw new AppError('Held sale not found', 404, 'NOT_FOUND');
  return true;
}

// ------------------------------------------------------------------ paying off credit
/** Record a later payment on a credit sale (e.g. customer settles their balance). */
async function addPayment({ sale_id, method, amount, reference, mpesa_transaction_id, received_by }, db) {
  return inTx(db, async (c) => {
    const { rows: [sale] } = await query('SELECT * FROM sales WHERE id = $1 FOR UPDATE', [sale_id], c);
    if (!sale) throw notFound('Sale');
    if (sale.status !== 'completed') throw new AppError('Payments can only be added to completed sales', 409, 'INVALID_STATE');
    if (!METHODS.includes(method)) throw new AppError(`Unsupported payment method "${method}"`, 400, 'INVALID_METHOD');
    const balance = toCents(sale.total) - toCents(sale.amount_paid);
    if (toCents(amount) > balance) throw new AppError(`Payment exceeds the balance of KES ${fromCents(balance)}`, 422, 'OVERPAYMENT');
    await query(
      `INSERT INTO payments (sale_id, method, amount, reference, mpesa_transaction_id, received_by) VALUES ($1,$2,$3,$4,$5,$6)`,
      [sale_id, method, amount, reference || null, mpesa_transaction_id || null, received_by || null], c);
    return getById(sale_id, c);
  });
}

// ------------------------------------------------------------------ void
/**
 * Cancel a completed sale: stock goes back into the SAME batches, payments are marked reversed,
 * loyalty is unwound, and the trigger reverses the customer's spend stats. Refunding the money
 * itself happens at the till. A sale that already has returns cannot be voided (return the rest instead).
 */
async function voidSale(id, { user_id, reason }, db) {
  return inTx(db, async (c) => {
    const { rows: [sale] } = await query('SELECT * FROM sales WHERE id = $1 FOR UPDATE', [id], c);
    if (!sale) throw notFound('Sale');
    if (sale.status !== 'completed') throw new AppError('Only completed sales can be voided', 409, 'INVALID_STATE');
    const { rows: [r] } = await query('SELECT COUNT(*)::INT AS n FROM sale_returns WHERE sale_id = $1', [id], c);
    if (r.n > 0) throw new AppError('This sale already has returns and cannot be voided', 409, 'HAS_RETURNS');

    const { rows: moves } = await query(
      `SELECT m.* FROM stock_movements m JOIN sale_items i ON i.id = m.source_id
        WHERE m.source_type = 'sale_item' AND i.sale_id = $1 AND m.movement_type = 'sale'`, [id], c);
    for (const m of moves) {
      await stock.applyMovement(c, { product_id: m.product_id, batch_id: m.batch_id, location_id: m.location_id, quantity: -m.quantity,
        movement_type: 'sale_return', unit_cost: m.unit_cost, source_type: 'sale_void', source_id: id, note: `Void ${sale.sale_number}`, created_by: user_id });
    }

    await query(`UPDATE payments SET status = 'reversed' WHERE sale_id = $1 AND status IN ('completed','pending')`, [id], c);

    if (sale.customer_id) {
      if (sale.loyalty_points_used > 0) {
        await customers.addLoyalty(c, { customer_id: sale.customer_id, sale_id: id, type: 'adjust', points: sale.loyalty_points_used, note: 'Points refunded (sale voided)', created_by: user_id });
      }
      const { rows: [e] } = await query(`SELECT COALESCE(SUM(points), 0)::INT AS earned FROM loyalty_transactions WHERE sale_id = $1 AND type = 'earn'`, [id], c);
      const { rows: [cu] } = await query('SELECT loyalty_points FROM customers WHERE id = $1', [sale.customer_id], c);
      const clawback = Math.min(e.earned, cu.loyalty_points);
      if (clawback > 0) {
        await customers.addLoyalty(c, { customer_id: sale.customer_id, sale_id: id, type: 'adjust', points: -clawback, note: 'Points reversed (sale voided)', created_by: user_id });
      }
    }

    await query(`UPDATE sales SET status = 'voided', voided_by = $2, voided_at = NOW(), void_reason = $3 WHERE id = $1`, [id, user_id || null, reason || null], c);
    return getById(id, c);
  });
}

// ------------------------------------------------------------------ customer returns
/**
 * items: [{ sale_item_id, quantity, restock?: true }]. Refund per unit is what was really paid
 * (after line and sale-level discounts). Restocked units go back to the batches they came from.
 */
async function createReturn({ sale_id, items, reason, refund_method, notes, processed_by, location_id }, db) {
  if (!items || !items.length) throw new AppError('Choose at least one item to return', 400);
  return inTx(db, async (c) => {
    const { rows: [sale] } = await query('SELECT * FROM sales WHERE id = $1 FOR UPDATE', [sale_id], c);
    if (!sale) throw notFound('Sale');
    if (sale.status !== 'completed') throw new AppError('Only completed sales can have returns', 409, 'INVALID_STATE');

    const subtotal = toCents(sale.subtotal); const total = toCents(sale.total);
    const restockLoc = location_id || sale.location_id;
    const prepared = [];
    let refundTotal = 0;

    for (const r of items) {
      const { rows: [si] } = await query('SELECT * FROM sale_items WHERE id = $1 AND sale_id = $2 FOR UPDATE', [r.sale_item_id, sale_id], c);
      if (!si) throw notFound(`Sale item ${r.sale_item_id}`);
      if (!Number.isInteger(r.quantity) || r.quantity <= 0) throw new AppError('Invalid return quantity', 400);
      if (r.quantity > si.quantity - si.quantity_returned) {
        throw new AppError('Cannot return more than was sold', 422, 'RETURN_TOO_MANY', { sale_item_id: si.id, returnable: si.quantity - si.quantity_returned });
      }
      const refund = subtotal > 0 ? Math.round((toCents(si.line_total) * r.quantity * total) / (si.quantity * subtotal)) : 0;
      refundTotal += refund;
      prepared.push({ si, qty: r.quantity, refund, restock: r.restock !== false });
    }

    const { rows: [ret] } = await query(
      `INSERT INTO sale_returns (sale_id, customer_id, location_id, reason, refund_method, refund_amount, notes, processed_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [sale_id, sale.customer_id, restockLoc, reason, refund_method, fromCents(refundTotal), notes || null, processed_by || null], c);

    for (const p of prepared) {
      // Which batches did this line take from? Give the units back to those, skipping what was already returned.
      let slices = [{ batch_id: null, quantity: p.qty }];
      const { rows: outMoves } = await query(
        `SELECT batch_id, -quantity AS qty FROM stock_movements WHERE source_type = 'sale_item' AND source_id = $1 AND movement_type = 'sale' ORDER BY id`, [p.si.id], c);
      if (outMoves.some((m) => m.batch_id)) {
        let skip = p.si.quantity_returned; let need = p.qty; slices = [];
        for (const m of outMoves) {
          let avail = m.qty;
          if (skip > 0) { const s = Math.min(skip, avail); skip -= s; avail -= s; }
          if (avail > 0 && need > 0) { const t = Math.min(avail, need); slices.push({ batch_id: m.batch_id, quantity: t }); need -= t; }
        }
      }
      for (const s of slices) {
        await query(
          `INSERT INTO sale_return_items (sale_return_id, sale_item_id, product_id, batch_id, quantity, refund_amount, restock)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [ret.id, p.si.id, p.si.product_id, s.batch_id, s.quantity, fromCents(Math.round((p.refund * s.quantity) / p.qty)), p.restock], c);
        if (p.restock) {
          await stock.applyMovement(c, { product_id: p.si.product_id, batch_id: s.batch_id, location_id: restockLoc, quantity: s.quantity,
            movement_type: 'sale_return', unit_cost: p.si.unit_cost, source_type: 'sale_return', source_id: ret.id, created_by: processed_by });
        }
      }
      await query('UPDATE sale_items SET quantity_returned = quantity_returned + $2 WHERE id = $1', [p.si.id, p.qty], c);
    }
    return getReturn(ret.id, c);
  });
}

async function getReturn(id, db) {
  const { rows: [ret] } = await query('SELECT * FROM sale_returns WHERE id = $1', [id], db);
  if (!ret) throw notFound('Return');
  const { rows: items } = await query(
    `SELECT ri.*, p.name AS product_name FROM sale_return_items ri JOIN products p ON p.id = ri.product_id WHERE ri.sale_return_id = $1`, [id], db);
  return { ...ret, items };
}

// ------------------------------------------------------------------ reading
async function getById(id, db) {
  const { rows: [sale] } = await query(
    `SELECT s.id, s.sale_number, s.customer_id,
            COALESCE(c.full_name, s.customer_name) AS customer_name,
            c.phone AS customer_phone,
            s.register_session_id, s.location_id, s.status,
            s.subtotal, s.discount_amount, s.loyalty_points_used, s.loyalty_discount,
            s.tax_total, s.total, s.amount_paid, s.payment_status, s.notes,
            s.sold_by, s.sold_at, s.voided_by, s.voided_at, s.void_reason,
            s.created_at, s.updated_at,
            u.name AS sold_by_name
       FROM sales s
       LEFT JOIN customers c ON c.id = s.customer_id
       LEFT JOIN users u ON u.id = s.sold_by
      WHERE s.id = $1`, [id], db);
  if (!sale) throw notFound('Sale');
  const [items, payments, returns] = await Promise.all([
    query(`SELECT i.*, p.name AS product_name, p.sku FROM sale_items i JOIN products p ON p.id = i.product_id WHERE i.sale_id = $1 ORDER BY i.id`, [id], db),
    query('SELECT * FROM payments WHERE sale_id = $1 ORDER BY id', [id], db),
    query('SELECT * FROM sale_returns WHERE sale_id = $1 ORDER BY id', [id], db),
  ]);
  return { ...sale, balance: formatCents(toCents(sale.total) - toCents(sale.amount_paid)), items: items.rows, payments: payments.rows, returns: returns.rows };
}

async function list({ from, to, customer_id, status, payment_status, search, limit = 50, offset = 0 } = {}, db) {
  const where = []; const params = [];
  if (from) { params.push(from); where.push(`s.sold_at >= ($${params.length}::date)::timestamp AT TIME ZONE 'Africa/Nairobi'`); }
  if (to) { params.push(to); where.push(`s.sold_at < (($${params.length}::date) + 1)::timestamp AT TIME ZONE 'Africa/Nairobi'`); }
  if (customer_id) { params.push(customer_id); where.push(`s.customer_id = $${params.length}`); }
  if (status) { params.push(status); where.push(`s.status = $${params.length}`); }
  if (payment_status) { params.push(payment_status); where.push(`s.payment_status = $${params.length}`); }
  if (search) {
    params.push(`%${search}%`);
    where.push(`(s.sale_number ILIKE $${params.length}
              OR c.full_name ILIKE $${params.length}
              OR s.customer_name ILIKE $${params.length}
              OR c.phone ILIKE $${params.length})`);
  }
  params.push(limit, offset);
  const { rows } = await query(
    `SELECT s.id, s.sale_number, s.status, s.payment_status, s.total, s.amount_paid, s.sold_at,
            COALESCE(c.full_name, s.customer_name) AS customer_name,
            u.name AS sold_by_name,
            COUNT(*) OVER()::INT AS total_count
       FROM sales s
       LEFT JOIN customers c ON c.id = s.customer_id
       LEFT JOIN users u ON u.id = s.sold_by
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY s.sold_at DESC, s.id DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}`, params, db);
  return { items: rows.map(({ total_count, ...r }) => r), total: rows[0] ? rows[0].total_count : 0 };
}

const listHeld = (db) => list({ status: 'held', limit: 100 }, db);

/** Credit sales still awaiting payment. */
async function listUnpaid(db) {
  const { rows } = await query(
    `SELECT s.id, s.sale_number, s.sold_at, s.total, s.amount_paid, (s.total - s.amount_paid) AS balance,
            c.id AS customer_id, c.full_name AS customer_name, c.phone
       FROM sales s JOIN customers c ON c.id = s.customer_id
      WHERE s.status = 'completed' AND s.amount_paid < s.total ORDER BY s.sold_at`, [], db);
  return rows;
}

module.exports = { createSale, completeHeld, deleteHeld, addPayment, voidSale, createReturn, getReturn, getById, list, listHeld, listUnpaid };