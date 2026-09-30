const models = require('../models');
const v = require('../utils/validate');
const { AppError } = require('../utils/errors');
const { ok, created, paged, wrap } = require('../utils/respond');
const { paginate } = require('../utils/sql');
const { hasPermission } = require('../middleware/auth');
const audit = require('../utils/audit');

const forbidden = (msg) => new AppError(msg, 403, 'FORBIDDEN');

/** Validate the payments array. `status: 'pending'` is only meaningful for an M-Pesa STK push still awaiting the callback. */
function parsePayments(list) {
  return (list || []).map((p, i) => {
    v.required(p, ['method', 'amount']);
    const pending = p.status === 'pending';
    if (pending && p.method !== 'mpesa') throw v.bad(`payments[${i}]: only M-Pesa payments can be pending`);
    return {
      method: v.oneOf(p.method, `payments[${i}].method`, ['cash', 'mpesa', 'card', 'bank_transfer']),
      amount: v.num(p.amount, `payments[${i}].amount`, { min: 0.01 }),
      reference: p.reference,
      mpesa_transaction_id: v.optId(p.mpesa_transaction_id, `payments[${i}].mpesa_transaction_id`),
      ...(pending ? { status: 'pending' } : {}),
    };
  });
}

/**
 * The POS checkout.
 * Body: {
 *   customer_id?, customer_name?,                            // mutually exclusive; omit both for anonymous walk-in
 *   items: [{ product_id, quantity, unit_price?, discount_amount? }],
 *   payments: [{ method, amount, reference? }],
 *   discount_amount?, loyalty_points_to_redeem?, status?: 'held', notes?
 * }
 * Discounts / price overrides need the sales.discount permission; selling below a product's floor price needs products.manage.
 */
exports.create = wrap(async (req, res) => {
  const b = req.body || {};
  const canDiscount = hasPermission(req.user, 'sales.discount');

  const items = v.array(b.items, 'items').map((it, i) => {
    const line = { product_id: v.id(it.product_id, `items[${i}].product_id`), quantity: v.int(it.quantity, `items[${i}].quantity`, { min: 1 }) };
    if (it.unit_price !== undefined && it.unit_price !== null) line.unit_price = v.num(it.unit_price, `items[${i}].unit_price`, { min: 0 });
    if (it.discount_amount) line.discount_amount = v.num(it.discount_amount, `items[${i}].discount_amount`, { min: 0 });
    return line;
  });

  const saleDiscount = v.optNum(b.discount_amount, 'discount_amount', { min: 0 }) || 0;
  if ((saleDiscount > 0 || items.some((i) => i.discount_amount > 0)) && !canDiscount) {
    throw forbidden('You are not allowed to give discounts');
  }
  const points = v.optInt(b.loyalty_points_to_redeem, 'loyalty_points_to_redeem', { min: 0 }) || 0;

  // Customer identification: a saved customer OR a walk-in name. Never both.
  const customerId = v.optId(b.customer_id, 'customer_id');
  let customerName = null;
  if (b.customer_name !== undefined && b.customer_name !== null) {
    customerName = v.str(b.customer_name, 'customer_name', { max: 150 }).trim() || null;
  }
  if (customerId && customerName) {
    throw new AppError('Provide either customer_id or customer_name, not both', 400, 'CUSTOMER_CONFLICT');
  }

  // Attach to the cashier's open till session automatically.
  const register_session_id = v.optId(b.register_session_id, 'register_session_id')
    || ((await models.registers.getOpen(req.user.id)) || {}).id;

  const sale = await models.sales.createSale({
    customer_id: customerId,
    customer_name: customerName,
    location_id: v.optId(b.location_id, 'location_id'),
    register_session_id,
    status: b.status === 'held' ? 'held' : 'completed',
    items, discount_amount: saleDiscount, loyalty_points_to_redeem: points,
    payments: parsePayments(b.payments), notes: b.notes, sold_by: req.user.id,
    allow_price_override: canDiscount,
    allow_below_min: hasPermission(req.user, 'products.manage'),
  });
  created(res, sale);
});

