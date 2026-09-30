const models = require('../models');
const v = require('../utils/validate');
const { ok, wrap } = require('../utils/respond');

/** ?from=YYYY-MM-DD&to=YYYY-MM-DD (both optional, inclusive, Nairobi calendar days). */
function range(req) {
  const from = v.optDate(req.query.from, 'from');
  const to = v.optDate(req.query.to, 'to');
  if (from && to && from > to) throw v.bad('"from" must not be after "to"');
  return { from, to };
}

exports.dashboard = wrap(async (req, res) => ok(res, await models.reports.dashboard()));
exports.salesSummary = wrap(async (req, res) => ok(res, await models.reports.salesSummary(range(req))));
exports.salesByDay = wrap(async (req, res) => ok(res, await models.reports.salesByDay(range(req))));
exports.paymentBreakdown = wrap(async (req, res) => ok(res, await models.reports.paymentBreakdown(range(req))));
exports.profitAndLoss = wrap(async (req, res) => ok(res, await models.reports.profitAndLoss(range(req))));

exports.topProducts = wrap(async (req, res) => ok(res, await models.reports.topProducts({
  ...range(req), by: req.query.by === 'quantity' ? 'quantity' : 'revenue', limit: v.optInt(req.query.limit, 'limit', { min: 1, max: 100 }) || 10,
})));

exports.topCustomers = wrap(async (req, res) => ok(res, await models.reports.topCustomers({ limit: v.optInt(req.query.limit, 'limit', { min: 1, max: 100 }) || 10 })));
