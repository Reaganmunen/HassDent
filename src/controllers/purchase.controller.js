const models = require('../models');
const v = require('../utils/validate');
const { ok, created, wrap } = require('../utils/respond');
const { paginate } = require('../utils/sql');
const audit = require('../utils/audit');

// ---- purchase orders ----
exports.listPOs = wrap(async (req, res) => {
  const { limit, offset } = paginate(req.query);
  ok(res, await models.purchases.listPOs({ status: req.query.status, supplier_id: v.optId(req.query.supplier_id, 'supplier_id'), limit, offset }));
});

exports.getPO = wrap(async (req, res) => ok(res, await models.purchases.getPO(v.id(req.params.id))));

exports.createPO = wrap(async (req, res) => {
  const b = req.body || {};
  v.required(b, ['supplier_id']);
  const items = v.array(b.items, 'items').map((it, i) => ({
    product_id: v.id(it.product_id, `items[${i}].product_id`),
    quantity: v.int(it.quantity, `items[${i}].quantity`, { min: 1 }),
    unit_cost: v.num(it.unit_cost, `items[${i}].unit_cost`, { min: 0 }),
    tax_rate: v.optNum(it.tax_rate, `items[${i}].tax_rate`, { min: 0, max: 100 }) || 0,
  }));
  const po = await models.purchases.createPO({
    supplier_id: v.id(b.supplier_id, 'supplier_id'), expected_date: v.optDate(b.expected_date, 'expected_date'), notes: b.notes,
    status: b.status === 'ordered' ? 'ordered' : 'draft', items, created_by: req.user.id,
  });
  await audit.record(req, 'create', 'purchase_order', po.id, null, { po_number: po.po_number, total: po.total });
  created(res, po);
});

/** Body: { status: 'ordered' | 'cancelled' } */
exports.setPOStatus = wrap(async (req, res) => {
  const id = v.id(req.params.id);
  const status = v.oneOf((req.body || {}).status, 'status', ['ordered', 'cancelled']);
  const po = await models.purchases.setPOStatus(id, status, req.user.id);
  await audit.record(req, `po_${status}`, 'purchase_order', id);
  ok(res, po);
});

// ---- receiving goods ----
exports.receive = wrap(async (req, res) => {
  const b = req.body || {};
  const items = v.array(b.items, 'items').map((it, i) => ({
    product_id: v.id(it.product_id, `items[${i}].product_id`),
    quantity: v.int(it.quantity, `items[${i}].quantity`, { min: 1 }),
    unit_cost: v.num(it.unit_cost, `items[${i}].unit_cost`, { min: 0 }),
    batch_number: it.batch_number ? v.str(it.batch_number, `items[${i}].batch_number`, { max: 50 }) : undefined,
    expiry_date: v.optDate(it.expiry_date, `items[${i}].expiry_date`),
    manufactured_date: v.optDate(it.manufactured_date, `items[${i}].manufactured_date`),
    purchase_order_item_id: v.optId(it.purchase_order_item_id, `items[${i}].purchase_order_item_id`),
  }));
  const purchase_order_id = v.optId(b.purchase_order_id, 'purchase_order_id');
  const supplier_id = v.optId(b.supplier_id, 'supplier_id');
  if (!purchase_order_id && !supplier_id) throw v.bad('Provide purchase_order_id or supplier_id');
  const location_id = v.optId(b.location_id, 'location_id') || (await models.defaultLocationId());

  const grn = await models.purchases.receiveGoods({
    purchase_order_id, supplier_id, location_id, supplier_invoice_no: b.supplier_invoice_no,
    received_date: v.optDate(b.received_date, 'received_date'), notes: b.notes, items, received_by: req.user.id,
  });
  await audit.record(req, 'receive_goods', 'goods_received_note', grn.id, null, { grn_number: grn.grn_number, total_cost: grn.total_cost });
  created(res, grn);
});

exports.getGRN = wrap(async (req, res) => ok(res, await models.purchases.getGRN(v.id(req.params.id))));
exports.listGRNs = wrap(async (req, res) => {
  const { limit, offset } = paginate(req.query);
  ok(res, await models.purchases.listGRNs({ supplier_id: v.optId(req.query.supplier_id, 'supplier_id'), limit, offset }));
});

// ---- supplier payments & returns ----
exports.listSupplierPayments = wrap(async (req, res) => ok(res, await models.purchases.listSupplierPayments(v.id(req.params.id))));

exports.recordSupplierPayment = wrap(async (req, res) => {
  const b = req.body || {};
  v.required(b, ['amount', 'method']);
  const row = await models.purchases.recordSupplierPayment({
    supplier_id: v.id(req.params.id), purchase_order_id: v.optId(b.purchase_order_id, 'purchase_order_id'), grn_id: v.optId(b.grn_id, 'grn_id'),
    amount: v.num(b.amount, 'amount', { min: 0.01 }), method: v.oneOf(b.method, 'method', ['cash', 'mpesa', 'bank_transfer', 'cheque']),
    reference: b.reference, notes: b.notes, paid_by: req.user.id,
  });
  await audit.record(req, 'supplier_payment', 'supplier', row.supplier_id, null, { amount: row.amount, method: row.method });
  created(res, row);
});

exports.createSupplierReturn = wrap(async (req, res) => {
  const b = req.body || {};
  v.required(b, ['supplier_id', 'reason']);
  const items = v.array(b.items, 'items').map((it, i) => ({
    product_id: v.id(it.product_id, `items[${i}].product_id`), quantity: v.int(it.quantity, `items[${i}].quantity`, { min: 1 }),
    unit_cost: v.num(it.unit_cost, `items[${i}].unit_cost`, { min: 0 }), batch_id: v.optId(it.batch_id, `items[${i}].batch_id`),
  }));
  const location_id = v.optId(b.location_id, 'location_id') || (await models.defaultLocationId());
  const ret = await models.purchases.createSupplierReturn({
    supplier_id: v.id(b.supplier_id, 'supplier_id'), grn_id: v.optId(b.grn_id, 'grn_id'), location_id,
    reason: v.oneOf(b.reason, 'reason', ['damaged', 'expired', 'wrong_item', 'overstock', 'other']),
    credit_amount: v.optNum(b.credit_amount, 'credit_amount', { min: 0 }) || 0, notes: b.notes, items, created_by: req.user.id,
  });
  await audit.record(req, 'supplier_return', 'supplier_return', ret.id, null, { reason: ret.reason, credit_amount: ret.credit_amount });
  created(res, ret);
});
