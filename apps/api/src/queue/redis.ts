import IORedis from 'ioredis';

/**
 * Shared Redis connection for BullMQ.
 * Reuses the existing Docker Redis on 127.0.0.1:6379.
 */
const REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';

export const redis = new IORedis(REDIS_URL, {
  maxRetriesPerRequest: null, // BullMQ requires this
  enableReadyCheck: true,
});

redis.on('error', (err) => {
  console.error('[redis] connection error:', err.message);
});