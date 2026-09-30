// Integration tests: run against a REAL Postgres (the schema's triggers are part of what is tested).
//   DATABASE_URL=postgres://user:pass@localhost:5432/hassdent_test npm test
// The test DROPS and recreates the public schema, so point it at a throwaway database only.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { pool } = require('../src/config/db');
const m = require('../src/models');
const { normalisePhone } = require('../src/utils/phone');

const rejects = (p, code) => assert.rejects(p, (e) => { assert.equal(e.code, code, `expected ${code}, got ${e.code}: ${e.message}`); return true; });
const S = {}; // shared state between the ordered tests below

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await pool.query(fs.readFileSync(path.join(__dirname, '../db/schema.sql'), 'utf8'));
});
after(() => pool.end());

test('phone normalisation', () => {
  assert.equal(normalisePhone('0712 345 678'), '+254712345678');
  assert.equal(normalisePhone('712345678'), '+254712345678');
  assert.equal(normalisePhone('254712345678'), '+254712345678');
  assert.equal(normalisePhone('+254 112 345 678'.replace(/ /g, '')), '+254112345678');
  assert.equal(normalisePhone(''), null);
  assert.throws(() => normalisePhone('abc'), { code: 'INVALID_PHONE' });
});

test('users, roles and permissions', async () => {
  const roles = await m.users.listRoles();
  const admin = roles.find((r) => r.name === 'admin');
  const cashier = roles.find((r) => r.name === 'cashier');
  assert.ok(admin.permissions.includes('users.manage'));
  assert.ok(!cashier.permissions.includes('users.manage'));
  S.admin = await m.users.create({ name: 'Admin', email: 'Admin@Hassdent.co.ke', password_hash: 'x', role_id: admin.id });
  S.cashier = await m.users.create({ name: 'Cashier', email: 'cash@hassdent.co.ke', password_hash: 'x', role_id: cashier.id });
  assert.equal((await m.users.findByEmail('admin@hassdent.co.ke')).id, S.admin.id); // case-insensitive
  await rejects(m.users.create({ name: 'Dup', email: 'ADMIN@hassdent.co.ke', password_hash: 'x', role_id: admin.id }), 'DUPLICATE');
});

test('catalogue lookups + default flags', async () => {
  S.cat = await m.categories.create({ name: 'Consumables' });
  S.brand = await m.brands.create({ name: '3M' });
  const units = await m.units.list();
  S.unit = units.find((u) => u.name === 'Piece').id;
  const taxes = await m.taxRates.list();
  S.vat = taxes.find((t) => t.name === 'VAT 16%');
  S.zero = taxes.find((t) => t.name === 'Zero rated');
  const locs = await m.locations.list();
  S.shop = locs.find((l) => l.name === 'Shop Floor').id;
  S.store = locs.find((l) => l.name === 'Store Room').id;
  const moved = await m.taxRates.setDefault(S.zero.id);
  assert.equal(moved.is_default, true);
  await m.taxRates.setDefault(S.vat.id); // back
  assert.equal((await m.taxRates.list()).filter((t) => t.is_default).length, 1);
});

test('products: create, default tax, opening stock, search, price history', async () => {
  S.gloves = await m.products.create(
    { sku: 'GLV-M', barcode: '6001', name: 'Nitrile Gloves M', category_id: S.cat.id, brand_id: S.brand.id, unit_id: S.unit,
      cost_price: 100, selling_price: 200, reorder_level: 5 },
    { opening_stock: 10, location_id: S.shop, user_id: S.admin.id });
  assert.equal(S.gloves.tax_rate_id, S.vat.id);
  S.composite = await m.products.create(
    { sku: 'CMP-A2', name: 'Composite A2', unit_id: S.unit, cost_price: 500, selling_price: 900, tracks_expiry: true, min_price: 700 });
  await rejects(m.products.create({ sku: 'X', name: 'X', unit_id: S.unit, tracks_expiry: true }, { opening_stock: 5, location_id: S.shop }), 'BATCH_REQUIRED');
  await rejects(m.products.create({ sku: 'GLV-M', name: 'Dup', unit_id: S.unit }), 'DUPLICATE');

  const found = await m.products.posSearch('6001', { location_id: S.shop });
  assert.equal(found[0].name, 'Nitrile Gloves M');
  assert.equal(found[0].on_hand, 10);
  assert.equal((await m.products.list({ search: 'glov' })).total, 1);

  await m.products.update(S.gloves.id, { selling_price: 210 });
  assert.equal((await m.products.priceHistory(S.gloves.id)).length, 1);
  await m.products.update(S.gloves.id, { selling_price: 200 });
});

