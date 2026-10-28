import Redis from 'ioredis';
import { RedisLockClient } from './redis.lock';

export function createRegistrationRedis(): RedisLockClient {
  const nodes = (process.env.RESIDENT_REGISTRATION_REDIS_NODES ?? '').split(',').map((value) => value.trim()).filter(Boolean);
  if (nodes.length < 3) throw new Error('RESIDENT_REGISTRATION_REDIS_NODES must contain at least three nodes');
  return new Redis.Cluster(nodes.map((node) => { const url = new URL(node); return { host: url.hostname, port: Number(url.port || 6379) }; }), { redisOptions: { password: process.env.RESIDENT_REGISTRATION_REDIS_PASSWORD, tls: process.env.RESIDENT_REGISTRATION_REDIS_TLS === 'true' ? {} : undefined, enableReadyCheck: true }, scaleReads: 'master', maxRetriesPerRequest: 2 });
}
