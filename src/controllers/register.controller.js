const models = require('../models');
const v = require('../utils/validate');
const { AppError } = require('../utils/errors');
const { hasPermission } = require('../middleware/auth');
const { ok, created, wrap } = require('../utils/respond');
const audit = require('../utils/audit');

exports.open = wrap(async (req, res) => {
  const b = req.body || {};
  const session = await models.registers.open({ opened_by: req.user.id, opening_float: v.optNum(b.opening_float, 'opening_float', { min: 0 }) || 0 });
  created(res, session);
});

/** The signed-in cashier's open session, or null. */
exports.current = wrap(async (req, res) => ok(res, await models.registers.getOpen(req.user.id)));

exports.summary = wrap(async (req, res) => ok(res, await models.registers.summary(v.id(req.params.id))));

/** Only the person who opened the till (or someone who can view reports) may close it. */
exports.close = wrap(async (req, res) => {
  const id = v.id(req.params.id);
  const b = req.body || {};
  v.required(b, ['counted_cash']);
  const { session } = await models.registers.summary(id);
  if (session.opened_by !== req.user.id && !hasPermission(req.user, 'reports.view')) {
    throw new AppError('Only the cashier who opened this till can close it', 403, 'FORBIDDEN');
  }
  const closed = await models.registers.close({ id, closed_by: req.user.id, counted_cash: v.num(b.counted_cash, 'counted_cash', { min: 0 }), notes: b.notes });
  await audit.record(req, 'close_register', 'cash_register_session', id, null, { expected_cash: closed.expected_cash, counted_cash: closed.counted_cash, variance: closed.variance });
  ok(res, closed);
});

exports.list = wrap(async (req, res) => ok(res, await models.registers.list({ limit: v.optInt(req.query.limit, 'limit', { min: 1, max: 100 }) || 30 })));
