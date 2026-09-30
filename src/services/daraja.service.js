const { AppError } = require('../utils/errors');

/**
 * Thin client for Safaricom Daraja (STK push + STK query).
 * Uses Node's built-in fetch (Node 18+).
 */
const base = () => (process.env.MPESA_ENV === 'production' ? 'https://api.safaricom.co.ke' : 'https://sandbox.safaricom.co.ke');

function need(name) {
  const v = process.env[name];
  if (!v) throw new AppError(`M-Pesa is not configured (missing ${name})`, 503, 'MPESA_NOT_CONFIGURED');
  return v;
}

let cached = { token: null, expiresAt: 0 };

async function getToken() {
  if (cached.token && Date.now() < cached.expiresAt) return cached.token;
  const auth = Buffer.from(`${need('MPESA_CONSUMER_KEY')}:${need('MPESA_CONSUMER_SECRET')}`).toString('base64');
  const res = await fetch(`${base()}/oauth/v1/generate?grant_type=client_credentials`, { headers: { Authorization: `Basic ${auth}` } });
  if (!res.ok) throw new AppError('Could not authenticate with M-Pesa', 502, 'MPESA_AUTH_FAILED');
  const json = await res.json();
  cached = { token: json.access_token, expiresAt: Date.now() + (Number(json.expires_in) - 60) * 1000 };
  return cached.token;
}

/** yyyymmddHHMMSS in East Africa Time (UTC+3, no daylight saving). */
const timestamp = () => new Date(Date.now() + 3 * 3600 * 1000).toISOString().replace(/\D/g, '').slice(0, 14);

async function call(path, body) {
  const token = await getToken();
  const res = await fetch(`${base()}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new AppError(json.errorMessage || json.ResponseDescription || 'M-Pesa request failed', 502, 'MPESA_ERROR', json);
  }
  return json;
}

/** phone must be 2547XXXXXXXX (no "+"). Amount must be a whole number of shillings. */
async function stkPush({ phone, amount, accountReference, description }) {
  const shortcode = need('MPESA_SHORTCODE');
  const ts = timestamp();
  const password = Buffer.from(`${shortcode}${need('MPESA_PASSKEY')}${ts}`).toString('base64');
  const callbackBase = need('MPESA_CALLBACK_BASE_URL').replace(/\/$/, '');
  return call('/mpesa/stkpush/v1/processrequest', {
    BusinessShortCode: shortcode,
    Password: password,
    Timestamp: ts,
    TransactionType: process.env.MPESA_TRANSACTION_TYPE || 'CustomerPayBillOnline',
    Amount: amount,
    PartyA: phone,
    PartyB: process.env.MPESA_PARTY_B || shortcode,
    PhoneNumber: phone,
    CallBackURL: `${callbackBase}/api/v1/mpesa/callback/${need('MPESA_CALLBACK_SECRET')}`,
    AccountReference: String(accountReference || 'Hassdent').slice(0, 12),
    TransactionDesc: String(description || 'Payment').slice(0, 13),
  });
}

async function stkQuery(checkoutRequestId) {
  const shortcode = need('MPESA_SHORTCODE');
  const ts = timestamp();
  const password = Buffer.from(`${shortcode}${need('MPESA_PASSKEY')}${ts}`).toString('base64');
  return call('/mpesa/stkpushquery/v1/query', {
    BusinessShortCode: shortcode, Password: password, Timestamp: ts, CheckoutRequestID: checkoutRequestId,
  });
}

module.exports = { stkPush, stkQuery };
