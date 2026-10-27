const logger = require('../config/logger');

function errorHandler(err, req, res, next) {
  logger.error('Unhandled API Error: ' + err.message, { stack: err.stack, path: req.path });

  const statusCode = err.status || err.statusCode || 500;
  res.status(statusCode).json({
    success: false,
    message: err.message || 'Internal Server Error',
    error: process.env.NODE_ENV === 'development' ? err.stack : undefined,
  });
}

module.exports = errorHandler;