test('purchasing: PO -> receive with batches -> weighted average cost', async () => {
  S.supplier = await m.suppliers.create({ name: 'Dental Supplies Ltd', phone: '0700000000' });
  const po = await m.purchases.createPO({ supplier_id: S.supplier.id, created_by: S.admin.id, status: 'ordered',
    items: [{ product_id: S.composite.id, quantity: 10, unit_cost: 500, tax_rate: 16 }] });
  assert.equal(po.subtotal, '5000.00');
  assert.equal(po.total, '5800.00');

  // Expiry product without batch details must be refused.
  await rejects(m.purchases.receiveGoods({ purchase_order_id: po.id, location_id: S.shop, received_by: S.admin.id,
    items: [{ product_id: S.composite.id, quantity: 4, unit_cost: 500 }] }), 'BATCH_REQUIRED');

  const soon = new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10);
  const later = new Date(Date.now() + 365 * 864e5).toISOString().slice(0, 10);
  let grn = await m.purchases.receiveGoods({ purchase_order_id: po.id, location_id: S.shop, received_by: S.admin.id,
    items: [{ product_id: S.composite.id, quantity: 4, unit_cost: 500, batch_number: 'LATE', expiry_date: later }] });
  assert.equal((await m.purchases.getPO(po.id)).status, 'partially_received');
  grn = await m.purchases.receiveGoods({ purchase_order_id: po.id, location_id: S.shop, received_by: S.admin.id,
    items: [{ product_id: S.composite.id, quantity: 6, unit_cost: 560, batch_number: 'SOON', expiry_date: soon }] });
  assert.equal((await m.purchases.getPO(po.id)).status, 'received');
  // avg = (4*500 + 6*560) / 10 = 536
  assert.equal((await m.products.getById(S.composite.id)).cost_price, '536.00');

  // Gloves: 10 @100 on hand, receive 10 @ 120 => avg 110
  await m.purchases.receiveGoods({ supplier_id: S.supplier.id, location_id: S.shop, received_by: S.admin.id,
    items: [{ product_id: S.gloves.id, quantity: 10, unit_cost: 120 }] });
  assert.equal((await m.products.getById(S.gloves.id)).cost_price, '110.00');

  await m.purchases.recordSupplierPayment({ supplier_id: S.supplier.id, amount: 1000, method: 'mpesa', reference: 'ABC', paid_by: S.admin.id });
  const bal = await m.suppliers.getBalance(S.supplier.id);
  assert.equal(bal.purchased, '6560.00'); // 4x500 + 6x560 + 10x120
  assert.equal(bal.owed, '5560.00');
});

test('customers: create, phone rules, search, notes, check-in', async () => {
  S.jane = await m.customers.create({ full_name: 'Jane Wanjiku', phone: '0712 345 678', created_by: S.admin.id, credit_limit: 500 });
  assert.equal(S.jane.phone, '+254712345678');
  assert.equal(S.jane.group_name, 'Retail');
  await rejects(m.customers.create({ full_name: 'Copy', phone: '+254712345678' }), 'DUPLICATE');
  await rejects(m.customers.create({ full_name: 'Bad', phone: '12' }), 'INVALID_PHONE');

  assert.equal((await m.customers.quickSearch('0712'))[0].id, S.jane.id);
  assert.equal((await m.customers.quickSearch('712345'))[0].id, S.jane.id);
  assert.equal((await m.customers.quickSearch('wanj'))[0].id, S.jane.id);
  assert.equal((await m.customers.findByPhone('254712345678')).id, S.jane.id);

  await m.customers.addNote({ customer_id: S.jane.id, note: 'Prefers 3M products', show_on_checkin: true, created_by: S.admin.id });
  await m.customers.addNote({ customer_id: S.jane.id, note: 'Internal only' });
  const ci = await m.customers.checkIn({ customer_id: S.jane.id, served_by: S.cashier.id });
  assert.equal(ci.alerts.length, 1);
  assert.equal(ci.customer.visit_count, 1);
});

