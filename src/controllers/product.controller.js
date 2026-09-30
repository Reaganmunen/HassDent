const models = require('../models');
const v = require('../utils/validate');
const { ok, created, paged, wrap } = require('../utils/respond');
const { paginate } = require('../utils/sql');
const audit = require('../utils/audit');

exports.list = wrap(async (req, res) => {
  const page = paginate(req.query);
  const q = req.query;
  const r = await models.products.list({
    search: q.search, category_id: v.optId(q.category_id, 'category_id'), brand_id: v.optId(q.brand_id, 'brand_id'),
    active: q.active === 'all' ? 'all' : v.optBool(q.active), low_stock: v.optBool(q.low_stock), ...page,
  });
  paged(res, r.items, r.total, page);
});

exports.get = wrap(async (req, res) => ok(res, await models.products.getById(v.id(req.params.id))));

/** Counter search. Pass customer_id so the price shown is that customer's group price. */
exports.posSearch = wrap(async (req, res) => {
  v.required(req.query, ['q']);
  let customer_group_id;
  const customerId = v.optId(req.query.customer_id, 'customer_id');
  if (customerId) customer_group_id = (await models.customers.getById(customerId)).customer_group_id;
  const location_id = v.optId(req.query.location_id, 'location_id') || (await models.defaultLocationId());
  ok(res, await models.products.posSearch(String(req.query.q), { location_id, customer_group_id }));
});

exports.create = wrap(async (req, res) => {
  const b = req.body || {};
  v.required(b, ['sku', 'name', 'unit_id']);
  v.str(b.name, 'name', { max: 200 });
  v.optNum(b.cost_price, 'cost_price', { min: 0 });
  v.optNum(b.selling_price, 'selling_price', { min: 0 });
  v.optNum(b.min_price, 'min_price', { min: 0 });
  v.optInt(b.reorder_level, 'reorder_level', { min: 0 });
  const opening = v.optInt(b.opening_stock, 'opening_stock', { min: 0 }) || 0;
  const location_id = opening > 0 ? (v.optId(b.location_id, 'location_id') || (await models.defaultLocationId())) : undefined;

  const product = await models.products.create(b, { opening_stock: opening, location_id, user_id: req.user.id });
  await audit.record(req, 'create', 'product', product.id, null, { sku: product.sku, name: product.name, selling_price: product.selling_price });
  created(res, product);
});

exports.update = wrap(async (req, res) => {
  const id = v.id(req.params.id);
  const b = req.body || {};
  v.optNum(b.cost_price, 'cost_price', { min: 0 });
  v.optNum(b.selling_price, 'selling_price', { min: 0 });
  v.optNum(b.min_price, 'min_price', { min: 0 });
  const before = await models.products.getById(id);
  const product = await models.products.update(id, b);
  const keys = Object.keys(b);
  await audit.record(req, 'update', 'product', id, audit.pick(before, keys), audit.pick(product, keys));
  ok(res, product);
});

exports.setActive = wrap(async (req, res) => {
  const id = v.id(req.params.id);
  const active = Boolean((req.body || {}).is_active);
  const product = await models.products.setActive(id, active);
  await audit.record(req, active ? 'activate' : 'deactivate', 'product', id);
  ok(res, product);
});

exports.priceHistory = wrap(async (req, res) => ok(res, await models.products.priceHistory(v.id(req.params.id))));

exports.setGroupPrice = wrap(async (req, res) => {
  const b = req.body || {};
  v.required(b, ['customer_group_id', 'price']);
  const row = await models.products.setGroupPrice({
    product_id: v.id(req.params.id), customer_group_id: v.id(b.customer_group_id, 'customer_group_id'), price: v.num(b.price, 'price', { min: 0 }),
  });
  await audit.record(req, 'set_group_price', 'product', row.product_id, null, row);
  ok(res, row);
});

exports.removeGroupPrice = wrap(async (req, res) => {
  await models.products.removeGroupPrice(v.id(req.params.id), v.id(req.params.groupId, 'groupId'));
  ok(res, { deleted: true });
});

exports.linkSupplier = wrap(async (req, res) => {
  const b = req.body || {};
  v.required(b, ['supplier_id']);
  ok(res, await models.products.linkSupplier({ ...b, product_id: v.id(req.params.id), supplier_id: v.id(b.supplier_id, 'supplier_id') }));
});

exports.unlinkSupplier = wrap(async (req, res) => {
  await models.products.unlinkSupplier(v.id(req.params.id), v.id(req.params.supplierId, 'supplierId'));
  ok(res, { deleted: true });
});
