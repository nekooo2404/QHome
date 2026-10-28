import Redis from 'ioredis';
import { randomUUID } from 'node:crypto';

export interface WorkforceLockClient { set(key: string, value: string, ...args: Array<string | number>): Promise<unknown>; eval(script: string, numberOfKeys: number, ...args: string[]): Promise<unknown>; }

export function createWorkforceRedis(): WorkforceLockClient {
  const nodes = (process.env.WORKFORCE_KPI_REDIS_NODES ?? '').split(',').map((value) => value.trim()).filter(Boolean);
  if (nodes.length < 3) throw new Error('WORKFORCE_KPI_REDIS_NODES must contain at least three cluster nodes');
  return new Redis.Cluster(nodes.map((node) => { const url = new URL(node); return { host: url.hostname, port: Number(url.port || 6379) }; }), { redisOptions: { password: process.env.WORKFORCE_KPI_REDIS_PASSWORD, tls: process.env.WORKFORCE_KPI_REDIS_TLS === 'true' ? {} : undefined, enableReadyCheck: true }, scaleReads: 'master', maxRetriesPerRequest: 2 });
}

export class WorkforceDistributedLock {
  constructor(private readonly redis: WorkforceLockClient) {}
  async acquire(key: string, ttlMs: number): Promise<{ release(): Promise<void> } | null> { const token = randomUUID(); const acquired = await this.redis.set(key, token, 'NX', 'PX', ttlMs); if (!acquired) return null; return { release: () => this.redis.eval('if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end', 1, key, token).then(() => undefined) }; }
}
