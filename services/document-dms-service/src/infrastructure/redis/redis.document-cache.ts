import Redis from 'ioredis';
import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { DocumentAccessCache } from '../../application/ports';

export interface DocumentRedisClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ...args: Array<string | number>): Promise<unknown>;
  disconnect?(): void;
}

export function createDocumentRedis(): DocumentRedisClient {
  const nodes = (process.env.DOCUMENT_DMS_REDIS_NODES ?? '').split(',').map((value) => value.trim()).filter(Boolean);
  if (nodes.length < 3) throw new Error('DOCUMENT_DMS_REDIS_NODES must contain at least three cluster nodes');
  return new Redis.Cluster(nodes.map((node) => { const url = new URL(node); return { host: url.hostname, port: Number(url.port || 6379) }; }), { redisOptions: { password: process.env.DOCUMENT_DMS_REDIS_PASSWORD, tls: process.env.DOCUMENT_DMS_REDIS_TLS === 'true' ? {} : undefined, enableReadyCheck: true }, scaleReads: 'master', maxRetriesPerRequest: 2 });
}

@Injectable()
export class RedisDocumentAccessCache implements DocumentAccessCache, OnModuleDestroy {
  constructor(private readonly redis: DocumentRedisClient) {}

  async get(key: string): Promise<boolean | undefined> {
    const value = await this.redis.get(key);
    return value === null ? undefined : value === '1';
  }

  async set(key: string, value: boolean, ttlSeconds: number): Promise<void> {
    await this.redis.set(key, value ? '1' : '0', 'EX', ttlSeconds);
  }

  onModuleDestroy(): void {
    this.redis.disconnect?.();
  }
}
