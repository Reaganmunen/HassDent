/**
 * AppError carries an HTTP status so controllers can respond correctly
 * without knowing anything about SQL.
 */
class AppError extends Error {
  constructor(message, status = 400, code = 'BAD_REQUEST', details) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const notFound = (what = 'Resource') => new AppError(`${what} not found`, 404, 'NOT_FOUND');

/**
 * Translate raw Postgres errors into AppErrors the API can show to a user.
 * The constraint names below come from db/schema.sql.
 */
function mapPgError(err) {
  if (err instanceof AppError || !err || typeof err.code !== 'string') return err;

  switch (err.code) {
    case '23505':
      return new AppError('A record with the same unique value already exists', 409, 'DUPLICATE',
        { constraint: err.constraint, detail: err.detail });
    case '23503':
      return new AppError('Related record does not exist, or is still in use', 409, 'FOREIGN_KEY',
        { constraint: err.constraint, detail: err.detail });
    case '23502':
      return new AppError(`Missing required field: ${err.column}`, 400, 'REQUIRED_FIELD');
    case '22P02':
      return new AppError('Invalid value format', 400, 'INVALID_INPUT');
    case '23514':
      if (err.constraint === 'stock_levels_on_hand_check' || err.constraint === 'batch_stock_levels_on_hand_check') {
        return new AppError('Insufficient stock for this operation', 409, 'INSUFFICIENT_STOCK');
      }
      if (err.constraint === 'customers_loyalty_points_check') {
        return new AppError('Customer does not have enough loyalty points', 409, 'INSUFFICIENT_POINTS');
      }
      if (err.constraint === 'customers_phone_check') {
        return new AppError('Invalid phone number', 400, 'INVALID_PHONE');
      }
      // Raised by our own triggers (e.g. "batch_id is required")
      return new AppError(err.message, 422, 'CHECK_VIOLATION', { constraint: err.constraint });
    default:
      return err;
  }
}

module.exports = { AppError, notFound, mapPgError };
