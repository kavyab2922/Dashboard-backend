const logger = require('../config/logger');

// Network errors from the database driver when the DB host can't be reached (e.g. VPN down).
const DB_UNREACHABLE_CODES = new Set(['ETIMEDOUT', 'ECONNREFUSED', 'ENOTFOUND', 'EHOSTUNREACH', 'ENETUNREACH']);
const DB_UNREACHABLE_MESSAGE = 'The HR Orbit database is unreachable right now. Check your VPN or network connection and try again.';

function errorHandler(err, req, res, next) {
  logger.error('Unhandled API Error: ' + err.message, { stack: err.stack, path: req.path });

  const isDevelopment = process.env.NODE_ENV === 'development';
  const dbUnreachable = DB_UNREACHABLE_CODES.has(err.code);
  const fileTooLarge = err.code === 'LIMIT_FILE_SIZE';
  const statusCode = dbUnreachable ? 503 : fileTooLarge ? 413 : err.status || err.statusCode || 500;
  // 4xx messages are written for the user; 5xx messages can leak SQL or internals,
  // so outside development they stay in the log and the client gets a generic one.
  const clientMessage = statusCode < 500 || isDevelopment
    ? err.message || 'Internal Server Error'
    : 'Something went wrong on our side. Please try again.';
  res.status(statusCode).json({
    success: false,
    message: dbUnreachable
      ? DB_UNREACHABLE_MESSAGE
      : fileTooLarge
        ? 'File is too large. The maximum upload size is 10 MB.'
        : clientMessage,
    error: isDevelopment ? err.stack : undefined,
  });
}

module.exports = errorHandler;
module.exports.DB_UNREACHABLE_CODES = DB_UNREACHABLE_CODES;
module.exports.DB_UNREACHABLE_MESSAGE = DB_UNREACHABLE_MESSAGE;