exports.completeHeld = wrap(async (req, res) => {
  const b = req.body || {};
  const register_session_id = v.optId(b.register_session_id, 'register_session_id')
    || ((await models.registers.getOpen(req.user.id)) || {}).id;
  ok(res, await models.sales.completeHeld(v.id(req.params.id), { payments: parsePayments(b.payments), sold_by: req.user.id, register_session_id }));
});

exports.deleteHeld = wrap(async (req, res) => {
  await models.sales.deleteHeld(v.id(req.params.id));
  ok(res, { deleted: true });
});

exports.listHeld = wrap(async (req, res) => {
  const r = await models.sales.listHeld();
  ok(res, r.items);
});

exports.list = wrap(async (req, res) => {
  const page = paginate(req.query);
  const q = req.query;
  const r = await models.sales.list({
    from: v.optDate(q.from, 'from'), to: v.optDate(q.to, 'to'), customer_id: v.optId(q.customer_id, 'customer_id'),
    status: q.status, payment_status: q.payment_status, search: q.search, ...page,
  });
  paged(res, r.items, r.total, page);
});

exports.get = wrap(async (req, res) => ok(res, await models.sales.getById(v.id(req.params.id))));

/** Everything a printed/PDF receipt needs: shop details + the sale. */
exports.receipt = wrap(async (req, res) => {
  const [sale, s] = await Promise.all([models.sales.getById(v.id(req.params.id)), models.settings.get()]);
  ok(res, {
    shop: { name: s.shop_name, address: s.address, phone: s.phone, email: s.email, kra_pin: s.kra_pin, currency: s.currency, footer: s.receipt_footer },
    sale,
  });
});

exports.listUnpaid = wrap(async (req, res) => ok(res, await models.sales.listUnpaid()));

/** Customer pays off (part of) a credit balance later. */
exports.addPayment = wrap(async (req, res) => {
  const [p] = parsePayments([req.body || {}]);
  ok(res, await models.sales.addPayment({ sale_id: v.id(req.params.id), ...p, received_by: req.user.id }));
});

exports.void = wrap(async (req, res) => {
  const id = v.id(req.params.id);
  const reason = v.str((req.body || {}).reason, 'reason', { max: 300 });
  const sale = await models.sales.voidSale(id, { user_id: req.user.id, reason });
  await audit.record(req, 'void', 'sale', id, null, { sale_number: sale.sale_number, total: sale.total, reason });
  ok(res, sale);
});

/** Body: { reason, refund_method, items:[{sale_item_id, quantity, restock?}], notes? } */
exports.createReturn = wrap(async (req, res) => {
  const b = req.body || {};
  v.required(b, ['reason', 'refund_method']);
  const items = v.array(b.items, 'items').map((it, i) => ({
    sale_item_id: v.id(it.sale_item_id, `items[${i}].sale_item_id`),
    quantity: v.int(it.quantity, `items[${i}].quantity`, { min: 1 }),
    restock: it.restock !== false,
  }));
  const ret = await models.sales.createReturn({
    sale_id: v.id(req.params.id), items, notes: b.notes, processed_by: req.user.id,
    reason: v.oneOf(b.reason, 'reason', ['defective', 'wrong_item', 'changed_mind', 'expired', 'other']),
    refund_method: v.oneOf(b.refund_method, 'refund_method', ['cash', 'mpesa', 'store_credit', 'none']),
    location_id: v.optId(b.location_id, 'location_id'),
  });
  await audit.record(req, 'return', 'sale', ret.sale_id, null, { return_number: ret.return_number, refund_amount: ret.refund_amount });
  created(res, ret);
});

exports.getReturn = wrap(async (req, res) => ok(res, await models.sales.getReturn(v.id(req.params.returnId, 'returnId'))));