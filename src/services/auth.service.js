const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const models = require('../models');
const { AppError } = require('../utils/errors');

const BCRYPT_ROUNDS = 12;
// Compared against when the email is unknown, so "no such user" takes as long as "wrong password".
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', BCRYPT_ROUNDS);

function secret() {
  const s = process.env.JWT_SECRET;
  if (!s || s.length < 32) throw new Error('JWT_SECRET must be set to a random string of at least 32 characters');
  return s;
}

/** Called once at startup so a missing secret fails fast instead of on the first login. */
const assertConfig = () => { secret(); };

const hashPassword = (plain) => bcrypt.hash(plain, BCRYPT_ROUNDS);
const verifyPassword = (plain, hash) => bcrypt.compare(plain, hash || DUMMY_HASH);
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function validatePasswordStrength(pw) {
  if (typeof pw !== 'string' || pw.length < 8) throw new AppError('Password must be at least 8 characters', 400, 'WEAK_PASSWORD');
  if (pw.length > 72) throw new AppError('Password must be at most 72 characters', 400, 'WEAK_PASSWORD'); // bcrypt limit
}

const signAccessToken = (user) =>
  jwt.sign({ sub: user.id, role: user.role }, secret(), { expiresIn: process.env.JWT_EXPIRES_IN || '15m' });

function verifyAccessToken(token) {
  return jwt.verify(token, secret());
}

/** Opaque random token; only its SHA-256 hash is stored, so a DB leak can't be replayed. */
function generateOpaqueToken() {
  const token = crypto.randomBytes(48).toString('hex');
  return { token, hash: sha256(token) };
}

const daysFromNow = (d) => new Date(Date.now() + d * 864e5);
const minutesFromNow = (m) => new Date(Date.now() + m * 6e4);

/** New login session: short-lived access token + rotating refresh token. */
async function issueSession(user) {
  const { token, hash } = generateOpaqueToken();
  await models.users.saveToken({
    user_id: user.id, type: 'refresh', token_hash: hash,
    expires_at: daysFromNow(Number(process.env.REFRESH_TOKEN_DAYS || 30)),
  });
  return {
    access_token: signAccessToken(user),
    refresh_token: token,
    token_type: 'Bearer',
    expires_in: process.env.JWT_EXPIRES_IN || '15m',
  };
}

module.exports = { assertConfig, hashPassword, verifyPassword, validatePasswordStrength, sha256,
  signAccessToken, verifyAccessToken, generateOpaqueToken, issueSession, daysFromNow, minutesFromNow };
