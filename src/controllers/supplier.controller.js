const models = require('../models');
const v = require('../utils/validate');
const { ok, created, wrap } = require('../utils/respond');
const { paginate } = require('../utils/sql');
const audit = require('../utils/audit');

exports.list = wrap(async (req, res) => {
  const { limit, offset } = paginate({ limit: req.query.limit || 100, page: req.query.page });
  ok(res, await models.suppliers.list({ search: req.query.search, active: v.optBool(req.query.active), limit, offset }));
});

exports.get = wrap(async (req, res) => {
  const id = v.id(req.params.id);
  const [supplier, balance] = await Promise.all([models.suppliers.getById(id), models.suppliers.getBalance(id)]);
  ok(res, { ...supplier, balance });
});

exports.create = wrap(async (req, res) => {
  const b = req.body || {};
  v.required(b, ['name']);
  const row = await models.suppliers.create(b);
  await audit.record(req, 'create', 'supplier', row.id, null, { name: row.name });
  created(res, row);
});

exports.update = wrap(async (req, res) => {
  const id = v.id(req.params.id);
  const before = await models.suppliers.getById(id);
  const row = await models.suppliers.update(id, req.body || {});
  const keys = Object.keys(req.body || {});
  await audit.record(req, 'update', 'supplier', id, audit.pick(before, keys), audit.pick(row, keys));
  ok(res, row);
});

// Suppliers with purchase history can't be deleted (FK); deactivate them instead.
exports.setActive = wrap(async (req, res) => {
  const id = v.id(req.params.id);
  const row = await models.suppliers.update(id, { is_active: Boolean((req.body || {}).is_active) });
  await audit.record(req, row.is_active ? 'activate' : 'deactivate', 'supplier', id);
  ok(res, row);
});
