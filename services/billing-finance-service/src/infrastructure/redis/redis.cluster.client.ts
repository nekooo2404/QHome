import Redis from 'ioredis';
import { RedisIdempotencyClient } from './redis.idempotency';

export function createBillingRedis(): RedisIdempotencyClient {
  const nodes = (process.env.BILLING_FINANCE_REDIS_NODES ?? '').split(',').map((value) => value.trim()).filter(Boolean);
  if (nodes.length < 3) throw new Error('BILLING_FINANCE_REDIS_NODES must contain at least three nodes');
  return new Redis.Cluster(nodes.map((node) => { const url = new URL(node); return { host: url.hostname, port: Number(url.port || 6379) }; }), { redisOptions: { password: process.env.BILLING_FINANCE_REDIS_PASSWORD, tls: process.env.BILLING_FINANCE_REDIS_TLS === 'true' ? {} : undefined, enableReadyCheck: true }, scaleReads: 'master', maxRetriesPerRequest: 2 });
}
