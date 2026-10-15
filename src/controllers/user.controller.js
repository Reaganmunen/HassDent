const models = require('../models');
const svc = require('../services/auth.service');
const v = require('../utils/validate');
const { AppError } = require('../utils/errors');
const { ok, created, paged, wrap } = require('../utils/respond');
const { paginate } = require('../utils/sql');
const audit = require('../utils/audit');

exports.list = wrap(async (req, res) => {
  const page = paginate(req.query);
  ok(res, await models.users.list({ active: v.optBool(req.query.active), ...page }));
});

exports.get = wrap(async (req, res) => ok(res, await models.users.findById(v.id(req.params.id))));

exports.create = wrap(async (req, res) => {
  const b = req.body || {};
  v.required(b, ['name', 'email', 'password', 'role_id']);
  svc.validatePasswordStrength(b.password);
  const user = await models.users.create({
    name: v.str(b.name, 'name', { max: 100 }), email: v.str(b.email, 'email', { max: 150 }), phone: b.phone,
    role_id: v.id(b.role_id, 'role_id'), password_hash: await svc.hashPassword(b.password),
  });
  await audit.record(req, 'create', 'user', user.id, null, { email: user.email, role: user.role });
  created(res, user);
});

exports.update = wrap(async (req, res) => {
  const id = v.id(req.params.id);
  const b = req.body || {};
  const data = {};
  if (b.name !== undefined) data.name = v.str(b.name, 'name', { max: 100 });
  if (b.email !== undefined) data.email = v.str(b.email, 'email', { max: 150 });
  if (b.phone !== undefined) data.phone = b.phone;
  if (b.role_id !== undefined) data.role_id = v.id(b.role_id, 'role_id');
  if (b.is_active !== undefined) data.is_active = Boolean(b.is_active);
  if (b.password !== undefined) { svc.validatePasswordStrength(b.password); data.password_hash = await svc.hashPassword(b.password); }

  // Guard against locking yourself out.
  if (id === req.user.id && (data.is_active === false || (data.role_id !== undefined && data.role_id !== req.user.role_id))) {
    throw new AppError('You cannot deactivate or change the role of your own account', 400, 'SELF_LOCKOUT');
  }
  const before = await models.users.findById(id);
  const user = await models.users.update(id, data);
  if (data.is_active === false || data.password_hash) await models.users.revokeUserTokens(id, 'refresh');
  await audit.record(req, 'update', 'user', id,
    audit.pick(before, ['name', 'email', 'phone', 'role_id', 'is_active']),
    { ...audit.pick(user, ['name', 'email', 'phone', 'role_id', 'is_active']), ...(data.password_hash ? { password: 'changed' } : {}) });
  ok(res, user);
});

exports.roles = wrap(async (req, res) => ok(res, await models.users.listRoles()));
exports.permissions = wrap(async (req, res) => ok(res, await models.users.listPermissions()));
