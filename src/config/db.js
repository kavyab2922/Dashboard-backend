const { Pool } = require('pg');
const logger = require('./logger');

const password = process.env.DB_PASS ? process.env.DB_PASS.replace(/^"|"$/g, '') : '';

const pool = new Pool({
  host: process.env.DB_HOST || '10.0.74.8',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  user: process.env.DB_USER || 'admin',
  password: password,
  database: process.env.DB_NAME || 'defaultdb',
  max: parseInt(process.env.POOL_MAX_CONNECTION || '5', 10),
  min: parseInt(process.env.POOL_MIN_CONNECTION || '0', 10),
  connectionTimeoutMillis: parseInt(process.env.POOL_MAX_TIMEOUT || '30000', 10),
  idleTimeoutMillis: parseInt(process.env.POOL_IDLE_TIMEOUT || '10000', 10),
});

pool.on('connect', (client) => {
  const schema = process.env.DB_SCHEMA || 'hcm';
  client.query(`SET search_path TO ${schema}, public;`);
});

pool.on('error', (err) => {
  logger.error('Unexpected error on idle PostgreSQL client', err);
});

module.exports = {
  pool,
  query: async (text, params) => {
    const start = Date.now();
    try {
      const res = await pool.query(text, params);
      const duration = Date.now() - start;
      if (process.env.DB_LOGGING === 'true') {
        logger.debug('Executed query', { text: text.slice(0, 100), duration, rows: res.rowCount });
      }
      return res;
    } catch (err) {
      logger.error('Database query error', { text, error: err.message });
      throw err;
    }
  },
};
