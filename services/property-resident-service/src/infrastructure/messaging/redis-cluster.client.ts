import Redis from 'ioredis';
import { RedisCacheClient } from '../cache/redis-read.cache';

export function createPropertyRedis(): RedisCacheClient {
  const nodes = (process.env.PROPERTY_RESIDENT_REDIS_NODES ?? '').split(',').map((value) => value.trim()).filter(Boolean);
  if (nodes.length < 3) throw new Error('PROPERTY_RESIDENT_REDIS_NODES must contain at least three nodes');
  const cluster = new Redis.Cluster(nodes.map((node) => {
    const url = new URL(node);
    return { host: url.hostname, port: Number(url.port || 6379) };
  }), {
    redisOptions: {
      password: process.env.PROPERTY_RESIDENT_REDIS_PASSWORD,
      tls: process.env.PROPERTY_RESIDENT_REDIS_TLS === 'true' ? {} : undefined,
      enableReadyCheck: true,
    },
    scaleReads: 'master',
    maxRetriesPerRequest: 2,
  });
  return cluster;
}
