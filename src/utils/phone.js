const { AppError } = require('./errors');

/**
 * Normalise Kenyan numbers to +2547XXXXXXXX / +2541XXXXXXXX.
 * Accepts 0712345678, 712345678, 254712345678, +254 712 345 678, ...
 * Other international numbers are kept as +<digits>.
 * Returns null for empty input; throws AppError for garbage.
 */
function normalisePhone(input) {
  if (input === undefined || input === null) return null;
  let p = String(input).replace(/[\s\-().]/g, '');
  if (!p) return null;
  if (p.startsWith('+')) p = p.slice(1);
  if (/^0[17]\d{8}$/.test(p)) p = '254' + p.slice(1);
  else if (/^[17]\d{8}$/.test(p)) p = '254' + p;
  if (!/^\d{9,15}$/.test(p)) throw new AppError('Invalid phone number', 400, 'INVALID_PHONE');
  return '+' + p;
}

module.exports = { normalisePhone };
