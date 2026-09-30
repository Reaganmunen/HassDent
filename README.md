# Hassdent API — models layer

Express + PostgreSQL (raw SQL, MVC). This folder currently contains the **models** (data-access layer),
the schema, and integration tests. Controllers/routes come next.

```
db/schema.sql            full schema (tables, triggers, views, seed data)
src/config/db.js         pg pool, query(), withTransaction(), inTx()
src/utils/               errors (Postgres -> AppError), money (integer cents), phone (+254 normalising), sql helpers
src/models/              one module per area (see index.js)
tests/models.test.js     integration tests against a real Postgres
```

## Setup
```
npm install
cp .env.example .env                 # set DATABASE_URL
createdb hassdent
psql -d hassdent -f db/schema.sql
ALTER DATABASE hassdent SET timezone = 'Africa/Nairobi';   -- in psql
```
Run tests (uses a THROWAWAY database, it drops the public schema):
```
DATABASE_URL=postgres://user:pass@localhost:5432/hassdent_test npm test
```

## Conventions every model follows
- Functions take an optional trailing `db` argument. Pass a transaction client to join a transaction; omit it to use the pool.
- Multi-step operations (`sales.createSale`, `purchases.receiveGoods`, `stock.transfer`, ...) open their own transaction.
- Errors are `AppError { status, code, message }`, ready for an Express error handler. Notable codes:
  `INSUFFICIENT_STOCK`, `BATCH_REQUIRED`, `CREDIT_LIMIT_EXCEEDED`, `INSUFFICIENT_POINTS`, `PAYMENT_REQUIRED`,
  `OVERPAYMENT`, `BELOW_MIN_PRICE`, `PRICE_OVERRIDE_DENIED`, `DUPLICATE`, `INVALID_PHONE`, `HAS_RETURNS`.
- Money in: numbers. Money out: NUMERIC columns come back as strings (`"380.00"`) so precision is never lost.
- Permission checks (e.g. who may override a price) are the controller's job; it passes flags such as
  `allow_price_override` / `allow_below_min` into `sales.createSale`.
- Password hashing lives in the auth service, not the model (`users.create` takes `password_hash`).

## Sale flow in one look
`sales.createSale({ customer_id?, items, payments, discount_amount?, loyalty_points_to_redeem?, status?: 'held' })`
1. price each line (customer-group price, floor price, VAT-inclusive) -> totals
2. insert sale + items (cost snapshot for profit)
3. stock out per line, first-expiry-first-out for expiry products
4. redeem loyalty, record payments (cash change, pending M-Pesa, credit within limit), earn loyalty, log visit
All-or-nothing in one transaction.