test('sale 1: walk-in, FEFO across batches, cash with change, VAT inside price', async () => {
  const sale = await m.sales.createSale({ sold_by: S.cashier.id,
    items: [{ product_id: S.gloves.id, quantity: 2 }, { product_id: S.composite.id, quantity: 7 }],
    payments: [{ method: 'cash', amount: 10000 }] });
  // gloves 2*200 = 400 ; composite 7*900 = 6300 ; total 6700
  assert.equal(sale.total, '6700.00');
  assert.equal(sale.payment_status, 'paid');
  assert.equal(sale.change_due, '3300.00');
  assert.equal(sale.customer_id, null);
  assert.equal(sale.tax_total, '924.14'); // 6700 * 16/116
  assert.equal(sale.payments[0].amount, '6700.00'); // trimmed to the sale total

  // FEFO: composite lines drew 6 from the SOON batch first, then 1 from LATE
  const batches = await m.stock.listBatches({ product_id: S.composite.id, with_stock: false });
  const left = Object.fromEntries(batches.map((b) => [b.batch_number, b.on_hand]));
  assert.deepEqual(left, { SOON: 0, LATE: 3 });
  S.sale1 = sale;
  assert.deepEqual(await m.stock.integrityCheck(), []);
});

test('guard rails: oversell, price floor, price override, walk-in credit', async () => {
  await rejects(m.sales.createSale({ items: [{ product_id: S.gloves.id, quantity: 999 }], payments: [{ method: 'cash', amount: 999999 }] }), 'INSUFFICIENT_STOCK');
  await rejects(m.sales.createSale({ items: [{ product_id: S.composite.id, quantity: 4 }], payments: [{ method: 'cash', amount: 99999 }] }), 'INSUFFICIENT_STOCK'); // only 3 left
  await rejects(m.sales.createSale({ items: [{ product_id: S.gloves.id, quantity: 1, unit_price: 50 }], payments: [{ method: 'cash', amount: 50 }] }), 'PRICE_OVERRIDE_DENIED');
  await rejects(m.sales.createSale({ items: [{ product_id: S.composite.id, quantity: 1, unit_price: 600 }], allow_price_override: true, payments: [{ method: 'cash', amount: 600 }] }), 'BELOW_MIN_PRICE');
  await rejects(m.sales.createSale({ items: [{ product_id: S.gloves.id, quantity: 1 }], payments: [] }), 'PAYMENT_REQUIRED');
  // failed sales left nothing behind
  assert.equal((await m.sales.list({})).total, 1);
  assert.deepEqual(await m.stock.integrityCheck(), []);
});

test('sale 2: saved customer, discount, credit within limit, loyalty earned, stats via triggers', async () => {
  const sale = await m.sales.createSale({ customer_id: S.jane.id, sold_by: S.cashier.id, discount_amount: 20,
    items: [{ product_id: S.gloves.id, quantity: 2 }],   // 400 - 20 = 380
    payments: [{ method: 'cash', amount: 200 }] });      // 180 on credit (limit 500)
  assert.equal(sale.total, '380.00');
  assert.equal(sale.payment_status, 'partial');
  assert.equal(sale.credit_amount, '180.00');
  assert.equal(sale.balance, '180.00');
  const jane = await m.customers.getById(S.jane.id);
  assert.equal(jane.purchase_count, 1);
  assert.equal(jane.total_spent, '380.00');
  assert.equal(jane.outstanding_balance, '180.00');
  assert.equal(jane.visit_count, 1); // check-in already logged today; the sale did not double count
  assert.equal(jane.loyalty_points, 3); // floor(380 * 0.01)
  S.sale2 = sale;

  // Credit limit: another 400 sale entirely on credit would push the balance to 580 > 500
  await rejects(m.sales.createSale({ customer_id: S.jane.id, items: [{ product_id: S.gloves.id, quantity: 2 }], payments: [] }), 'CREDIT_LIMIT_EXCEEDED');

  const settled = await m.sales.addPayment({ sale_id: sale.id, method: 'cash', amount: 180, received_by: S.cashier.id });
  assert.equal(settled.payment_status, 'paid');
  await rejects(m.sales.addPayment({ sale_id: sale.id, method: 'cash', amount: 1 }), 'OVERPAYMENT');
});

