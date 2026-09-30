const { query, withTransaction } = require('../config/db');
const { AppError, notFound } = require('../utils/errors');
const { normalisePhone } = require('../utils/phone');
const { toCents, fromCents } = require('../utils/money');

/**
 * M-PESA (Safaricom Daraja)
 *   STK push flow : createPending() when you fire the push -> handleStkCallback() from the callback URL.
 *   Till/Paybill  : recordC2B() from the C2B confirmation URL -> attachToSale() when staff match it.
 * Phones are stored as +2547XXXXXXXX; strip the "+" when you call Daraja.
 */

async function createPending({ sale_id, phone, amount, account_reference, merchant_request_id, checkout_request_id }, db) {
  const { rows: [row] } = await query(
    `INSERT INTO mpesa_transactions (sale_id, transaction_type, phone, amount, account_reference, merchant_request_id, checkout_request_id)
     VALUES ($1,'stk_push',$2,$3,$4,$5,$6) RETURNING *`,
    [sale_id || null, normalisePhone(phone), amount, account_reference || null, merchant_request_id || null, checkout_request_id || null], db);
  return row;
}

/** Daraja's callback -> plain object. TransactionDate arrives as yyyymmddHHMMSS in East Africa Time. */
function parseStkCallback(body) {
  const cb = body && body.Body && body.Body.stkCallback;
  if (!cb) throw new AppError('Malformed M-Pesa callback', 400, 'BAD_CALLBACK');
  const meta = {};
  for (const it of (cb.CallbackMetadata && cb.CallbackMetadata.Item) || []) meta[it.Name] = it.Value;
  let transaction_date = null;
  const d = meta.TransactionDate && String(meta.TransactionDate);
  if (d && /^\d{14}$/.test(d)) {
    transaction_date = `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}T${d.slice(8, 10)}:${d.slice(10, 12)}:${d.slice(12, 14)}+03:00`;
  }
  return {
    merchant_request_id: cb.MerchantRequestID, checkout_request_id: cb.CheckoutRequestID,
    result_code: Number(cb.ResultCode), result_desc: cb.ResultDesc,
    amount: meta.Amount, mpesa_receipt_number: meta.MpesaReceiptNumber, phone: meta.PhoneNumber, transaction_date,
  };
}

const statusFor = (code) => (code === 0 ? 'success' : code === 1032 ? 'cancelled' : code === 1037 ? 'timeout' : 'failed');

/**
 * Handles the STK callback. Safe to call twice (Safaricom retries): a finished transaction is ignored.
 * On success the pending payment on the sale is completed (or created if none was pre-registered).
 */
async function handleStkCallback(body, db) {
  const cb = parseStkCallback(body);
  const run = db ? (fn) => fn(db) : withTransaction;
  return run(async (c) => {
    const { rows: [tx] } = await query('SELECT * FROM mpesa_transactions WHERE checkout_request_id = $1 FOR UPDATE', [cb.checkout_request_id], c);
    if (!tx) return { ignored: true };
    if (tx.status !== 'pending') return { duplicate: true, transaction: tx };

    const status = statusFor(cb.result_code);
    const { rows: [updated] } = await query(
      `UPDATE mpesa_transactions SET status = $2, result_code = $3, result_desc = $4,
              mpesa_receipt_number = COALESCE($5, mpesa_receipt_number), transaction_date = COALESCE($6, transaction_date),
              amount = COALESCE($7, amount), raw_callback = $8 WHERE id = $1 RETURNING *`,
      [tx.id, status, cb.result_code, cb.result_desc, cb.mpesa_receipt_number || null, cb.transaction_date, cb.amount ?? null, JSON.stringify(body)], c);

    if (status === 'success') {
      const { rowCount } = await query(
        `UPDATE payments SET status = 'completed', reference = $2, amount = $3 WHERE mpesa_transaction_id = $1 AND status = 'pending'`,
        [tx.id, cb.mpesa_receipt_number, updated.amount], c);
      if (!rowCount && tx.sale_id) {
        await query(`INSERT INTO payments (sale_id, method, amount, reference, mpesa_transaction_id, status) VALUES ($1,'mpesa',$2,$3,$4,'completed')`,
          [tx.sale_id, updated.amount, cb.mpesa_receipt_number, tx.id], c);
      }
    } else {
      await query(`UPDATE payments SET status = 'failed' WHERE mpesa_transaction_id = $1 AND status = 'pending'`, [tx.id], c);
    }
    return { transaction: updated };
  });
}

