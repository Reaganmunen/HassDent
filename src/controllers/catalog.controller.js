const models = require('../models');
const v = require('../utils/validate');
const { ok, created, wrap } = require('../utils/respond');
const { paginate } = require('../utils/sql');
const audit = require('../utils/audit');

/** Builds list/get/create/update/remove (and setDefault where the model supports it) for a lookup table. */
function lookup(model, entity) {
  const api = {
    list: wrap(async (req, res) => {
      const { limit, offset } = paginate({ limit: req.query.limit || 200, page: req.query.page });
      ok(res, await model.list({ search: req.query.search, active: v.optBool(req.query.active), limit, offset }));
    }),
    get: wrap(async (req, res) => ok(res, await model.getById(v.id(req.params.id)))),
    create: wrap(async (req, res) => {
      const row = await model.create(req.body || {});
      await audit.record(req, 'create', entity, row.id, null, row);
      created(res, row);
    }),
    update: wrap(async (req, res) => {
      const id = v.id(req.params.id);
      const before = await model.getById(id);
      const row = await model.update(id, req.body || {});
      const keys = Object.keys(req.body || {});
      await audit.record(req, 'update', entity, id, audit.pick(before, keys), audit.pick(row, keys));
      ok(res, row);
    }),
    remove: wrap(async (req, res) => {
      const id = v.id(req.params.id);
      await model.remove(id); // fails with FOREIGN_KEY if something still uses it
      await audit.record(req, 'delete', entity, id);
      ok(res, { deleted: true });
    }),
  };
  if (model.setDefault) {
    api.setDefault = wrap(async (req, res) => {
      const row = await model.setDefault(v.id(req.params.id));
      await audit.record(req, 'set_default', entity, row.id);
      ok(res, row);
    });
  }
  return api;
}

module.exports = {
  categories: lookup(models.categories, 'category'),
  brands: lookup(models.brands, 'brand'),
  units: lookup(models.units, 'unit'),
  taxRates: lookup(models.taxRates, 'tax_rate'),
  customerGroups: lookup(models.customerGroups, 'customer_group'),
  locations: lookup(models.locations, 'location'),
  expenseCategories: lookup(models.expenseCategories, 'expense_category'),
};
