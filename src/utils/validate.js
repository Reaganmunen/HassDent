const { AppError } = require('./errors');

const bad = (message, details) => new AppError(message, 400, 'VALIDATION_ERROR', details);
const isBlank = (x) => x === undefined || x === null || x === '';
const asNumber = (v) => (typeof v === 'string' && v.trim() !== '' ? Number(v) : v);

function required(obj, fields) {
  const missing = fields.filter((f) => isBlank(obj && obj[f]));
  if (missing.length) throw bad(`Missing required field(s): ${missing.join(', ')}`, { missing });
}

function int(v, name, { min, max } = {}) {
  const n = asNumber(v);
  if (!Number.isInteger(n)) throw bad(`${name} must be a whole number`);
  if (min !== undefined && n < min) throw bad(`${name} must be at least ${min}`);
  if (max !== undefined && n > max) throw bad(`${name} must be at most ${max}`);
  return n;
}

function num(v, name, { min, max } = {}) {
  const n = asNumber(v);
  if (typeof n !== 'number' || !Number.isFinite(n)) throw bad(`${name} must be a number`);
  if (min !== undefined && n < min) throw bad(`${name} must be at least ${min}`);
  if (max !== undefined && n > max) throw bad(`${name} must be at most ${max}`);
  return n;
}

const id = (v, name = 'id') => int(v, name, { min: 1 });
const optId = (v, name) => (isBlank(v) ? undefined : id(v, name));
const optInt = (v, name, o) => (isBlank(v) ? undefined : int(v, name, o));
const optNum = (v, name, o) => (isBlank(v) ? undefined : num(v, name, o));

function str(v, name, { min = 1, max = 500 } = {}) {
  if (typeof v !== 'string') throw bad(`${name} must be text`);
  const s = v.trim();
  if (s.length < min) throw bad(`${name} is required`);
  if (s.length > max) throw bad(`${name} is too long (max ${max} characters)`);
  return s;
}

function oneOf(v, name, list) {
  if (!list.includes(v)) throw bad(`${name} must be one of: ${list.join(', ')}`);
  return v;
}

function array(v, name, { min = 1 } = {}) {
  if (!Array.isArray(v) || v.length < min) throw bad(`${name} must be a list with at least ${min} item(s)`);
  return v;
}

function date(v, name) {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(v))) {
    throw bad(`${name} must be a date in YYYY-MM-DD format`);
  }
  return v;
}
const optDate = (v, name) => (isBlank(v) ? undefined : date(v, name));

/** For query strings: 'true'/'1' -> true, 'false'/'0' -> false, missing -> undefined. */
function optBool(v) {
  if (v === undefined || v === '') return undefined;
  if (v === true || v === 'true' || v === '1') return true;
  if (v === false || v === 'false' || v === '0') return false;
  throw bad('Expected true or false');
}

module.exports = { bad, required, int, num, id, optId, optInt, optNum, str, oneOf, array, date, optDate, optBool, isBlank };