/** Till/Paybill payment notification. The unique receipt number makes retries harmless. */
async function recordC2B({ phone, amount, mpesa_receipt_number, account_reference, transaction_date, raw }, db) {
  const { rows: [row] } = await query(
    `INSERT INTO mpesa_transactions (transaction_type, phone, amount, account_reference, mpesa_receipt_number, status, transaction_date, raw_callback)
     VALUES ('c2b',$1,$2,$3,$4,'success',$5,$6) ON CONFLICT (mpesa_receipt_number) DO NOTHING RETURNING *`,
    [normalisePhone(phone), amount, account_reference || null, mpesa_receipt_number, transaction_date || null, raw ? JSON.stringify(raw) : null], db);
  return row || null; // null = duplicate notification
}

/** Match an unassigned C2B payment to a sale and record it as that sale's M-Pesa payment. */
async function attachToSale({ mpesa_id, sale_id, received_by }, db) {
  const run = db ? (fn) => fn(db) : withTransaction;
  return run(async (c) => {
    const { rows: [tx] } = await query('SELECT * FROM mpesa_transactions WHERE id = $1 FOR UPDATE', [mpesa_id], c);
    if (!tx) throw notFound('M-Pesa transaction');
    if (tx.status !== 'success') throw new AppError('Only successful M-Pesa payments can be attached', 409, 'INVALID_STATE');
    if (tx.sale_id) throw new AppError('This M-Pesa payment is already attached to a sale', 409, 'ALREADY_ATTACHED');
    const { rows: [sale] } = await query('SELECT total, amount_paid, status FROM sales WHERE id = $1 FOR UPDATE', [sale_id], c);
    if (!sale) throw notFound('Sale');
    if (sale.status !== 'completed') throw new AppError('Sale is not completed', 409, 'INVALID_STATE');
    if (toCents(tx.amount) > toCents(sale.total) - toCents(sale.amount_paid)) {
      throw new AppError(`M-Pesa amount exceeds the sale balance (KES ${fromCents(toCents(sale.total) - toCents(sale.amount_paid))})`, 422, 'OVERPAYMENT');
    }
    await query('UPDATE mpesa_transactions SET sale_id = $2 WHERE id = $1', [mpesa_id, sale_id], c);
    await query(`INSERT INTO payments (sale_id, method, amount, reference, mpesa_transaction_id, received_by) VALUES ($1,'mpesa',$2,$3,$4,$5)`,
      [sale_id, tx.amount, tx.mpesa_receipt_number, mpesa_id, received_by || null], c);
    return true;
  });
}

const getById = async (id, db) => {
  const { rows: [r] } = await query('SELECT * FROM mpesa_transactions WHERE id = $1', [id], db);
  if (!r) throw notFound('M-Pesa transaction');
  return r;
};
const getByCheckoutId = async (id, db) => (await query('SELECT * FROM mpesa_transactions WHERE checkout_request_id = $1', [id], db)).rows[0] || null;
const listUnmatched = async (db) => (await query(
  `SELECT * FROM mpesa_transactions WHERE status = 'success' AND sale_id IS NULL ORDER BY created_at DESC`, [], db)).rows;

module.exports = { createPending, parseStkCallback, handleStkCallback, recordC2B, attachToSale, getById, getByCheckoutId, listUnmatched };
