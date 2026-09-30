const express = require('express');
const rateLimit = require('express-rate-limit');
const { authenticate, can } = require('../middleware/auth');
const { query } = require('../config/db');

const auth = require('../controllers/auth.controller');
const users = require('../controllers/user.controller');
const settings = require('../controllers/settings.controller');
const catalog = require('../controllers/catalog.controller');
const products = require('../controllers/product.controller');
const suppliers = require('../controllers/supplier.controller');
const customers = require('../controllers/customer.controller');
const stock = require('../controllers/stock.controller');
const purchases = require('../controllers/purchase.controller');
const sales = require('../controllers/sale.controller');
const mpesa = require('../controllers/mpesa.controller');
const registers = require('../controllers/register.controller');
const expenses = require('../controllers/expense.controller');
const reports = require('../controllers/report.controller');
const notifications = require('../controllers/notification.controller');
const audit = require('../controllers/audit.controller');

const router = express.Router();

// Permission codes (seeded in db/schema.sql):
//  products.view/manage · stock.view/adjust/count/transfer · purchases.view/manage/receive/pay · suppliers.manage
//  sales.create/view/discount/void/refund · customers.view/manage · expenses.manage · reports.view · users.manage · settings.manage

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false,
  message: { success: false, error: { code: 'TOO_MANY_REQUESTS', message: 'Too many attempts, please try again later' } } });

// ------------------------------------------------------------------ public
router.get('/health', async (req, res) => {
  try { await query('SELECT 1'); res.json({ status: 'ok' }); }
  catch (e) { res.status(503).json({ status: 'database_unavailable' }); }
});

router.post('/auth/setup', authLimiter, auth.setup);
router.post('/auth/login', authLimiter, auth.login);
router.post('/auth/refresh', authLimiter, auth.refresh);
router.post('/auth/forgot-password', authLimiter, auth.forgotPassword);
router.post('/auth/reset-password', authLimiter, auth.resetPassword);

// Safaricom callbacks: no login, protected by the secret in the URL instead (see mpesa.controller)
router.post('/mpesa/callback/:secret', mpesa.stkCallback);
router.post('/mpesa/c2b/validation/:secret', mpesa.c2bValidation);
router.post('/mpesa/c2b/confirmation/:secret', mpesa.c2bConfirmation);

// ------------------------------------------------------------------ everything below needs a login
router.use(authenticate);

// auth (logged in)
router.get('/auth/me', auth.me);
router.post('/auth/logout', auth.logout);
router.post('/auth/change-password', auth.changePassword);

// users, roles, settings, audit
router.get('/roles', can('users.manage'), users.roles);
router.get('/permissions', can('users.manage'), users.permissions);
router.get('/users', can('users.manage'), users.list);
router.post('/users', can('users.manage'), users.create);
router.get('/users/:id', can('users.manage'), users.get);
router.patch('/users/:id', can('users.manage'), users.update);
router.get('/settings', settings.get);                         // needed by every screen (shop name, VAT, loyalty rules)
router.patch('/settings', can('settings.manage'), settings.update);
router.get('/audit-logs', can('users.manage'), audit.list);

// lookup tables: anyone logged in may read; writes need the matching permission
function mountLookup(path, ctrl, writePerm) {
  router.get(path, ctrl.list);
  router.get(`${path}/:id`, ctrl.get);
  router.post(path, can(writePerm), ctrl.create);
  router.patch(`${path}/:id`, can(writePerm), ctrl.update);
  router.delete(`${path}/:id`, can(writePerm), ctrl.remove);
  if (ctrl.setDefault) router.post(`${path}/:id/default`, can(writePerm), ctrl.setDefault);
}
mountLookup('/categories', catalog.categories, 'products.manage');
mountLookup('/brands', catalog.brands, 'products.manage');
mountLookup('/units', catalog.units, 'products.manage');
mountLookup('/tax-rates', catalog.taxRates, 'settings.manage');
mountLookup('/customer-groups', catalog.customerGroups, 'settings.manage');
mountLookup('/locations', catalog.locations, 'settings.manage');
mountLookup('/expense-categories', catalog.expenseCategories, 'expenses.manage');

// products
router.get('/products/pos-search', can('sales.create'), products.posSearch);
router.get('/products', can('products.view'), products.list);
router.post('/products', can('products.manage'), products.create);
router.get('/products/:id', can('products.view'), products.get);
router.patch('/products/:id', can('products.manage'), products.update);
router.post('/products/:id/active', can('products.manage'), products.setActive);
router.get('/products/:id/price-history', can('products.manage'), products.priceHistory);
router.put('/products/:id/group-prices', can('products.manage'), products.setGroupPrice);
router.delete('/products/:id/group-prices/:groupId', can('products.manage'), products.removeGroupPrice);
router.put('/products/:id/suppliers', can('products.manage'), products.linkSupplier);
router.delete('/products/:id/suppliers/:supplierId', can('products.manage'), products.unlinkSupplier);

// suppliers (+ what we owe them)
const viewSuppliers = can('purchases.view', 'suppliers.manage', 'products.manage');
router.get('/suppliers', viewSuppliers, suppliers.list);
router.post('/suppliers', can('suppliers.manage'), suppliers.create);
router.get('/suppliers/:id', viewSuppliers, suppliers.get);
router.patch('/suppliers/:id', can('suppliers.manage'), suppliers.update);
router.post('/suppliers/:id/active', can('suppliers.manage'), suppliers.setActive);
router.get('/suppliers/:id/payments', can('purchases.view', 'purchases.pay'), purchases.listSupplierPayments);
router.post('/suppliers/:id/payments', can('purchases.pay'), purchases.recordSupplierPayment);

