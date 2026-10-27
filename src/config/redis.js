const { createClient } = require('redis');
const logger = require('./logger');

let redisClient = null;

if (process.env.REDIS_URL) {
  redisClient = createClient({
    url: process.env.REDIS_URL,
    socket: {
      reconnectStrategy: (retries) => {
        if (retries > 10) {
          logger.warn('Redis reconnection retries exhausted. Running without Redis.');
          return new Error('Redis reconnection failed');
        }
        return Math.min(retries * 100, 3000);
      },
    },
  });

  redisClient.on('error', (err) => {
    logger.warn('Redis client error: ' + err.message);
  });

  redisClient.on('connect', () => {
    logger.info('Connected to Redis server');
  });

  (async () => {
    try {
      await redisClient.connect();
    } catch (err) {
      logger.warn('Could not connect to Redis initially: ' + err.message);
    }
  })();
}

module.exports = {
  get: async (key) => {
    if (!redisClient || !redisClient.isOpen) return null;
    try {
      return await redisClient.get(key);
    } catch (e) {
      logger.warn(`Redis get error for key ${key}: ${e.message}`);
      return null;
    }
  },
  set: async (key, value, expirySeconds = 300) => {
    if (!redisClient || !redisClient.isOpen) return false;
    try {
      if (expirySeconds) {
        await redisClient.set(key, typeof value === 'string' ? value : JSON.stringify(value), {
          EX: expirySeconds,
        });
      } else {
        await redisClient.set(key, typeof value === 'string' ? value : JSON.stringify(value));
      }
      return true;
    } catch (e) {
      logger.warn(`Redis set error for key ${key}: ${e.message}`);
      return false;
    }
  },
  del: async (key) => {
    if (!redisClient || !redisClient.isOpen) return false;
    try {
      await redisClient.del(key);
      return true;
    } catch (e) {
      logger.warn(`Redis del error for key ${key}: ${e.message}`);
      return false;
    }
  },
  client: redisClient,
};
