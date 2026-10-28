import Redis from 'ioredis';
import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { MarketplaceCache } from '../../application/ports';

export interface MarketplaceRedisClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ...args: Array<string | number>): Promise<unknown>;
  disconnect?(): void;
}

export function createMarketplaceRedis(): MarketplaceRedisClient {
  const nodes = (process.env.RESIDENT_MARKETPLACE_REDIS_NODES ?? '').split(',').map((value) => value.trim()).filter(Boolean);
  if (nodes.length < 3) throw new Error('RESIDENT_MARKETPLACE_REDIS_NODES must contain at least three nodes');
  return new Redis.Cluster(nodes.map((node) => { const url = new URL(node); return { host: url.hostname, port: Number(url.port || 6379) }; }), {
    redisOptions: { password: process.env.RESIDENT_MARKETPLACE_REDIS_PASSWORD, tls: process.env.RESIDENT_MARKETPLACE_REDIS_TLS === 'true' ? {} : undefined, enableReadyCheck: true },
    scaleReads: 'slave',
    maxRetriesPerRequest: 2,
  });
}

@Injectable()
export class RedisMarketplaceCache implements MarketplaceCache, OnModuleDestroy {
  constructor(private readonly redis: MarketplaceRedisClient) {}

  async get<T>(key: string): Promise<T | undefined> {
    const raw = await this.redis.get(key);
    if (!raw) return undefined;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return undefined;
    }
  }

  async set<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
    if (!Number.isInteger(ttlSeconds) || ttlSeconds <= 0) throw new Error('catalog cache TTL must be a positive integer');
    await this.redis.set(key, JSON.stringify(value), 'EX', ttlSeconds);
  }

  onModuleDestroy(): void {
    this.redis.disconnect?.();
  }
}
