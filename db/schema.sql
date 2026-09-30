-- =====================================================================
-- HASSDENT INVENTORY MANAGEMENT SYSTEM  —  PostgreSQL schema
-- Single shop · inventory + walk-in sales · saved customers · M-Pesa
--
-- Conventions
--   * Money: NUMERIC(12,2) in KES. Never floats.
--   * Quantities: INTEGER (whole units). Switch to NUMERIC(12,3) if you
--     ever sell by weight/volume.
--   * Prices are TAX-INCLUSIVE (typical retail). tax_amount on a line is
--     the VAT portion already inside line_total.
--   * All timestamps are TIMESTAMPTZ (stored UTC, shown in EAT).
--   * stock_movements is an append-only ledger = source of truth for stock.
--     stock_levels / batch_stock_levels are caches kept in sync by trigger,
--     with CHECK (on_hand >= 0) so overselling is impossible.
--
-- Run once on an empty database:  psql -d hassdent -f hassdent_schema.sql
-- =====================================================================

BEGIN;

CREATE EXTENSION IF NOT EXISTS pg_trgm;   -- fast fuzzy search on names

-- ---------------------------------------------------------------------
-- 0. HELPERS
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Human-readable document numbers
CREATE SEQUENCE sale_number_seq;
CREATE SEQUENCE po_number_seq;
CREATE SEQUENCE grn_number_seq;
CREATE SEQUENCE adjustment_number_seq;
CREATE SEQUENCE transfer_number_seq;
CREATE SEQUENCE stock_take_number_seq;
CREATE SEQUENCE sale_return_number_seq;
CREATE SEQUENCE supplier_return_number_seq;
CREATE SEQUENCE customer_code_seq;

-- ---------------------------------------------------------------------
-- 1. SHOP SETTINGS (exactly one row)
-- ---------------------------------------------------------------------
CREATE TABLE shop_settings (
  id                            SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  shop_name                     VARCHAR(150) NOT NULL DEFAULT 'Hassdent',
  address                       TEXT,
  phone                         VARCHAR(20),
  email                         VARCHAR(150),
  kra_pin                       VARCHAR(20),
  currency                      CHAR(3)      NOT NULL DEFAULT 'KES',
  receipt_footer                TEXT,
  loyalty_points_per_kes        NUMERIC(6,4) NOT NULL DEFAULT 0.0100, -- 1 point per KES 100
  loyalty_kes_per_point         NUMERIC(8,2) NOT NULL DEFAULT 1.00,   -- 1 point = KES 1 off
  frequent_customer_min_visits  INT          NOT NULL DEFAULT 5,
  expiry_alert_days             INT          NOT NULL DEFAULT 60,
  updated_at                    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------------
-- 2. USERS, ROLES, PERMISSIONS, AUDIT
-- ---------------------------------------------------------------------
CREATE TABLE roles (
  id          SERIAL PRIMARY KEY,
  name        VARCHAR(50) UNIQUE NOT NULL,
  description TEXT
);

CREATE TABLE permissions (
  id          SERIAL PRIMARY KEY,
  code        VARCHAR(60) UNIQUE NOT NULL,     -- e.g. 'sales.void'
  description TEXT
);

CREATE TABLE role_permissions (
  role_id       INT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_id INT NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_id)
);

