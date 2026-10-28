import { randomUUID } from 'node:crypto';
import { DistributedLockProvider, SchedulerCursorStore } from '../../application/ports';

export interface RedisLockClient {
  set(key: string, value: string, ...args: Array<string | number>): Promise<unknown>;
  get(key: string): Promise<string | null>;
  del(key: string): Promise<unknown>;
  eval(script: string, numberOfKeys: number, ...args: string[]): Promise<unknown>;
}

const RELEASE_SCRIPT = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";

export class RedisDistributedLock implements DistributedLockProvider {
  constructor(private readonly redis: RedisLockClient) {}

  async acquire(key: string, ttlMs: number): Promise<{ release(): Promise<void> } | null> {
    const token = randomUUID();
    const acquired = await this.redis.set(key, token, 'NX', 'PX', ttlMs);
    if (!acquired) return null;
    return { release: async () => { await this.redis.eval(RELEASE_SCRIPT, 1, key, token); } };
  }
}

export class RedisSchedulerCursorStore implements SchedulerCursorStore {
  constructor(private readonly redis: RedisLockClient) {}
  async get(key: string): Promise<string | undefined> { return (await this.redis.get('asset-maintenance:cursor:' + key)) ?? undefined; }
  async set(key: string, value: string, ttlSeconds: number): Promise<void> { await this.redis.set('asset-maintenance:cursor:' + key, value, 'EX', ttlSeconds); }
}
