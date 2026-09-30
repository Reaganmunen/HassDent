const models = require('../models');
const svc = require('../services/auth.service');
const v = require('../utils/validate');
const { AppError } = require('../utils/errors');
const { ok, created, wrap } = require('../utils/respond');
const audit = require('../utils/audit');

const stripHash = ({ password_hash, ...rest }) => rest;

/** One-time bootstrap: creates the first admin. Refuses once any user exists. */
exports.setup = wrap(async (req, res) => {
  const b = req.body || {};
  v.required(b, ['name', 'email', 'password']);
  svc.validatePasswordStrength(b.password);
  const existing = await models.users.list({ limit: 1 });
  if (existing.length) throw new AppError('Setup has already been completed', 403, 'SETUP_DONE');
  const adminRole = (await models.users.listRoles()).find((r) => r.name === 'admin');
  const user = await models.users.create({
    name: v.str(b.name, 'name', { max: 100 }), email: v.str(b.email, 'email', { max: 150 }),
    phone: b.phone, password_hash: await svc.hashPassword(b.password), role_id: adminRole.id,
  });
  created(res, user);
});

exports.login = wrap(async (req, res) => {
  const b = req.body || {};
  v.required(b, ['email', 'password']);
  const user = await models.users.findByEmail(String(b.email));
  const passwordOk = await svc.verifyPassword(String(b.password), user && user.password_hash);
  if (!user || !passwordOk) throw new AppError('Invalid email or password', 401, 'INVALID_CREDENTIALS');
  if (!user.is_active) throw new AppError('This account has been disabled', 403, 'ACCOUNT_DISABLED');

  await models.users.touchLastLogin(user.id);
  const session = await svc.issueSession(user);
  await audit.record({ user, ip: req.ip }, 'login', 'user', user.id);
  ok(res, { ...session, user: stripHash(user) });
});

/** Refresh tokens are single-use: each refresh returns a NEW refresh token and burns the old one. */
exports.refresh = wrap(async (req, res) => {
  const b = req.body || {};
  v.required(b, ['refresh_token']);
  const row = await models.users.findValidToken(svc.sha256(String(b.refresh_token)), 'refresh');
  if (!row) throw new AppError('Session expired, please log in again', 401, 'REFRESH_INVALID');
  await models.users.markTokenUsed(row.id);
  const user = await models.users.findById(row.user_id);
  if (!user.is_active) throw new AppError('This account has been disabled', 403, 'ACCOUNT_DISABLED');
  ok(res, await svc.issueSession(user));
});

exports.logout = wrap(async (req, res) => {
  const b = req.body || {};
  if (b.all === true) {
    await models.users.revokeUserTokens(req.user.id, 'refresh');
  } else if (b.refresh_token) {
    const row = await models.users.findValidToken(svc.sha256(String(b.refresh_token)), 'refresh');
    if (row && row.user_id === req.user.id) await models.users.markTokenUsed(row.id);
  }
  ok(res, { logged_out: true });
});

exports.me = wrap(async (req, res) => ok(res, req.user));

exports.changePassword = wrap(async (req, res) => {
  const b = req.body || {};
  v.required(b, ['current_password', 'new_password']);
  svc.validatePasswordStrength(b.new_password);
  const withHash = await models.users.findByEmail(req.user.email);
  if (!(await svc.verifyPassword(String(b.current_password), withHash.password_hash))) {
    throw new AppError('Current password is incorrect', 400, 'WRONG_PASSWORD');
  }
  await models.users.update(req.user.id, { password_hash: await svc.hashPassword(b.new_password) });
  await models.users.revokeUserTokens(req.user.id, 'refresh'); // log out every other device
  await audit.record(req, 'change_password', 'user', req.user.id);
  ok(res, { changed: true });
});

/**
 * Always answers the same way so the endpoint can't be used to discover which emails have accounts.
 * Sending the email is NOT implemented yet: in development the reset token is printed to the server console.
 */
exports.forgotPassword = wrap(async (req, res) => {
  const b = req.body || {};
  v.required(b, ['email']);
  const user = await models.users.findByEmail(String(b.email));
  if (user && user.is_active) {
    const { token, hash } = svc.generateOpaqueToken();
    await models.users.saveToken({ user_id: user.id, type: 'password_reset', token_hash: hash, expires_at: svc.minutesFromNow(60) });
    if (process.env.NODE_ENV !== 'production') console.log(`[dev] password reset token for ${user.email}: ${token}`);
    // TODO: send `token` to user.email (nodemailer) as a link to your frontend reset page.
  }
  ok(res, { message: 'If that email has an account, a reset link has been sent.' });
});

exports.resetPassword = wrap(async (req, res) => {
  const b = req.body || {};
  v.required(b, ['token', 'new_password']);
  svc.validatePasswordStrength(b.new_password);
  const row = await models.users.findValidToken(svc.sha256(String(b.token)), 'password_reset');
  if (!row) throw new AppError('This reset link is invalid or has expired', 400, 'RESET_INVALID');
  await models.users.update(row.user_id, { password_hash: await svc.hashPassword(b.new_password) });
  await models.users.markTokenUsed(row.id);
  await models.users.revokeUserTokens(row.user_id, 'refresh');
  ok(res, { reset: true });
});
