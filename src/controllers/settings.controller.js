const models = require('../models');
const v = require('../utils/validate');
const { ok, wrap } = require('../utils/respond');
const audit = require('../utils/audit');

exports.get = wrap(async (req, res) => ok(res, await models.settings.get()));

exports.update = wrap(async (req, res) => {
  const b = req.body || {};
  if (b.loyalty_points_per_kes !== undefined) v.num(b.loyalty_points_per_kes, 'loyalty_points_per_kes', { min: 0 });
  if (b.loyalty_kes_per_point !== undefined) v.num(b.loyalty_kes_per_point, 'loyalty_kes_per_point', { min: 0 });
  if (b.frequent_customer_min_visits !== undefined) v.int(b.frequent_customer_min_visits, 'frequent_customer_min_visits', { min: 1 });
  if (b.expiry_alert_days !== undefined) v.int(b.expiry_alert_days, 'expiry_alert_days', { min: 1 });
  const before = await models.settings.get();
  const after = await models.settings.update(b);
  const keys = Object.keys(b);
  await audit.record(req, 'update', 'settings', 1, audit.pick(before, keys), audit.pick(after, keys));
  ok(res, after);
});
