const models = require('../models');
const v = require('../utils/validate');
const { ok, created, wrap } = require('../utils/respond');
const { paginate } = require('../utils/sql');
const audit = require('../utils/audit');

exports.list = wrap(async (req, res) => {
  const { limit, offset } = paginate(req.query);
  const q = req.query;
  ok(res, await models.expenses.list({ from: v.optDate(q.from, 'from'), to: v.optDate(q.to, 'to'), category_id: v.optId(q.category_id, 'category_id'), limit, offset }));
});

exports.create = wrap(async (req, res) => {
  const b = req.body || {};
  v.required(b, ['category_id', 'amount']);
  const row = await models.expenses.create({
    category_id: v.id(b.category_id, 'category_id'), amount: v.num(b.amount, 'amount', { min: 0.01 }),
    expense_date: v.optDate(b.expense_date, 'expense_date'), method: b.method ? v.oneOf(b.method, 'method', ['cash', 'mpesa', 'card', 'bank_transfer']) : undefined,
    reference: b.reference, description: b.description, receipt_url: b.receipt_url, recorded_by: req.user.id,
  });
  created(res, row);
});

exports.remove = wrap(async (req, res) => {
  const id = v.id(req.params.id);
  await models.expenses.remove(id);
  await audit.record(req, 'delete', 'expense', id);
  ok(res, { deleted: true });
});

exports.summary = wrap(async (req, res) => ok(res, await models.expenses.summaryByCategory({ from: v.optDate(req.query.from, 'from'), to: v.optDate(req.query.to, 'to') })));