// customers (search routes must come before /:id)
router.get('/customers/search', can('customers.view'), customers.quickSearch);
router.get('/customers/by-phone', can('customers.view'), customers.findByPhone);
router.get('/customers', can('customers.view'), customers.list);
router.post('/customers', can('customers.manage'), customers.create);
router.get('/customers/:id', can('customers.view'), customers.get);
router.patch('/customers/:id', can('customers.manage'), customers.update);
router.delete('/customers/:id', can('customers.manage'), customers.deactivate);
router.post('/customers/:id/check-in', can('customers.view'), customers.checkIn);
router.get('/customers/:id/visits', can('customers.view'), customers.visits);
router.get('/customers/:id/purchases', can('customers.view'), customers.purchases);
router.get('/customers/:id/top-products', can('customers.view'), customers.topProducts);
router.get('/customers/:id/notes', can('customers.view'), customers.listNotes);
router.post('/customers/:id/notes', can('customers.manage'), customers.addNote);
router.post('/customers/:id/notes/:noteId/resolve', can('customers.manage'), customers.resolveNote);
router.delete('/customers/:id/notes/:noteId', can('customers.manage'), customers.deleteNote);
router.get('/customers/:id/loyalty', can('customers.view'), customers.loyaltyHistory);
router.post('/customers/:id/loyalty', can('sales.discount'), customers.loyaltyAdjust); // giving points is discount-level power

// stock
router.get('/stock/levels', can('stock.view'), stock.levels);
router.get('/stock/movements', can('stock.view'), stock.movements);
router.get('/stock/batches', can('stock.view'), stock.batches);
router.get('/stock/low', can('stock.view'), stock.lowStock);
router.get('/stock/expiring', can('stock.view'), stock.expiring);
router.get('/stock/valuation', can('reports.view'), stock.valuation);
router.get('/stock/integrity', can('reports.view'), stock.integrity);
router.post('/stock/adjustments', can('stock.adjust'), stock.adjust);
router.post('/stock/transfers', can('stock.transfer'), stock.transfer);
router.post('/stock/takes', can('stock.count'), stock.startTake);
router.get('/stock/takes/:id', can('stock.count'), stock.getTake);
router.patch('/stock/takes/:id/items/:itemId', can('stock.count'), stock.recordCount);
router.post('/stock/takes/:id/complete', can('stock.count'), stock.completeTake);

// purchasing
router.get('/purchase-orders', can('purchases.view'), purchases.listPOs);
router.post('/purchase-orders', can('purchases.manage'), purchases.createPO);
router.get('/purchase-orders/:id', can('purchases.view'), purchases.getPO);
router.post('/purchase-orders/:id/status', can('purchases.manage'), purchases.setPOStatus);
router.get('/goods-received', can('purchases.view'), purchases.listGRNs);
router.post('/goods-received', can('purchases.receive'), purchases.receive);
router.get('/goods-received/:id', can('purchases.view'), purchases.getGRN);
router.post('/supplier-returns', can('purchases.manage'), purchases.createSupplierReturn);

// sales / POS (fixed paths before /:id)
router.post('/sales', can('sales.create'), sales.create);
router.get('/sales', can('sales.view'), sales.list);
router.get('/sales/held', can('sales.create'), sales.listHeld);
router.get('/sales/unpaid', can('sales.view'), sales.listUnpaid);
router.get('/sales/:id', can('sales.view'), sales.get);
router.get('/sales/:id/receipt', can('sales.view'), sales.receipt);
router.post('/sales/:id/complete', can('sales.create'), sales.completeHeld);
router.delete('/sales/:id/held', can('sales.create'), sales.deleteHeld);
router.post('/sales/:id/payments', can('sales.create'), sales.addPayment);
router.post('/sales/:id/void', can('sales.void'), sales.void);
router.post('/sales/:id/returns', can('sales.refund'), sales.createReturn);
router.get('/sales/:id/returns/:returnId', can('sales.view'), sales.getReturn);

// M-Pesa (staff side)
router.post('/mpesa/stk-push', can('sales.create'), mpesa.stkPush);
router.get('/mpesa/status/:checkoutRequestId', can('sales.create'), mpesa.status);
router.get('/mpesa/unmatched', can('sales.create'), mpesa.listUnmatched);
router.post('/mpesa/:id/attach', can('sales.create'), mpesa.attach);

// till sessions
router.post('/registers/open', can('sales.create'), registers.open);
router.get('/registers/current', can('sales.create'), registers.current);
router.get('/registers', can('reports.view'), registers.list);
router.get('/registers/:id/summary', can('sales.create'), registers.summary);
router.post('/registers/:id/close', can('sales.create'), registers.close);

// expenses
router.get('/expenses/summary', can('expenses.manage', 'reports.view'), expenses.summary);
router.get('/expenses', can('expenses.manage', 'reports.view'), expenses.list);
router.post('/expenses', can('expenses.manage'), expenses.create);
router.delete('/expenses/:id', can('expenses.manage'), expenses.remove);

// reports
router.get('/reports/dashboard', can('reports.view'), reports.dashboard);
router.get('/reports/sales-summary', can('reports.view'), reports.salesSummary);
router.get('/reports/sales-by-day', can('reports.view'), reports.salesByDay);
router.get('/reports/top-products', can('reports.view'), reports.topProducts);
router.get('/reports/top-customers', can('reports.view'), reports.topCustomers);
router.get('/reports/payment-breakdown', can('reports.view'), reports.paymentBreakdown);
router.get('/reports/profit-and-loss', can('reports.view'), reports.profitAndLoss);

// notifications (own + shop-wide)
router.get('/notifications', notifications.list);
router.post('/notifications/read-all', notifications.markAllRead);
router.post('/notifications/sync', can('stock.view', 'reports.view'), notifications.sync);
router.post('/notifications/:id/read', notifications.markRead);

module.exports = router;
