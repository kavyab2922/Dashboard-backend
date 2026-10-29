const logger = require('../config/logger');

// Network errors from the database driver when the DB host can't be reached (e.g. VPN down).
const DB_UNREACHABLE_CODES = new Set(['ETIMEDOUT', 'ECONNREFUSED', 'ENOTFOUND', 'EHOSTUNREACH', 'ENETUNREACH']);

function errorHandler(err, req, res, next) {
  logger.error('Unhandled API Error: ' + err.message, { stack: err.stack, path: req.path });

  const dbUnreachable = DB_UNREACHABLE_CODES.has(err.code);
  const statusCode = dbUnreachable ? 503 : err.status || err.statusCode || 500;
  res.status(statusCode).json({
    success: false,
    message: dbUnreachable
      ? 'The HR Orbit database is unreachable right now. Check your VPN or network connection and try again.'
      : err.message || 'Internal Server Error',
    error: process.env.NODE_ENV === 'development' ? err.stack : undefined,
  });
}

module.exports = errorHandler;
