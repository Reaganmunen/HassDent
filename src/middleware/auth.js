const { AppError } = require('../utils/errors');
const { verifyAccessToken } = require('../services/auth.service');
const users = require('../models/user.model');

const unauthorised = (msg = 'Please log in to continue', code = 'UNAUTHORISED') => new AppError(msg, 401, code);

/**
 * Verifies the Bearer token, then loads the user fresh from the database on every request.
 * That means a deactivated user or a changed role takes effect immediately, not when the token expires.
 * Sets req.user = { id, name, email, role, permissions: [...] , ... }
 */
async function authenticate(req, res, next) {
  try {
    const [scheme, token] = (req.headers.authorization || '').split(' ');
    if (scheme !== 'Bearer' || !token) throw unauthorised();

    let payload;
    try { payload = verifyAccessToken(token); }
    catch (e) { throw unauthorised(e.name === 'TokenExpiredError' ? 'Session expired' : 'Invalid token', e.name === 'TokenExpiredError' ? 'TOKEN_EXPIRED' : 'TOKEN_INVALID'); }

    let user;
    try { user = await users.findById(payload.sub); }
    catch (e) { throw unauthorised('Invalid token', 'TOKEN_INVALID'); }
    if (!user.is_active) throw new AppError('This account has been disabled', 403, 'ACCOUNT_DISABLED');

    req.user = user;
    next();
  } catch (err) { next(err); }
}

/** Allow the request if the user holds AT LEAST ONE of the listed permissions. Use after authenticate. */
const can = (...perms) => (req, res, next) =>
  req.user && req.user.permissions.some((p) => perms.includes(p))
    ? next()
    : next(new AppError('You do not have permission to do this', 403, 'FORBIDDEN'));

const hasPermission = (user, perm) => Boolean(user && user.permissions.includes(perm));

module.exports = { authenticate, can, hasPermission };
