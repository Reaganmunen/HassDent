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
    name: v.str(b.name, 'name', { max: 100 }),
    email: v.str(b.email, 'email', { max: 150 }),
    phone: b.phone,
    role_id: v.id(b.role_id, 'role_id'),
    password_hash: await svc.hashPassword(b.password),
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
  if (b.password !== undefined) {
    svc.validatePasswordStrength(b.password);
    data.password_hash = await svc.hashPassword(b.password);
  }

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

exports.deactivate = wrap(async (req, res) => {
  const id = v.id(req.params.id);
  if (id === req.user.id) throw new AppError('You cannot deactivate your own account', 400, 'SELF_LOCKOUT');
  const before = await models.users.findById(id);
  const user = await models.users.update(id, { is_active: false });
  await models.users.revokeUserTokens(id, 'refresh');
  await audit.record(req, 'deactivate', 'user', id, { is_active: before.is_active }, { is_active: false });
  ok(res, user);
});

exports.roles = wrap(async (req, res) => ok(res, await models.users.listRoles()));
exports.permissions = wrap(async (req, res) => ok(res, await models.users.listPermissions()));

// ---- role CRUD ----
exports.createRole = wrap(async (req, res) => {
  const b = req.body || {};
  v.required(b, ['name']);
  const name = v.str(b.name, 'name', { max: 50 }).trim().toLowerCase().replace(/\s+/g, '_');
  if (!/^[a-z][a-z0-9_]*$/.test(name)) {
    throw new AppError('Role name must be lowercase letters, digits, underscores', 400, 'BAD_ROLE_NAME');
  }
  const permissions = Array.isArray(b.permissions) ? b.permissions : [];
  const role = await models.users.createRole({ name, description: b.description || null, permissions });
  await audit.record(req, 'create', 'role', role.id, null, { name: role.name, permissions });
  created(res, role);
});

exports.updateRole = wrap(async (req, res) => {
  const id = v.id(req.params.id, 'id');
  const b = req.body || {};
  const patch = {};
  if (b.name !== undefined) {
    const name = v.str(b.name, 'name', { max: 50 }).trim().toLowerCase().replace(/\s+/g, '_');
    if (!/^[a-z][a-z0-9_]*$/.test(name)) {
      throw new AppError('Role name must be lowercase letters, digits, underscores', 400, 'BAD_ROLE_NAME');
    }
    patch.name = name;
  }
  if (b.description !== undefined) patch.description = b.description;
  if (b.permissions !== undefined) patch.permissions = Array.isArray(b.permissions) ? b.permissions : [];

  const before = (await models.users.listRoles()).find((r) => r.id === id);
  if (!before) throw new AppError('Role not found', 404, 'NOT_FOUND');
  const after = await models.users.updateRole(id, patch);
  await audit.record(req, 'update', 'role', id,
    { name: before.name, permissions: before.permissions },
    { name: after.name, permissions: after.permissions });
  ok(res, after);
});

exports.deleteRole = wrap(async (req, res) => {
  const id = v.id(req.params.id, 'id');
  const okDel = await models.users.deleteRole(id);
  if (!okDel) throw new AppError('Role not found', 404, 'NOT_FOUND');
  await audit.record(req, 'delete', 'role', id);
  ok(res, { deleted: true });
});