const models = require('../models');
const v = require('../utils/validate');
const { ok, wrap } = require('../utils/respond');

exports.list = wrap(async (req, res) => ok(res, await models.notifications.listForUser(req.user.id, {
  unread_only: v.optBool(req.query.unread) === true, limit: v.optInt(req.query.limit, 'limit', { min: 1, max: 200 }) || 50,
})));

exports.markRead = wrap(async (req, res) => {
  await models.notifications.markRead(v.id(req.params.id));
  ok(res, { read: true });
});

exports.markAllRead = wrap(async (req, res) => {
  await models.notifications.markAllRead(req.user.id);
  ok(res, { read: true });
});

/** Creates low-stock and expiry alerts that don't already have an unread notification. Call on a schedule or at shop opening. */
exports.sync = wrap(async (req, res) => ok(res, await models.notifications.syncStockAlerts()));
