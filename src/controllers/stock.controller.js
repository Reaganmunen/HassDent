const models = require('../models');
const v = require('../utils/validate');
const { ok, created, wrap } = require('../utils/respond');
const { paginate } = require('../utils/sql');
const audit = require('../utils/audit');

const REASONS = ['damaged', 'expired', 'lost', 'found', 'correction', 'sample', 'other'];

exports.levels = wrap(async (req, res) => ok(res, await models.stock.getLevels({
  product_id: v.optId(req.query.product_id, 'product_id'), location_id: v.optId(req.query.location_id, 'location_id'),
})));

exports.movements = wrap(async (req, res) => {
  const { limit, offset } = paginate(req.query);
  const q = req.query;
  ok(res, await models.stock.listMovements({
    product_id: v.optId(q.product_id, 'product_id'), location_id: v.optId(q.location_id, 'location_id'),
    movement_type: q.movement_type, from: v.optDate(q.from, 'from'), to: v.optDate(q.to, 'to'), limit, offset,
  }));
});

exports.batches = wrap(async (req, res) => ok(res, await models.stock.listBatches({
  product_id: v.optId(req.query.product_id, 'product_id'), location_id: v.optId(req.query.location_id, 'location_id'),
  with_stock: v.optBool(req.query.with_stock) !== false,
})));

exports.lowStock = wrap(async (req, res) => ok(res, await models.stock.lowStock()));
exports.expiring = wrap(async (req, res) => ok(res, await models.stock.expiring()));
exports.valuation = wrap(async (req, res) => ok(res, await models.stock.valuation()));
exports.integrity = wrap(async (req, res) => {
  const problems = await models.stock.integrityCheck();
  ok(res, { healthy: problems.length === 0, problems });
});

exports.adjust = wrap(async (req, res) => {
  const b = req.body || {};
  v.required(b, ['reason']);
  v.oneOf(b.reason, 'reason', REASONS);
  const items = v.array(b.items, 'items').map((it, i) => {
    const qty = v.int(it.quantity_change, `items[${i}].quantity_change`);
    if (qty === 0) throw v.bad(`items[${i}].quantity_change cannot be zero`);
    return { product_id: v.id(it.product_id, `items[${i}].product_id`), quantity_change: qty, batch_id: v.optId(it.batch_id, `items[${i}].batch_id`) };
  });
  const location_id = v.optId(b.location_id, 'location_id') || (await models.defaultLocationId());
  const adj = await models.stock.adjust({ location_id, reason: b.reason, notes: b.notes, items, user_id: req.user.id });
  await audit.record(req, 'stock_adjust', 'stock_adjustment', adj.id, null, { reason: b.reason, items });
  created(res, adj);
});

exports.transfer = wrap(async (req, res) => {
  const b = req.body || {};
  v.required(b, ['from_location_id', 'to_location_id']);
  const items = v.array(b.items, 'items').map((it, i) => ({
    product_id: v.id(it.product_id, `items[${i}].product_id`), quantity: v.int(it.quantity, `items[${i}].quantity`, { min: 1 }), batch_id: v.optId(it.batch_id, `items[${i}].batch_id`),
  }));
  const t = await models.stock.transfer({
    from_location_id: v.id(b.from_location_id, 'from_location_id'), to_location_id: v.id(b.to_location_id, 'to_location_id'),
    notes: b.notes, items, user_id: req.user.id,
  });
  created(res, t);
});

// ---- stock takes ----
exports.startTake = wrap(async (req, res) => {
  const b = req.body || {};
  const location_id = v.optId(b.location_id, 'location_id') || (await models.defaultLocationId());
  created(res, await models.stock.startStockTake({ location_id, notes: b.notes, user_id: req.user.id }));
});

exports.getTake = wrap(async (req, res) => ok(res, await models.stock.getStockTake(v.id(req.params.id))));

exports.recordCount = wrap(async (req, res) => {
  const b = req.body || {};
  v.required(b, ['counted_qty']);
  ok(res, await models.stock.recordCount(v.id(req.params.id), v.id(req.params.itemId, 'itemId'), v.int(b.counted_qty, 'counted_qty', { min: 0 })));
});

exports.completeTake = wrap(async (req, res) => {
  const result = await models.stock.completeStockTake(v.id(req.params.id), req.user.id);
  await audit.record(req, 'stock_take_complete', 'stock_take', result.id, null, { adjusted_items: result.adjusted_items });
  ok(res, result);
});
