import { randomUUID } from 'node:crypto';
import { DistributedLock, RedisLockClient } from '../../application/ports';

const RELEASE = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";

export class RedisRedlock implements DistributedLock {
  constructor(private readonly redis: RedisLockClient) {}

  async acquire(key: string, ttlMs: number): Promise<{ release(): Promise<void> } | null> {
    const token = randomUUID();
    const result = await this.redis.set(key, token, 'NX', 'PX', ttlMs);
    if (!result) return null;
    return { release: async () => { await this.redis.eval(RELEASE, 1, key, token); } };
  }
}
