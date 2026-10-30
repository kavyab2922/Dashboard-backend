const { createClient } = require('redis');
const logger = require('./logger');

let redisClient = null;

if (process.env.REDIS_URL) {
  redisClient = createClient({
    url: process.env.REDIS_URL,
    // Ping periodically so a socket killed by a network switch is noticed and reconnected
    pingInterval: 30000,
    socket: {
      // Keep retrying (capped backoff) so Redis recovers after a network change without a restart
      reconnectStrategy: (retries) => Math.min(retries * 200, 10000),
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
