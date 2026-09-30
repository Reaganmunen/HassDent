const { makeCrud } = require('./crud');
const { query } = require('../config/db');

module.exports = {
  categories: makeCrud({ table: 'categories', fields: ['name', 'parent_id'], searchCols: ['name'], orderBy: 'name' }),
  brands: makeCrud({ table: 'brands', fields: ['name'], searchCols: ['name'], orderBy: 'name' }),
  units: makeCrud({ table: 'units', fields: ['name', 'abbreviation'], orderBy: 'name' }),
  taxRates: makeCrud({ table: 'tax_rates', fields: ['name', 'rate', 'is_default'], orderBy: 'id', hasDefault: true }),
  customerGroups: makeCrud({ table: 'customer_groups', fields: ['name', 'discount_percent', 'is_default'], orderBy: 'id', hasDefault: true }),
  locations: makeCrud({ table: 'locations', fields: ['name', 'type', 'is_default', 'is_active'], orderBy: 'id', hasActive: true, hasDefault: true }),
  expenseCategories: makeCrud({ table: 'expense_categories', fields: ['name'], orderBy: 'name' }),

  /** id of the location sales deduct stock from. */
  async defaultLocationId(db) {
    const { rows: [r] } = await query('SELECT id FROM locations WHERE is_default AND is_active LIMIT 1', [], db);
    return r ? r.id : null;
  },
};
