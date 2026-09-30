const { AppError } = require('../utils/errors');

const notFoundHandler = (req, res) =>
  res.status(404).json({ success: false, error: { code: 'ROUTE_NOT_FOUND', message: `No route for ${req.method} ${req.originalUrl}` } });

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  if (res.headersSent) return next(err);

  if (err.type === 'entity.parse.failed') err = new AppError('Request body is not valid JSON', 400, 'INVALID_JSON');
  else if (err.type === 'entity.too.large') err = new AppError('Request body is too large', 413, 'PAYLOAD_TOO_LARGE');

  if (err instanceof AppError) {
    return res.status(err.status).json({
      success: false,
      error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) },
    });
  }

  console.error('[unhandled]', req.method, req.originalUrl, err);
  return res.status(500).json({
    success: false,
    error: { code: 'INTERNAL_ERROR', message: 'Something went wrong on our side',
      ...(process.env.NODE_ENV !== 'production' ? { debug: err.message } : {}) },
  });
}

module.exports = { notFoundHandler, errorHandler };
