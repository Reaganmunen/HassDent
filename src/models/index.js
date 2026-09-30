const catalog = require('./catalog.model');

module.exports = {
  settings: require('./settings.model'),
  users: require('./user.model'),
  audit: require('./audit.model'),
  notifications: require('./notification.model'),
  ...catalog,                       // categories, brands, units, taxRates, customerGroups, locations, expenseCategories
  products: require('./product.model'),
  suppliers: require('./supplier.model'),
  customers: require('./customer.model'),
  stock: require('./stock.model'),
  purchases: require('./purchase.model'),
  sales: require('./sale.model'),
  mpesa: require('./mpesa.model'),
  registers: require('./register.model'),
  expenses: require('./expense.model'),
  reports: require('./report.model'),
};