test('loyalty redeem, held sale, complete held', async () => {
  await m.customers.loyaltyAdjust({ customer_id: S.jane.id, points: 97, note: 'Welcome bonus', created_by: S.admin.id }); // now 100
  const held = await m.sales.createSale({ customer_id: S.jane.id, status: 'held', loyalty_points_to_redeem: 50,
    items: [{ product_id: S.gloves.id, quantity: 1 }] });
  assert.equal(held.status, 'held');
  assert.equal(held.total, '150.00'); // 200 - (50 points * KES 1)
  assert.equal((await m.customers.getById(S.jane.id)).loyalty_points, 100); // nothing spent until completed
  assert.equal((await m.sales.listHeld()).total, 1);

  const done = await m.sales.completeHeld(held.id, { sold_by: S.cashier.id, payments: [{ method: 'card', amount: 150, reference: 'POS123' }] });
  assert.equal(done.status, 'completed');
  assert.equal(done.payment_status, 'paid');
  const jane = await m.customers.getById(S.jane.id);
  assert.equal(jane.loyalty_points, 100 - 50 + 1); // redeemed 50, earned floor(150*0.01)=1
  await rejects(m.sales.createSale({ customer_id: S.jane.id, loyalty_points_to_redeem: 9999, items: [{ product_id: S.gloves.id, quantity: 1 }], payments: [] }), 'INSUFFICIENT_POINTS');
  S.held = done;

  const h2 = await m.sales.createSale({ status: 'held', items: [{ product_id: S.gloves.id, quantity: 1 }] });
  await m.sales.deleteHeld(h2.id);
  assert.equal((await m.sales.listHeld()).total, 0);
});

test('M-Pesa STK push: pending payment -> callback completes it (and is idempotent)', async () => {
  const tx = await m.mpesa.createPending({ phone: '0712345678', amount: 200, checkout_request_id: 'ws_CO_1', merchant_request_id: 'mr1' });
  const sale = await m.sales.createSale({ customer_id: S.jane.id, sold_by: S.cashier.id, items: [{ product_id: S.gloves.id, quantity: 1 }],
    payments: [{ method: 'mpesa', amount: 200, status: 'pending', mpesa_transaction_id: tx.id }] });
  assert.equal(sale.payment_status, 'unpaid'); // pending money is not counted yet
  assert.equal((await m.mpesa.getById(tx.id)).sale_id, sale.id);

  const body = { Body: { stkCallback: { MerchantRequestID: 'mr1', CheckoutRequestID: 'ws_CO_1', ResultCode: 0, ResultDesc: 'ok',
    CallbackMetadata: { Item: [{ Name: 'Amount', Value: 200 }, { Name: 'MpesaReceiptNumber', Value: 'SIA1B2C3' },
      { Name: 'TransactionDate', Value: 20260930142500 }, { Name: 'PhoneNumber', Value: 254712345678 }] } } } };
  const r1 = await m.mpesa.handleStkCallback(body);
  assert.equal(r1.transaction.status, 'success');
  assert.equal((await m.sales.getById(sale.id)).payment_status, 'paid');
  assert.equal((await m.mpesa.handleStkCallback(body)).duplicate, true);
  assert.equal((await m.sales.getById(sale.id)).payments.length, 1);

  // A cancelled push marks the pending payment failed and leaves the sale unpaid
  const tx2 = await m.mpesa.createPending({ phone: '0712345678', amount: 200, checkout_request_id: 'ws_CO_2' });
  const sale2 = await m.sales.createSale({ customer_id: S.jane.id, items: [{ product_id: S.gloves.id, quantity: 1 }],
    payments: [{ method: 'mpesa', amount: 200, status: 'pending', mpesa_transaction_id: tx2.id }] });
  await m.mpesa.handleStkCallback({ Body: { stkCallback: { MerchantRequestID: 'x', CheckoutRequestID: 'ws_CO_2', ResultCode: 1032, ResultDesc: 'Cancelled' } } });
  const after = await m.sales.getById(sale2.id);
  assert.equal(after.payment_status, 'unpaid');
  assert.equal(after.payments[0].status, 'failed');
  await m.sales.voidSale(sale2.id, { user_id: S.admin.id, reason: 'Customer cancelled M-Pesa' });

  // Till/Paybill payment: duplicate notifications are ignored, unmatched ones can be attached
  assert.ok(await m.mpesa.recordC2B({ phone: '0799111222', amount: 100, mpesa_receipt_number: 'QWE123' }));
  assert.equal(await m.mpesa.recordC2B({ phone: '0799111222', amount: 100, mpesa_receipt_number: 'QWE123' }), null);
  assert.equal((await m.mpesa.listUnmatched()).length, 1);
});

