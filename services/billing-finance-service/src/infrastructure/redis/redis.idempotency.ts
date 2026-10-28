import { createHash } from 'node:crypto';
import { IdempotencyGate } from '../../application/ports';

export interface RedisIdempotencyClient {
  set(key: string, value: string, ...args: Array<string | number>): Promise<unknown>;
  get(key: string): Promise<string | null>;
}

export class RedisIdempotencyGate implements IdempotencyGate {
  constructor(private readonly redis: RedisIdempotencyClient) {}

  async begin(scope: string, key: string, requestHash: string, ttlSeconds: number) {
    const redisKey = 'billing:idempotency:{' + createHash('sha256').update(scope).digest('hex') + '}:' + key;
    const marker = JSON.stringify({ status: 'PROCESSING', requestHash });
    const acquired = await this.redis.set(redisKey, marker, 'NX', 'EX', ttlSeconds);
    if (acquired) return { acquired: true };
    const current = await this.redis.get(redisKey);
    if (!current) return { acquired: false };
    const parsed = JSON.parse(current) as { status?: string; requestHash?: string; statusCode?: number; body?: unknown };
    if (parsed.requestHash !== requestHash) throw new Error('Idempotency key was reused with a different request');
    if (parsed.status === 'COMPLETED' && typeof parsed.statusCode === 'number') return { acquired: false, cachedResponse: { statusCode: parsed.statusCode, body: parsed.body } };
    return { acquired: false };
  }

  async complete(scope: string, key: string, requestHash: string, statusCode: number, body: unknown): Promise<void> {
    const redisKey = 'billing:idempotency:{' + createHash('sha256').update(scope).digest('hex') + '}:' + key;
    await this.redis.set(redisKey, JSON.stringify({ status: 'COMPLETED', requestHash, statusCode, body }), 'EX', 86_400);
  }
}
