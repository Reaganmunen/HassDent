const models = require('../models');
const v = require('../utils/validate');
const { ok, created, paged, wrap } = require('../utils/respond');
const { paginate } = require('../utils/sql');
const audit = require('../utils/audit');

exports.list = wrap(async (req, res) => {
  const page = paginate(req.query);
  const r = await models.customers.list({
    search: req.query.search, frequent: v.optBool(req.query.frequent), group_id: v.optId(req.query.group_id, 'group_id'), ...page,
  });
  paged(res, r.items, r.total, page);
});

/** The counter search box: part of a phone number (0712…, 712…, 254712…) or part of a name. */
exports.quickSearch = wrap(async (req, res) => {
  v.required(req.query, ['q']);
  ok(res, await models.customers.quickSearch(String(req.query.q), { limit: v.optInt(req.query.limit, 'limit', { min: 1, max: 25 }) || 10 }));
});

exports.get = wrap(async (req, res) => ok(res, await models.customers.getById(v.id(req.params.id))));

exports.findByPhone = wrap(async (req, res) => {
  v.required(req.query, ['phone']);
  const customer = await models.customers.findByPhone(String(req.query.phone));
  ok(res, customer); // null when the number isn't saved yet
});

exports.create = wrap(async (req, res) => {
  const b = req.body || {};
  v.required(b, ['full_name']);
  const customer = await models.customers.create({ ...b, created_by: req.user.id });
  await audit.record(req, 'create', 'customer', customer.id, null, { full_name: customer.full_name, phone: customer.phone });
  created(res, customer);
});

exports.update = wrap(async (req, res) => {
  const id = v.id(req.params.id);
  const b = req.body || {};
  v.optNum(b.credit_limit, 'credit_limit', { min: 0 });
  const before = await models.customers.getById(id);
  const customer = await models.customers.update(id, b);
  const keys = Object.keys(b);
  await audit.record(req, 'update', 'customer', id, audit.pick(before, keys), audit.pick(customer, keys));
  ok(res, customer);
});

exports.deactivate = wrap(async (req, res) => {
  const id = v.id(req.params.id);
  await models.customers.deactivate(id);
  await audit.record(req, 'deactivate', 'customer', id);
  ok(res, { deactivated: true });
});

// ---- notes ----
exports.listNotes = wrap(async (req, res) => ok(res, await models.customers.listNotes(v.id(req.params.id))));

exports.addNote = wrap(async (req, res) => {
  const b = req.body || {};
  v.required(b, ['note']);
  created(res, await models.customers.addNote({
    customer_id: v.id(req.params.id), note: v.str(b.note, 'note', { max: 1000 }),
    show_on_checkin: Boolean(b.show_on_checkin), created_by: req.user.id,
  }));
});

exports.resolveNote = wrap(async (req, res) => {
  await models.customers.resolveNote(v.id(req.params.noteId, 'noteId'));
  ok(res, { resolved: true });
});

exports.deleteNote = wrap(async (req, res) => {
  await models.customers.deleteNote(v.id(req.params.noteId, 'noteId'));
  ok(res, { deleted: true });
});

// ---- visits / check-in ----
/** Customer walked in: logs the visit and returns alerts, "usually buys", recent purchases and balance owed. */
exports.checkIn = wrap(async (req, res) => {
  const b = req.body || {};
  ok(res, await models.customers.checkIn({
    customer_id: v.id(req.params.id), purpose: b.purpose, notes: b.notes, served_by: req.user.id,
  }));
});

exports.visits = wrap(async (req, res) => ok(res, await models.customers.visits(v.id(req.params.id), v.optInt(req.query.limit, 'limit', { min: 1, max: 100 }) || 20)));
exports.topProducts = wrap(async (req, res) => ok(res, await models.customers.topProducts(v.id(req.params.id), v.optInt(req.query.limit, 'limit', { min: 1, max: 50 }) || 5)));

exports.purchases = wrap(async (req, res) => {
  const { limit, offset } = paginate(req.query);
  ok(res, await models.customers.purchases(v.id(req.params.id), { limit, offset }));
});

// ---- loyalty ----
exports.loyaltyHistory = wrap(async (req, res) => ok(res, await models.customers.loyaltyHistory(v.id(req.params.id), v.optInt(req.query.limit, 'limit', { min: 1, max: 200 }) || 50)));

exports.loyaltyAdjust = wrap(async (req, res) => {
  const b = req.body || {};
  v.required(b, ['points', 'note']);
  const points = v.int(b.points, 'points');
  if (points === 0) throw require('../utils/validate').bad('points cannot be zero');
  const row = await models.customers.loyaltyAdjust({
    customer_id: v.id(req.params.id), points, note: v.str(b.note, 'note', { max: 300 }), created_by: req.user.id,
  });
  await audit.record(req, 'loyalty_adjust', 'customer', row.customer_id, null, { points, note: b.note });
  created(res, row);
});