test('returns: partial refund restocks the batch it came from; expiry product batches', async () => {
  const before = await m.stock.getLevels({ product_id: S.composite.id, location_id: S.shop });
  const item = S.sale1.items.find((i) => i.product_id === S.composite.id);
  const ret = await m.sales.createReturn({ sale_id: S.sale1.id, reason: 'defective', refund_method: 'cash', processed_by: S.cashier.id,
    items: [{ sale_item_id: item.id, quantity: 2 }] });
  assert.equal(ret.refund_amount, '1800.00'); // 2 x 900
  const after = await m.stock.getLevels({ product_id: S.composite.id, location_id: S.shop });
  assert.equal(after[0].on_hand, before[0].on_hand + 2);
  // Composite had 1 unit drawn from LATE and 6 from SOON; the FIRST returned units skip nothing and refill SOON first
  const b = Object.fromEntries((await m.stock.listBatches({ product_id: S.composite.id, with_stock: false })).map((x) => [x.batch_number, x.on_hand]));
  assert.equal(b.SOON + b.LATE, after[0].on_hand);
  await rejects(m.sales.createReturn({ sale_id: S.sale1.id, reason: 'other', refund_method: 'cash', items: [{ sale_item_id: item.id, quantity: 6 }] }), 'RETURN_TOO_MANY');
  await rejects(m.sales.voidSale(S.sale1.id, { user_id: S.admin.id }), 'HAS_RETURNS');
  assert.deepEqual(await m.stock.integrityCheck(), []);
});

test('void: stock and loyalty and customer stats are unwound', async () => {
  const jane0 = await m.customers.getById(S.jane.id);
  const stock0 = (await m.stock.getLevels({ product_id: S.gloves.id, location_id: S.shop }))[0].on_hand;
  const s = await m.sales.createSale({ customer_id: S.jane.id, sold_by: S.cashier.id, items: [{ product_id: S.gloves.id, quantity: 3 }], payments: [{ method: 'cash', amount: 600 }] });
  assert.equal((await m.stock.getLevels({ product_id: S.gloves.id, location_id: S.shop }))[0].on_hand, stock0 - 3);
  await m.sales.voidSale(s.id, { user_id: S.admin.id, reason: 'Entered wrongly' });
  const jane1 = await m.customers.getById(S.jane.id);
  assert.equal((await m.stock.getLevels({ product_id: S.gloves.id, location_id: S.shop }))[0].on_hand, stock0);
  assert.equal(jane1.total_spent, jane0.total_spent);
  assert.equal(jane1.purchase_count, jane0.purchase_count);
  assert.equal(jane1.loyalty_points, jane0.loyalty_points);
  await rejects(m.sales.voidSale(s.id, { user_id: S.admin.id }), 'INVALID_STATE');
  assert.deepEqual(await m.stock.integrityCheck(), []);
});

