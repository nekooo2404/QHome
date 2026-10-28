import Redis from 'ioredis';
import { RedisClusterClient } from '../security/redis-security';

export function createRedisClusterClient(): RedisClusterClient {
  const nodes = (process.env.IAM_REDIS_NODES ?? '').split(',').map((value) => value.trim()).filter(Boolean);
  if (nodes.length < 3) {
    throw new Error('IAM_REDIS_NODES must contain at least three cluster nodes');
  }
  const cluster = new Redis.Cluster(nodes.map((host) => {
    const url = new URL(host);
    return { host: url.hostname, port: Number(url.port || 6379) };
  }), {
    redisOptions: {
      password: process.env.IAM_REDIS_PASSWORD,
      tls: process.env.IAM_REDIS_TLS === 'true' ? {} : undefined,
      enableReadyCheck: true,
    },
    scaleReads: 'master',
    maxRetriesPerRequest: 2,
  });
  return cluster;
}
