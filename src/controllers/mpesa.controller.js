const crypto = require('crypto');
const models = require('../models');
const daraja = require('../services/daraja.service');
const v = require('../utils/validate');
const { AppError } = require('../utils/errors');
const { normalisePhone } = require('../utils/phone');
const { ok, created, wrap } = require('../utils/respond');

const ACCEPT = { ResultCode: 0, ResultDesc: 'Accepted' };

/**
 * Safaricom cannot sign its requests, so the callback URLs contain a secret path segment
 * (MPESA_CALLBACK_SECRET). Anything without it is treated as if the route doesn't exist.
 */
function secretOk(req) {
  const expected = process.env.MPESA_CALLBACK_SECRET || '';
  const given = String(req.params.secret || '');
  if (!expected || given.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}
const hidden = (req) => new AppError(`No route for ${req.method} ${req.originalUrl}`, 404, 'ROUTE_NOT_FOUND');

/** Cashier presses "Pay with M-Pesa": sends the prompt to the customer's phone. */
exports.stkPush = wrap(async (req, res) => {
  const b = req.body || {};
  v.required(b, ['phone', 'amount']);
  const phone = normalisePhone(b.phone);
  const amount = Math.round(v.num(b.amount, 'amount', { min: 1 })); // Daraja only accepts whole shillings

  const resp = await daraja.stkPush({
    phone: phone.slice(1), // Daraja wants 2547XXXXXXXX without the "+"
    amount, accountReference: b.account_reference || 'Hassdent', description: b.description || 'Payment',
  });
  if (String(resp.ResponseCode) !== '0') {
    throw new AppError(resp.ResponseDescription || 'M-Pesa could not start the payment', 502, 'MPESA_ERROR', resp);
  }
  const tx = await models.mpesa.createPending({
    sale_id: v.optId(b.sale_id, 'sale_id'), phone, amount, account_reference: b.account_reference,
    merchant_request_id: resp.MerchantRequestID, checkout_request_id: resp.CheckoutRequestID,
  });
  created(res, { mpesa_transaction_id: tx.id, checkout_request_id: tx.checkout_request_id, customer_message: resp.CustomerMessage, status: tx.status });
});

/** The frontend polls this while the customer enters their PIN. Add ?query=1 to also ask Safaricom directly. */
exports.status = wrap(async (req, res) => {
  const tx = await models.mpesa.getByCheckoutId(String(req.params.checkoutRequestId));
  if (!tx) throw new AppError('M-Pesa transaction not found', 404, 'NOT_FOUND');
  const out = { id: tx.id, status: tx.status, amount: tx.amount, mpesa_receipt_number: tx.mpesa_receipt_number, result_desc: tx.result_desc, sale_id: tx.sale_id };
  if (req.query.query === '1' && tx.status === 'pending') out.safaricom = await daraja.stkQuery(tx.checkout_request_id);
  ok(res, out);
});

/** Public. Safaricom retries on failure, and handleStkCallback is idempotent, so always answer 200 once authenticated. */
exports.stkCallback = async (req, res, next) => {
  if (!secretOk(req)) return next(hidden(req));
  try {
    await models.mpesa.handleStkCallback(req.body);
  } catch (err) {
    console.error('[mpesa] callback processing failed:', err.message);
  }
  res.json(ACCEPT);
};

const c2bTime = (t) => {
  const d = String(t || '');
  return /^\d{14}$/.test(d) ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}T${d.slice(8, 10)}:${d.slice(10, 12)}:${d.slice(12, 14)}+03:00` : null;
};

/** Public. Accept every payment; we reconcile afterwards. */
exports.c2bValidation = (req, res, next) => (secretOk(req) ? res.json(ACCEPT) : next(hidden(req)));

/** Public. Till/Paybill payment notification -> stored as an unmatched payment for staff to attach to a sale. */
exports.c2bConfirmation = async (req, res, next) => {
  if (!secretOk(req)) return next(hidden(req));
  try {
    const b = req.body || {};
    let phone;
    try { phone = normalisePhone(b.MSISDN); }
    catch (e) { phone = '+254000000000'; } // Safaricom may send a hashed MSISDN; the full payload is kept in raw_callback
    await models.mpesa.recordC2B({
      phone, amount: b.TransAmount, mpesa_receipt_number: b.TransID, account_reference: b.BillRefNumber,
      transaction_date: c2bTime(b.TransTime), raw: b,
    });
  } catch (err) {
    console.error('[mpesa] C2B confirmation failed:', err.message);
  }
  res.json(ACCEPT);
};

exports.listUnmatched = wrap(async (req, res) => ok(res, await models.mpesa.listUnmatched()));

/** Staff match a Till/Paybill payment to a sale. Body: { sale_id } */
exports.attach = wrap(async (req, res) => {
  const b = req.body || {};
  v.required(b, ['sale_id']);
  await models.mpesa.attachToSale({ mpesa_id: v.id(req.params.id), sale_id: v.id(b.sale_id, 'sale_id'), received_by: req.user.id });
  ok(res, { attached: true });
});