test('stock: adjustment, transfer, stock take', async () => {
  await m.stock.adjust({ location_id: S.shop, reason: 'damaged', notes: 'Dropped box', user_id: S.admin.id,
    items: [{ product_id: S.gloves.id, quantity_change: -2 }] });
  await rejects(m.stock.adjust({ location_id: S.shop, reason: 'found', items: [{ product_id: S.composite.id, quantity_change: 1 }] }), 'BATCH_REQUIRED');

  await m.stock.transfer({ from_location_id: S.shop, to_location_id: S.store, user_id: S.admin.id,
    items: [{ product_id: S.gloves.id, quantity: 4 }, { product_id: S.composite.id, quantity: 2 }] }); // composite moves FEFO by batch
  assert.equal((await m.stock.getLevels({ product_id: S.gloves.id, location_id: S.store }))[0].on_hand, 4);
  assert.equal((await m.stock.getLevels({ product_id: S.composite.id, location_id: S.store }))[0].on_hand, 2);
  await rejects(m.stock.transfer({ from_location_id: S.store, to_location_id: S.shop, items: [{ product_id: S.gloves.id, quantity: 50 }] }), 'INSUFFICIENT_STOCK');

  const st = await m.stock.startStockTake({ location_id: S.store, user_id: S.admin.id });
  const full = await m.stock.getStockTake(st.id);
  const glovesRow = full.items.find((i) => i.product_id === S.gloves.id);
  assert.equal(glovesRow.system_qty, 4);
  await m.stock.recordCount(st.id, glovesRow.id, 3); // one glove missing
  const done = await m.stock.completeStockTake(st.id, S.admin.id);
  assert.equal(done.adjusted_items, 1);
  assert.equal((await m.stock.getLevels({ product_id: S.gloves.id, location_id: S.store }))[0].on_hand, 3);
  await rejects(m.stock.completeStockTake(st.id, S.admin.id), 'ALREADY_CLOSED');
  assert.deepEqual(await m.stock.integrityCheck(), []);
});

test('register session, expenses and reports', async () => {
  const reg = await m.registers.open({ opened_by: S.cashier.id, opening_float: 1000 });
  await rejects(m.registers.open({ opened_by: S.cashier.id }), 'ALREADY_OPEN');
  await m.sales.createSale({ register_session_id: reg.id, sold_by: S.cashier.id, items: [{ product_id: S.gloves.id, quantity: 1 }], payments: [{ method: 'cash', amount: 200 }] });
  const sum = await m.registers.summary(reg.id);
  assert.equal(sum.expected_cash, '1200.00');
  const closed = await m.registers.close({ id: reg.id, closed_by: S.cashier.id, counted_cash: 1190 });
  assert.equal(closed.variance, '-10.00');

  const cats = await m.expenseCategories.list();
  await m.expenses.create({ category_id: cats[0].id, amount: 500, description: 'Test', recorded_by: S.admin.id });
  assert.equal((await m.expenses.summaryByCategory())[0].total, '500.00');

  const summary = await m.reports.salesSummary({});
  assert.ok(summary.sales_count >= 5);
  assert.ok(Number(summary.estimated_gross_profit) > 0);
  assert.ok((await m.reports.topProducts({ limit: 3 })).length > 0);
  assert.ok((await m.reports.paymentBreakdown({})).some((p) => p.method === 'cash'));
  assert.equal((await m.reports.topCustomers({}))[0].id, S.jane.id);
  const d = await m.reports.dashboard();
  assert.ok(Number(d.today_sales) > 0);
  const pl = await m.reports.profitAndLoss({});
  assert.equal(pl.expenses, '500.00');
  assert.ok(await m.notifications.syncStockAlerts());
});

test('concurrency: 8 cashiers race for the last unit -> exactly one wins, ledger stays consistent', async () => {
  const p = await m.products.create({ sku: 'RACE-1', name: 'Last One', unit_id: S.unit, cost_price: 10, selling_price: 20 },
    { opening_stock: 1, location_id: S.shop });
  const attempts = await Promise.allSettled(Array.from({ length: 8 }, () =>
    m.sales.createSale({ items: [{ product_id: p.id, quantity: 1 }], payments: [{ method: 'cash', amount: 20 }] })));
  const won = attempts.filter((a) => a.status === 'fulfilled').length;
  const lost = attempts.filter((a) => a.status === 'rejected' && a.reason.code === 'INSUFFICIENT_STOCK').length;
  assert.equal(won, 1);
  assert.equal(lost, 7);
  assert.equal((await m.stock.getLevels({ product_id: p.id, location_id: S.shop }))[0].on_hand, 0);
  assert.deepEqual(await m.stock.integrityCheck(), []);
});
