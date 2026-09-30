const models = require('../models');
const v = require('../utils/validate');
const { ok, wrap } = require('../utils/respond');
const { paginate } = require('../utils/sql');

exports.list = wrap(async (req, res) => {
  const { limit, offset } = paginate(req.query);
  ok(res, await models.audit.list({
    entity_type: req.query.entity_type, entity_id: v.optId(req.query.entity_id, 'entity_id'), user_id: v.optId(req.query.user_id, 'user_id'), limit, offset,
  }));
});