CREATE TABLE users (
  id            SERIAL PRIMARY KEY,
  name          VARCHAR(100) NOT NULL,
  email         VARCHAR(150) NOT NULL,
  phone         VARCHAR(20),
  password_hash TEXT NOT NULL,
  role_id       INT NOT NULL REFERENCES roles(id),
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  last_login_at TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX uq_users_email ON users (LOWER(email));

-- Refresh tokens and password-reset tokens (store only a hash of the token)
CREATE TABLE user_tokens (
  id         BIGSERIAL PRIMARY KEY,
  user_id    INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type       VARCHAR(20) NOT NULL CHECK (type IN ('refresh','password_reset')),
  token_hash TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at    TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_user_tokens_lookup ON user_tokens (token_hash);
CREATE INDEX idx_user_tokens_user   ON user_tokens (user_id, type);

CREATE TABLE audit_logs (
  id          BIGSERIAL PRIMARY KEY,
  user_id     INT REFERENCES users(id) ON DELETE SET NULL,
  action      VARCHAR(50) NOT NULL,            -- create, update, delete, login, void ...
  entity_type VARCHAR(50) NOT NULL,            -- 'product', 'sale', ...
  entity_id   BIGINT,
  old_data    JSONB,
  new_data    JSONB,
  ip_address  INET,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_audit_entity ON audit_logs (entity_type, entity_id);
CREATE INDEX idx_audit_user   ON audit_logs (user_id, created_at DESC);

-- ---------------------------------------------------------------------
-- 3. CATALOGUE
-- ---------------------------------------------------------------------
CREATE TABLE tax_rates (
  id         SERIAL PRIMARY KEY,
  name       VARCHAR(50) UNIQUE NOT NULL,
  rate       NUMERIC(5,2) NOT NULL CHECK (rate >= 0 AND rate <= 100),
  is_default BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE UNIQUE INDEX uq_tax_default ON tax_rates (is_default) WHERE is_default;

CREATE TABLE units (
  id           SERIAL PRIMARY KEY,
  name         VARCHAR(30) UNIQUE NOT NULL,
  abbreviation VARCHAR(10)
);

CREATE TABLE categories (
  id        SERIAL PRIMARY KEY,
  name      VARCHAR(100) NOT NULL,
  parent_id INT REFERENCES categories(id) ON DELETE SET NULL,
  UNIQUE (parent_id, name)
);

CREATE TABLE brands (
  id   SERIAL PRIMARY KEY,
  name VARCHAR(100) UNIQUE NOT NULL
);

CREATE TABLE customer_groups (        -- pricing tiers: Retail, Wholesale, ...
  id               SERIAL PRIMARY KEY,
  name             VARCHAR(60) UNIQUE NOT NULL,
  discount_percent NUMERIC(5,2) NOT NULL DEFAULT 0 CHECK (discount_percent BETWEEN 0 AND 100),
  is_default       BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE UNIQUE INDEX uq_customer_group_default ON customer_groups (is_default) WHERE is_default;

CREATE TABLE suppliers (
  id             SERIAL PRIMARY KEY,
  name           VARCHAR(150) NOT NULL,
  contact_person VARCHAR(100),
  phone          VARCHAR(20),
  email          VARCHAR(150),
  address        TEXT,
  kra_pin        VARCHAR(20),
  payment_terms  VARCHAR(100),          -- e.g. 'Net 30'
  notes          TEXT,
  is_active      BOOLEAN NOT NULL DEFAULT TRUE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE products (
  id            SERIAL PRIMARY KEY,
  sku           VARCHAR(50) NOT NULL UNIQUE,
  barcode       VARCHAR(64) UNIQUE,
  name          VARCHAR(200) NOT NULL,
  description   TEXT,
  category_id   INT REFERENCES categories(id) ON DELETE SET NULL,
  brand_id      INT REFERENCES brands(id) ON DELETE SET NULL,
  unit_id       INT NOT NULL REFERENCES units(id),
  tax_rate_id   INT REFERENCES tax_rates(id),
  cost_price    NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (cost_price >= 0),     -- weighted-average cost, updated on receiving
  selling_price NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (selling_price >= 0),
  min_price     NUMERIC(12,2) CHECK (min_price >= 0),                          -- floor: block sales below this
  reorder_level INT NOT NULL DEFAULT 0 CHECK (reorder_level >= 0),
  reorder_qty   INT NOT NULL DEFAULT 0 CHECK (reorder_qty >= 0),
  tracks_expiry BOOLEAN NOT NULL DEFAULT FALSE,   -- TRUE = every movement must carry a batch
  image_url     TEXT,
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_by    INT REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_products_category  ON products (category_id);
CREATE INDEX idx_products_brand     ON products (brand_id);
CREATE INDEX idx_products_name_trgm ON products USING gin (name gin_trgm_ops);
CREATE INDEX idx_products_active    ON products (is_active);

-- Optional per-group prices (override group discount)
CREATE TABLE product_group_prices (
  product_id        INT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  customer_group_id INT NOT NULL REFERENCES customer_groups(id) ON DELETE CASCADE,
  price             NUMERIC(12,2) NOT NULL CHECK (price >= 0),
  PRIMARY KEY (product_id, customer_group_id)
);

-- Which suppliers sell which product, at what cost
CREATE TABLE product_suppliers (
  product_id   INT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  supplier_id  INT NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  supplier_sku VARCHAR(50),
  last_cost    NUMERIC(12,2) CHECK (last_cost >= 0),
  lead_time_days INT,
  is_preferred BOOLEAN NOT NULL DEFAULT FALSE,
  PRIMARY KEY (product_id, supplier_id)
);

CREATE TABLE product_price_history (
  id                 BIGSERIAL PRIMARY KEY,
  product_id         INT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  old_cost_price     NUMERIC(12,2),
  new_cost_price     NUMERIC(12,2),
  old_selling_price  NUMERIC(12,2),
  new_selling_price  NUMERIC(12,2),
  changed_by         INT REFERENCES users(id) ON DELETE SET NULL,
  changed_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_price_history_product ON product_price_history (product_id, changed_at DESC);

-- ---------------------------------------------------------------------
-- 4. LOCATIONS & BATCHES
-- ---------------------------------------------------------------------
CREATE TABLE locations (
  id         SERIAL PRIMARY KEY,
  name       VARCHAR(100) UNIQUE NOT NULL,
  type       VARCHAR(20) NOT NULL DEFAULT 'shop_floor' CHECK (type IN ('shop_floor','store_room')),
  is_default BOOLEAN NOT NULL DEFAULT FALSE,   -- where sales deduct from
  is_active  BOOLEAN NOT NULL DEFAULT TRUE
);
CREATE UNIQUE INDEX uq_location_default ON locations (is_default) WHERE is_default;

CREATE TABLE batches (
  id             SERIAL PRIMARY KEY,
  product_id     INT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  batch_number   VARCHAR(50) NOT NULL,
  manufactured_date DATE,
  expiry_date    DATE,
  unit_cost      NUMERIC(12,2) CHECK (unit_cost >= 0),
  supplier_id    INT REFERENCES suppliers(id) ON DELETE SET NULL,
  is_active      BOOLEAN NOT NULL DEFAULT TRUE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (product_id, batch_number)
);
CREATE INDEX idx_batches_expiry  ON batches (expiry_date) WHERE expiry_date IS NOT NULL;
CREATE INDEX idx_batches_product ON batches (product_id);

-- ---------------------------------------------------------------------
-- 5. PURCHASING
-- ---------------------------------------------------------------------
CREATE TABLE purchase_orders (
  id            SERIAL PRIMARY KEY,
  po_number     VARCHAR(20) NOT NULL UNIQUE DEFAULT ('PO-' || LPAD(nextval('po_number_seq')::TEXT, 6, '0')),
  supplier_id   INT NOT NULL REFERENCES suppliers(id),
  status        VARCHAR(20) NOT NULL DEFAULT 'draft'
                CHECK (status IN ('draft','ordered','partially_received','received','cancelled')),
  order_date    DATE,
  expected_date DATE,
  received_at   TIMESTAMPTZ,                       -- set when fully received
  subtotal      NUMERIC(12,2) NOT NULL DEFAULT 0,
  tax_total     NUMERIC(12,2) NOT NULL DEFAULT 0,
  total         NUMERIC(12,2) NOT NULL DEFAULT 0,
  notes         TEXT,
  created_by    INT REFERENCES users(id) ON DELETE SET NULL,
  approved_by   INT REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_po_supplier ON purchase_orders (supplier_id);
CREATE INDEX idx_po_status   ON purchase_orders (status);

CREATE TABLE purchase_order_items (
  id                SERIAL PRIMARY KEY,
  purchase_order_id INT NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  product_id        INT NOT NULL REFERENCES products(id),
  quantity_ordered  INT NOT NULL CHECK (quantity_ordered > 0),
  quantity_received INT NOT NULL DEFAULT 0 CHECK (quantity_received >= 0),
  unit_cost         NUMERIC(12,2) NOT NULL CHECK (unit_cost >= 0),
  tax_rate          NUMERIC(5,2) NOT NULL DEFAULT 0,
  line_total        NUMERIC(12,2) NOT NULL DEFAULT 0
);
CREATE INDEX idx_poi_po ON purchase_order_items (purchase_order_id);

-- Goods Received Note: the event that actually adds stock
CREATE TABLE goods_received_notes (
  id                  SERIAL PRIMARY KEY,
  grn_number          VARCHAR(20) NOT NULL UNIQUE DEFAULT ('GRN-' || LPAD(nextval('grn_number_seq')::TEXT, 6, '0')),
  purchase_order_id   INT REFERENCES purchase_orders(id) ON DELETE SET NULL,  -- NULL = direct/unplanned purchase
  supplier_id         INT NOT NULL REFERENCES suppliers(id),
  supplier_invoice_no VARCHAR(50),
  location_id         INT NOT NULL REFERENCES locations(id),
  received_date       DATE NOT NULL DEFAULT CURRENT_DATE,
  total_cost          NUMERIC(12,2) NOT NULL DEFAULT 0,
  notes               TEXT,
  received_by         INT REFERENCES users(id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_grn_supplier ON goods_received_notes (supplier_id);
CREATE INDEX idx_grn_po       ON goods_received_notes (purchase_order_id);

CREATE TABLE grn_items (
  id                     SERIAL PRIMARY KEY,
  grn_id                 INT NOT NULL REFERENCES goods_received_notes(id) ON DELETE CASCADE,
  purchase_order_item_id INT REFERENCES purchase_order_items(id) ON DELETE SET NULL,
  product_id             INT NOT NULL REFERENCES products(id),
  batch_id               INT REFERENCES batches(id),
  quantity               INT NOT NULL CHECK (quantity > 0),
  unit_cost              NUMERIC(12,2) NOT NULL CHECK (unit_cost >= 0)
);
CREATE INDEX idx_grni_grn ON grn_items (grn_id);

CREATE TABLE supplier_payments (
  id                SERIAL PRIMARY KEY,
  supplier_id       INT NOT NULL REFERENCES suppliers(id),
  purchase_order_id INT REFERENCES purchase_orders(id) ON DELETE SET NULL,
  grn_id            INT REFERENCES goods_received_notes(id) ON DELETE SET NULL,
  amount            NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  method            VARCHAR(20) NOT NULL CHECK (method IN ('cash','mpesa','bank_transfer','cheque')),
  reference         VARCHAR(100),
  paid_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  paid_by           INT REFERENCES users(id) ON DELETE SET NULL,
  notes             TEXT
);
CREATE INDEX idx_sp_supplier ON supplier_payments (supplier_id);

-- Returning goods to a supplier
CREATE TABLE supplier_returns (
  id            SERIAL PRIMARY KEY,
  return_number VARCHAR(20) NOT NULL UNIQUE DEFAULT ('SRT-' || LPAD(nextval('supplier_return_number_seq')::TEXT, 6, '0')),
  supplier_id   INT NOT NULL REFERENCES suppliers(id),
  grn_id        INT REFERENCES goods_received_notes(id) ON DELETE SET NULL,
  location_id   INT NOT NULL REFERENCES locations(id),
  reason        VARCHAR(30) NOT NULL CHECK (reason IN ('damaged','expired','wrong_item','overstock','other')),
  credit_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  notes         TEXT,
  created_by    INT REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE supplier_return_items (
  id                 SERIAL PRIMARY KEY,
  supplier_return_id INT NOT NULL REFERENCES supplier_returns(id) ON DELETE CASCADE,
  product_id         INT NOT NULL REFERENCES products(id),
  batch_id           INT REFERENCES batches(id),
  quantity           INT NOT NULL CHECK (quantity > 0),
  unit_cost          NUMERIC(12,2) NOT NULL CHECK (unit_cost >= 0)
);

-- ---------------------------------------------------------------------
-- 6. STOCK LEDGER, CACHES, ADJUSTMENTS, COUNTS, TRANSFERS
-- ---------------------------------------------------------------------
CREATE TABLE stock_movements (
  id            BIGSERIAL PRIMARY KEY,
  product_id    INT NOT NULL REFERENCES products(id),
  batch_id      INT REFERENCES batches(id),
  location_id   INT NOT NULL REFERENCES locations(id),
  quantity      INT NOT NULL CHECK (quantity <> 0),      -- +in / -out
  movement_type VARCHAR(20) NOT NULL CHECK (movement_type IN (
                  'opening','purchase','sale','sale_return','supplier_return',
                  'adjustment','damage','expiry_writeoff','transfer_in','transfer_out','stock_take')),
  unit_cost     NUMERIC(12,2),                            -- cost snapshot for valuation
  source_type   VARCHAR(30),                              -- 'sale','grn','adjustment','transfer',...
  source_id     BIGINT,                                   -- id in that table (no FK: polymorphic)
  note          TEXT,
  created_by    INT REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_mov_product_loc ON stock_movements (product_id, location_id);
CREATE INDEX idx_mov_batch       ON stock_movements (batch_id) WHERE batch_id IS NOT NULL;
CREATE INDEX idx_mov_source      ON stock_movements (source_type, source_id);
CREATE INDEX idx_mov_created     ON stock_movements (created_at DESC);

-- Cache tables. The CHECK constraints are what make overselling impossible:
-- a concurrent sale that would push on_hand below zero fails atomically.
CREATE TABLE stock_levels (
  product_id  INT NOT NULL REFERENCES products(id),
  location_id INT NOT NULL REFERENCES locations(id),
  on_hand     INT NOT NULL DEFAULT 0 CHECK (on_hand >= 0),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (product_id, location_id)
);

CREATE TABLE batch_stock_levels (
  batch_id    INT NOT NULL REFERENCES batches(id),
  location_id INT NOT NULL REFERENCES locations(id),
  on_hand     INT NOT NULL DEFAULT 0 CHECK (on_hand >= 0),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (batch_id, location_id)
);

CREATE FUNCTION trg_stock_movement_apply() RETURNS trigger AS $$
DECLARE
  v_tracks_expiry BOOLEAN;
BEGIN
  SELECT tracks_expiry INTO v_tracks_expiry FROM products WHERE id = NEW.product_id;
  IF v_tracks_expiry AND NEW.batch_id IS NULL THEN
    RAISE EXCEPTION 'Product % tracks expiry: a batch_id is required', NEW.product_id
      USING ERRCODE = '23514';
  END IF;

  -- Create the balance row at 0 if missing (race-safe), THEN apply the delta.
  -- (A single upsert with a negative value would trip the CHECK on the
  -- proposed row before ON CONFLICT is resolved.) The UPDATE row-locks the
  -- balance, so concurrent sales of the same product queue up safely.
  INSERT INTO stock_levels (product_id, location_id, on_hand)
  VALUES (NEW.product_id, NEW.location_id, 0)
  ON CONFLICT (product_id, location_id) DO NOTHING;

  UPDATE stock_levels
     SET on_hand = on_hand + NEW.quantity, updated_at = NOW()
   WHERE product_id = NEW.product_id AND location_id = NEW.location_id;

  IF NEW.batch_id IS NOT NULL THEN
    INSERT INTO batch_stock_levels (batch_id, location_id, on_hand)
    VALUES (NEW.batch_id, NEW.location_id, 0)
    ON CONFLICT (batch_id, location_id) DO NOTHING;

    UPDATE batch_stock_levels
       SET on_hand = on_hand + NEW.quantity, updated_at = NOW()
     WHERE batch_id = NEW.batch_id AND location_id = NEW.location_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER stock_movement_apply
  BEFORE INSERT ON stock_movements
  FOR EACH ROW EXECUTE FUNCTION trg_stock_movement_apply();

-- The ledger is append-only. Fix mistakes with a new reversing movement.
CREATE FUNCTION trg_stock_movement_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'stock_movements is append-only; insert a reversing movement instead';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER stock_movement_immutable
  BEFORE UPDATE OR DELETE ON stock_movements
  FOR EACH ROW EXECUTE FUNCTION trg_stock_movement_immutable();

-- Manual adjustments (with a reason)
CREATE TABLE stock_adjustments (
  id                SERIAL PRIMARY KEY,
  adjustment_number VARCHAR(20) NOT NULL UNIQUE DEFAULT ('ADJ-' || LPAD(nextval('adjustment_number_seq')::TEXT, 6, '0')),
  location_id       INT NOT NULL REFERENCES locations(id),
  reason            VARCHAR(30) NOT NULL CHECK (reason IN ('damaged','expired','lost','found','correction','sample','other')),
  notes             TEXT,
  created_by        INT REFERENCES users(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE stock_adjustment_items (
  id                  SERIAL PRIMARY KEY,
  stock_adjustment_id INT NOT NULL REFERENCES stock_adjustments(id) ON DELETE CASCADE,
  product_id          INT NOT NULL REFERENCES products(id),
  batch_id            INT REFERENCES batches(id),
  quantity_change     INT NOT NULL CHECK (quantity_change <> 0)   -- +/-
);

-- Physical stock counts
CREATE TABLE stock_takes (
  id              SERIAL PRIMARY KEY,
  take_number     VARCHAR(20) NOT NULL UNIQUE DEFAULT ('ST-' || LPAD(nextval('stock_take_number_seq')::TEXT, 6, '0')),
  location_id     INT NOT NULL REFERENCES locations(id),
  status          VARCHAR(20) NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress','completed','cancelled')),
  notes           TEXT,
  started_by      INT REFERENCES users(id) ON DELETE SET NULL,
  started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at    TIMESTAMPTZ
);

CREATE TABLE stock_take_items (
  id            SERIAL PRIMARY KEY,
  stock_take_id INT NOT NULL REFERENCES stock_takes(id) ON DELETE CASCADE,
  product_id    INT NOT NULL REFERENCES products(id),
  batch_id      INT REFERENCES batches(id),
  system_qty    INT NOT NULL,
  counted_qty   INT CHECK (counted_qty >= 0),
  variance      INT GENERATED ALWAYS AS (counted_qty - system_qty) STORED
);
CREATE INDEX idx_sti_take ON stock_take_items (stock_take_id);

-- Moving stock between store room and shop floor
CREATE TABLE stock_transfers (
  id               SERIAL PRIMARY KEY,
  transfer_number  VARCHAR(20) NOT NULL UNIQUE DEFAULT ('TRF-' || LPAD(nextval('transfer_number_seq')::TEXT, 6, '0')),
  from_location_id INT NOT NULL REFERENCES locations(id),
  to_location_id   INT NOT NULL REFERENCES locations(id),
  status           VARCHAR(20) NOT NULL DEFAULT 'completed' CHECK (status IN ('draft','completed','cancelled')),
  notes            TEXT,
  created_by       INT REFERENCES users(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (from_location_id <> to_location_id)
);

CREATE TABLE stock_transfer_items (
  id                SERIAL PRIMARY KEY,
  stock_transfer_id INT NOT NULL REFERENCES stock_transfers(id) ON DELETE CASCADE,
  product_id        INT NOT NULL REFERENCES products(id),
  batch_id          INT REFERENCES batches(id),
  quantity          INT NOT NULL CHECK (quantity > 0)
);

-- ---------------------------------------------------------------------
-- 7. CUSTOMERS (saved / frequent customers, recognised at the counter)
-- ---------------------------------------------------------------------
CREATE TABLE customers (
  id                SERIAL PRIMARY KEY,
  customer_code     VARCHAR(20) NOT NULL UNIQUE DEFAULT ('CUS-' || LPAD(nextval('customer_code_seq')::TEXT, 5, '0')),
  full_name         VARCHAR(150) NOT NULL,
  customer_type     VARCHAR(20) NOT NULL DEFAULT 'individual' CHECK (customer_type IN ('individual','business')),
  organization_name VARCHAR(150),
  phone             VARCHAR(20) CHECK (phone ~ '^\+?[0-9]{9,15}$'),  -- store normalised, e.g. +2547XXXXXXXX
  alt_phone         VARCHAR(20),
  email             VARCHAR(150),
  address           TEXT,
  customer_group_id INT REFERENCES customer_groups(id) ON DELETE SET NULL,
  credit_limit      NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (credit_limit >= 0),
  loyalty_points    INT NOT NULL DEFAULT 0 CHECK (loyalty_points >= 0),
  -- Maintained by triggers (do not update from app code)
  visit_count       INT NOT NULL DEFAULT 0,
  last_visit_at     TIMESTAMPTZ,
  purchase_count    INT NOT NULL DEFAULT 0,
  total_spent       NUMERIC(12,2) NOT NULL DEFAULT 0,
  last_purchase_at  TIMESTAMPTZ,
  is_active         BOOLEAN NOT NULL DEFAULT TRUE,
  created_by        INT REFERENCES users(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX uq_customers_phone ON customers (phone) WHERE phone IS NOT NULL;
CREATE INDEX idx_customers_name_trgm   ON customers USING gin (full_name gin_trgm_ops);
CREATE INDEX idx_customers_email       ON customers (LOWER(email));

-- Notes shown to staff when the customer is looked up ("prefers X", "owes reminder")
CREATE TABLE customer_notes (
  id               SERIAL PRIMARY KEY,
  customer_id      INT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  note             TEXT NOT NULL,
  show_on_checkin  BOOLEAN NOT NULL DEFAULT FALSE,   -- pop up when the customer is selected
  is_resolved      BOOLEAN NOT NULL DEFAULT FALSE,
  created_by       INT REFERENCES users(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_cnotes_customer ON customer_notes (customer_id);

-- Each time the customer walks in / is checked in at the counter
CREATE TABLE customer_visits (
  id          BIGSERIAL PRIMARY KEY,
  customer_id INT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  visited_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  purpose     VARCHAR(100),
  served_by   INT REFERENCES users(id) ON DELETE SET NULL,
  notes       TEXT
);
CREATE INDEX idx_visits_customer ON customer_visits (customer_id, visited_at DESC);

CREATE FUNCTION trg_customer_visit_stats() RETURNS trigger AS $$
BEGIN
  UPDATE customers
     SET visit_count = visit_count + 1,
         last_visit_at = GREATEST(COALESCE(last_visit_at, NEW.visited_at), NEW.visited_at)
   WHERE id = NEW.customer_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER customer_visit_stats
  AFTER INSERT ON customer_visits
  FOR EACH ROW EXECUTE FUNCTION trg_customer_visit_stats();

CREATE TABLE loyalty_transactions (
  id            BIGSERIAL PRIMARY KEY,
  customer_id   INT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  sale_id       INT,                                   -- FK added after sales table exists
  type          VARCHAR(10) NOT NULL CHECK (type IN ('earn','redeem','adjust','expire')),
  points        INT NOT NULL CHECK (points <> 0),      -- signed
  balance_after INT,                                   -- filled by trigger
  note          TEXT,
  created_by    INT REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_loyalty_customer ON loyalty_transactions (customer_id, created_at DESC);

CREATE FUNCTION trg_loyalty_apply() RETURNS trigger AS $$
BEGIN
  UPDATE customers
     SET loyalty_points = loyalty_points + NEW.points   -- CHECK >= 0 blocks over-redeeming
   WHERE id = NEW.customer_id
   RETURNING loyalty_points INTO NEW.balance_after;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER loyalty_apply
  BEFORE INSERT ON loyalty_transactions
  FOR EACH ROW EXECUTE FUNCTION trg_loyalty_apply();

-- ---------------------------------------------------------------------
-- 8. SALES / POS
-- ---------------------------------------------------------------------
CREATE TABLE cash_register_sessions (
  id              SERIAL PRIMARY KEY,
  opened_by       INT NOT NULL REFERENCES users(id),
  opened_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  opening_float   NUMERIC(12,2) NOT NULL DEFAULT 0,
  closed_by       INT REFERENCES users(id),
  closed_at       TIMESTAMPTZ,
  expected_cash   NUMERIC(12,2),
  counted_cash    NUMERIC(12,2),
  variance        NUMERIC(12,2) GENERATED ALWAYS AS (counted_cash - expected_cash) STORED,
  status          VARCHAR(10) NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  notes           TEXT
);
CREATE INDEX idx_register_status ON cash_register_sessions (status);

CREATE TABLE sales (
  id                  SERIAL PRIMARY KEY,
  sale_number         VARCHAR(20) NOT NULL UNIQUE DEFAULT ('INV-' || LPAD(nextval('sale_number_seq')::TEXT, 6, '0')),
  customer_id         INT REFERENCES customers(id) ON DELETE SET NULL,   -- NULL = anonymous walk-in
  register_session_id INT REFERENCES cash_register_sessions(id),
  location_id         INT NOT NULL REFERENCES locations(id),
  status              VARCHAR(10) NOT NULL DEFAULT 'completed' CHECK (status IN ('held','completed','voided')),
  subtotal            NUMERIC(12,2) NOT NULL DEFAULT 0,   -- sum of line_total before sale-level discount
  discount_amount     NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (discount_amount >= 0),
  loyalty_points_used INT NOT NULL DEFAULT 0 CHECK (loyalty_points_used >= 0),
  loyalty_discount    NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (loyalty_discount >= 0),
  tax_total           NUMERIC(12,2) NOT NULL DEFAULT 0,   -- VAT portion contained in total
  total               NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (total >= 0),
  amount_paid         NUMERIC(12,2) NOT NULL DEFAULT 0,   -- kept in sync by payments trigger
  payment_status      VARCHAR(10) NOT NULL DEFAULT 'unpaid' CHECK (payment_status IN ('unpaid','partial','paid')),
  notes               TEXT,
  sold_by             INT REFERENCES users(id) ON DELETE SET NULL,
  sold_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  voided_by           INT REFERENCES users(id) ON DELETE SET NULL,
  voided_at           TIMESTAMPTZ,
  void_reason         TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_sales_customer ON sales (customer_id);
CREATE INDEX idx_sales_sold_at  ON sales (sold_at DESC);
CREATE INDEX idx_sales_status   ON sales (status, payment_status);
CREATE INDEX idx_sales_register ON sales (register_session_id);

ALTER TABLE loyalty_transactions
  ADD CONSTRAINT fk_loyalty_sale FOREIGN KEY (sale_id) REFERENCES sales(id) ON DELETE SET NULL;

CREATE TABLE sale_items (
  id               SERIAL PRIMARY KEY,
  sale_id          INT NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  product_id       INT NOT NULL REFERENCES products(id),
  quantity         INT NOT NULL CHECK (quantity > 0),
  quantity_returned INT NOT NULL DEFAULT 0 CHECK (quantity_returned >= 0),
  unit_price       NUMERIC(12,2) NOT NULL CHECK (unit_price >= 0),  -- price at time of sale
  unit_cost        NUMERIC(12,2) NOT NULL DEFAULT 0,                -- cost snapshot => accurate profit later
  discount_amount  NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (discount_amount >= 0),
  tax_rate         NUMERIC(5,2) NOT NULL DEFAULT 0,
  tax_amount       NUMERIC(12,2) NOT NULL DEFAULT 0,
  line_total       NUMERIC(12,2) NOT NULL CHECK (line_total >= 0),
  CHECK (quantity_returned <= quantity)
);
CREATE INDEX idx_si_sale    ON sale_items (sale_id);
CREATE INDEX idx_si_product ON sale_items (product_id);

-- M-Pesa (Daraja). Insert a 'pending' row when you fire the STK push,
-- then update it from the callback.
CREATE TABLE mpesa_transactions (
  id                   SERIAL PRIMARY KEY,
  sale_id              INT REFERENCES sales(id) ON DELETE SET NULL,
  transaction_type     VARCHAR(10) NOT NULL DEFAULT 'stk_push' CHECK (transaction_type IN ('stk_push','c2b')),
  phone                VARCHAR(20) NOT NULL,
  amount               NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  account_reference    VARCHAR(50),
  merchant_request_id  VARCHAR(100),
  checkout_request_id  VARCHAR(100) UNIQUE,
  mpesa_receipt_number VARCHAR(30) UNIQUE,
  status               VARCHAR(12) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','success','failed','cancelled','timeout')),
  result_code          INT,
  result_desc          TEXT,
  transaction_date     TIMESTAMPTZ,
  raw_callback         JSONB,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_mpesa_sale  ON mpesa_transactions (sale_id);
CREATE INDEX idx_mpesa_phone ON mpesa_transactions (phone);

CREATE TABLE payments (
  id                    SERIAL PRIMARY KEY,
  sale_id               INT NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  method                VARCHAR(20) NOT NULL CHECK (method IN ('cash','mpesa','card','bank_transfer','loyalty')),
  amount                NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  reference             VARCHAR(100),
  mpesa_transaction_id  INT REFERENCES mpesa_transactions(id) ON DELETE SET NULL,
  status                VARCHAR(10) NOT NULL DEFAULT 'completed' CHECK (status IN ('pending','completed','failed','reversed')),
  received_by           INT REFERENCES users(id) ON DELETE SET NULL,
  paid_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_payments_sale ON payments (sale_id);
CREATE INDEX idx_payments_paid ON payments (paid_at DESC);

-- Keep sales.amount_paid / payment_status in sync with payments
CREATE FUNCTION trg_sync_sale_payment() RETURNS trigger AS $$
DECLARE
  v_sale INT;
  v_paid NUMERIC(12,2);
BEGIN
  v_sale := COALESCE(NEW.sale_id, OLD.sale_id);
  SELECT COALESCE(SUM(amount), 0) INTO v_paid
    FROM payments WHERE sale_id = v_sale AND status = 'completed';
  UPDATE sales
     SET amount_paid = v_paid,
         payment_status = CASE
           WHEN v_paid >= total AND v_paid > 0 THEN 'paid'
           WHEN v_paid > 0 THEN 'partial'
           ELSE 'unpaid' END
   WHERE id = v_sale;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER sync_sale_payment
  AFTER INSERT OR UPDATE OR DELETE ON payments
  FOR EACH ROW EXECUTE FUNCTION trg_sync_sale_payment();

-- Customer lifetime stats from sales
CREATE FUNCTION trg_customer_sale_stats() RETURNS trigger AS $$
BEGIN
  IF NEW.customer_id IS NULL THEN RETURN NEW; END IF;

  IF NEW.status = 'completed' AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'completed') THEN
    UPDATE customers
       SET total_spent = total_spent + NEW.total,
           purchase_count = purchase_count + 1,
           last_purchase_at = GREATEST(COALESCE(last_purchase_at, NEW.sold_at), NEW.sold_at)
     WHERE id = NEW.customer_id;
  ELSIF TG_OP = 'UPDATE' AND OLD.status = 'completed' AND NEW.status = 'voided' THEN
    UPDATE customers
       SET total_spent = total_spent - NEW.total,
           purchase_count = GREATEST(purchase_count - 1, 0)
     WHERE id = NEW.customer_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER customer_sale_stats
  AFTER INSERT OR UPDATE OF status ON sales
  FOR EACH ROW EXECUTE FUNCTION trg_customer_sale_stats();

-- Customer returns / refunds
CREATE TABLE sale_returns (
  id             SERIAL PRIMARY KEY,
  return_number  VARCHAR(20) NOT NULL UNIQUE DEFAULT ('RET-' || LPAD(nextval('sale_return_number_seq')::TEXT, 6, '0')),
  sale_id        INT NOT NULL REFERENCES sales(id),
  customer_id    INT REFERENCES customers(id) ON DELETE SET NULL,
  location_id    INT NOT NULL REFERENCES locations(id),
  reason         VARCHAR(30) NOT NULL CHECK (reason IN ('defective','wrong_item','changed_mind','expired','other')),
  refund_method  VARCHAR(20) NOT NULL CHECK (refund_method IN ('cash','mpesa','store_credit','none')),
  refund_amount  NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (refund_amount >= 0),
  notes          TEXT,
  processed_by   INT REFERENCES users(id) ON DELETE SET NULL,
  processed_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_returns_sale ON sale_returns (sale_id);

CREATE TABLE sale_return_items (
  id             SERIAL PRIMARY KEY,
  sale_return_id INT NOT NULL REFERENCES sale_returns(id) ON DELETE CASCADE,
  sale_item_id   INT NOT NULL REFERENCES sale_items(id),
  product_id     INT NOT NULL REFERENCES products(id),
  batch_id       INT REFERENCES batches(id),
  quantity       INT NOT NULL CHECK (quantity > 0),
  refund_amount  NUMERIC(12,2) NOT NULL CHECK (refund_amount >= 0),
  restock        BOOLEAN NOT NULL DEFAULT TRUE        -- FALSE for damaged/expired returns
);

CREATE FUNCTION trg_customer_return_stats() RETURNS trigger AS $$
BEGIN
  IF NEW.customer_id IS NOT NULL AND NEW.refund_amount > 0 THEN
    UPDATE customers SET total_spent = total_spent - NEW.refund_amount WHERE id = NEW.customer_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER customer_return_stats
  AFTER INSERT ON sale_returns
  FOR EACH ROW EXECUTE FUNCTION trg_customer_return_stats();

-- ---------------------------------------------------------------------
-- 9. EXPENSES
-- ---------------------------------------------------------------------
CREATE TABLE expense_categories (
  id   SERIAL PRIMARY KEY,
  name VARCHAR(80) UNIQUE NOT NULL
);

CREATE TABLE expenses (
  id            SERIAL PRIMARY KEY,
  category_id   INT NOT NULL REFERENCES expense_categories(id),
  amount        NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  expense_date  DATE NOT NULL DEFAULT CURRENT_DATE,
  method        VARCHAR(20) NOT NULL DEFAULT 'cash' CHECK (method IN ('cash','mpesa','card','bank_transfer')),
  reference     VARCHAR(100),
  description   TEXT,
  receipt_url   TEXT,
  recorded_by   INT REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_expenses_date ON expenses (expense_date DESC);

-- ---------------------------------------------------------------------
-- 10. NOTIFICATIONS
-- ---------------------------------------------------------------------
CREATE TABLE notifications (
  id          BIGSERIAL PRIMARY KEY,
  user_id     INT REFERENCES users(id) ON DELETE CASCADE,   -- NULL = everyone
  type        VARCHAR(20) NOT NULL CHECK (type IN ('low_stock','expiry','payment','reminder','system')),
  title       VARCHAR(150) NOT NULL,
  message     TEXT,
  entity_type VARCHAR(50),
  entity_id   BIGINT,
  is_read     BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_notif_user ON notifications (user_id, is_read, created_at DESC);

-- ---------------------------------------------------------------------
-- 11. PRICE HISTORY TRIGGER
-- ---------------------------------------------------------------------
CREATE FUNCTION trg_product_price_history() RETURNS trigger AS $$
BEGIN
  IF NEW.cost_price IS DISTINCT FROM OLD.cost_price
     OR NEW.selling_price IS DISTINCT FROM OLD.selling_price THEN
    INSERT INTO product_price_history
      (product_id, old_cost_price, new_cost_price, old_selling_price, new_selling_price)
    VALUES
      (NEW.id, OLD.cost_price, NEW.cost_price, OLD.selling_price, NEW.selling_price);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER product_price_history
  AFTER UPDATE ON products
  FOR EACH ROW EXECUTE FUNCTION trg_product_price_history();

-- ---------------------------------------------------------------------
-- 12. updated_at TRIGGERS
-- ---------------------------------------------------------------------
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'shop_settings','users','suppliers','products','purchase_orders',
    'customers','sales','mpesa_transactions'
  ] LOOP
    EXECUTE format(
      'CREATE TRIGGER set_updated_at BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION set_updated_at()', t);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------
-- 13. VIEWS
-- ---------------------------------------------------------------------

-- Total stock per product (all locations) with reorder flag
CREATE VIEW v_product_stock AS
SELECT p.id AS product_id, p.sku, p.name, p.reorder_level, p.reorder_qty,
       COALESCE(SUM(sl.on_hand), 0)::INT AS on_hand,
       COALESCE(SUM(sl.on_hand), 0) <= p.reorder_level AS needs_reorder
FROM products p
LEFT JOIN stock_levels sl ON sl.product_id = p.id
WHERE p.is_active
GROUP BY p.id;

CREATE VIEW v_low_stock AS
SELECT * FROM v_product_stock WHERE needs_reorder ORDER BY on_hand;

-- Batches that are expired or about to expire and still have stock
CREATE VIEW v_expiring_batches AS
SELECT b.id AS batch_id, p.id AS product_id, p.name, b.batch_number, b.expiry_date,
       (b.expiry_date - CURRENT_DATE) AS days_left,
       (b.expiry_date < CURRENT_DATE) AS is_expired,
       SUM(bs.on_hand)::INT AS on_hand
FROM batches b
JOIN products p ON p.id = b.product_id
JOIN batch_stock_levels bs ON bs.batch_id = b.id
WHERE b.expiry_date IS NOT NULL
  AND b.expiry_date <= CURRENT_DATE + (SELECT expiry_alert_days FROM shop_settings LIMIT 1)
GROUP BY b.id, p.id
HAVING SUM(bs.on_hand) > 0
ORDER BY b.expiry_date;

-- What each customer still owes on completed sales
CREATE VIEW v_customer_balances AS
SELECT customer_id, SUM(total - amount_paid)::NUMERIC(12,2) AS outstanding
FROM sales
WHERE status = 'completed' AND customer_id IS NOT NULL AND amount_paid < total
GROUP BY customer_id;

-- Everything the counter needs when a customer is looked up
CREATE VIEW v_customer_summary AS
SELECT c.id, c.customer_code, c.full_name, c.phone, c.alt_phone, c.email, c.customer_type,
       c.organization_name, c.customer_group_id, c.loyalty_points, c.credit_limit,
       c.visit_count, c.last_visit_at, c.purchase_count, c.total_spent, c.last_purchase_at,
       COALESCE(b.outstanding, 0) AS outstanding_balance,
       (c.visit_count >= (SELECT frequent_customer_min_visits FROM shop_settings LIMIT 1)) AS is_frequent
FROM customers c
LEFT JOIN v_customer_balances b ON b.customer_id = c.id
WHERE c.is_active;

-- A customer's most-bought products (for "usually buys..." prompts)
CREATE VIEW v_customer_top_products AS
SELECT s.customer_id, si.product_id, p.name,
       SUM(si.quantity - si.quantity_returned)::INT AS qty_bought,
       MAX(s.sold_at) AS last_bought_at
FROM sale_items si
JOIN sales s    ON s.id = si.sale_id AND s.status = 'completed'
JOIN products p ON p.id = si.product_id
WHERE s.customer_id IS NOT NULL
GROUP BY s.customer_id, si.product_id, p.name;

-- Daily sales, cost and gross profit (Nairobi calendar day)
CREATE VIEW v_sales_daily AS
SELECT (s.sold_at AT TIME ZONE 'Africa/Nairobi')::DATE AS sale_date,
       COUNT(DISTINCT s.id)                              AS sales_count,
       SUM(si.line_total)::NUMERIC(12,2)                 AS gross_sales,
       SUM(si.unit_cost * si.quantity)::NUMERIC(12,2)    AS cost_of_goods,
       (SUM(si.line_total - si.tax_amount - si.unit_cost * si.quantity))::NUMERIC(12,2) AS gross_profit
FROM sales s
JOIN sale_items si ON si.sale_id = s.id
WHERE s.status = 'completed'
GROUP BY 1;

-- Current stock value at cost
CREATE VIEW v_stock_valuation AS
SELECT p.id AS product_id, p.name, sl.location_id,
       sl.on_hand, p.cost_price,
       (sl.on_hand * p.cost_price)::NUMERIC(12,2) AS stock_value
FROM stock_levels sl
JOIN products p ON p.id = sl.product_id;

-- Health check: should always return zero rows. If not, the cache drifted from the ledger.
CREATE VIEW v_stock_integrity_check AS
SELECT sl.product_id, sl.location_id, sl.on_hand AS cached, COALESCE(m.total, 0) AS ledger
FROM stock_levels sl
LEFT JOIN (
  SELECT product_id, location_id, SUM(quantity) AS total
  FROM stock_movements GROUP BY product_id, location_id
) m ON m.product_id = sl.product_id AND m.location_id = sl.location_id
WHERE sl.on_hand <> COALESCE(m.total, 0);

-- ---------------------------------------------------------------------
-- 14. SEED DATA
-- ---------------------------------------------------------------------
INSERT INTO shop_settings (id) VALUES (1);

INSERT INTO locations (name, type, is_default) VALUES
  ('Shop Floor', 'shop_floor', TRUE),
  ('Store Room', 'store_room', FALSE);

INSERT INTO tax_rates (name, rate, is_default) VALUES
  ('VAT 16%', 16, TRUE),
  ('Zero rated', 0, FALSE),
  ('Exempt', 0, FALSE);

INSERT INTO units (name, abbreviation) VALUES
  ('Piece','pc'),('Box','box'),('Pack','pk'),('Bottle','btl'),
  ('Tube','tube'),('Kit','kit'),('Set','set'),('Roll','roll');

INSERT INTO customer_groups (name, discount_percent, is_default) VALUES
  ('Retail', 0, TRUE),
  ('Wholesale', 0, FALSE);

INSERT INTO expense_categories (name) VALUES
  ('Rent'),('Utilities'),('Salaries'),('Transport'),('Marketing'),
  ('Licences & Permits'),('Repairs & Maintenance'),('Supplies'),('Other');

INSERT INTO roles (name, description) VALUES
  ('admin','Full access'),
  ('manager','Runs the shop: stock, purchasing, reports'),
  ('cashier','Serves customers and takes payments'),
  ('stock_keeper','Receives and manages stock');

INSERT INTO permissions (code, description) VALUES
  ('products.view',''),('products.manage',''),
  ('stock.view',''),('stock.adjust',''),('stock.count',''),('stock.transfer',''),
  ('purchases.view',''),('purchases.manage',''),('purchases.receive',''),('purchases.pay',''),
  ('sales.create',''),('sales.view',''),('sales.discount',''),('sales.void',''),('sales.refund',''),
  ('customers.view',''),('customers.manage',''),
  ('suppliers.manage',''),
  ('expenses.manage',''),
  ('reports.view',''),
  ('users.manage',''),('settings.manage','');

-- admin: everything
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r CROSS JOIN permissions p WHERE r.name = 'admin';

-- manager: everything except user/settings management
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r CROSS JOIN permissions p
WHERE r.name = 'manager' AND p.code NOT IN ('users.manage','settings.manage');

-- cashier
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r JOIN permissions p
  ON p.code IN ('products.view','stock.view','sales.create','sales.view','customers.view','customers.manage')
WHERE r.name = 'cashier';

-- stock keeper
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r JOIN permissions p
  ON p.code IN ('products.view','products.manage','stock.view','stock.adjust','stock.count',
                'stock.transfer','purchases.view','purchases.receive','suppliers.manage')
WHERE r.name = 'stock_keeper';

COMMIT;
