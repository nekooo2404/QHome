import { createHmac, randomUUID } from 'node:crypto';
import { LoginAttemptRateLimiter, PermissionCache, AuthorizationVersionStore, SessionRevocationStore } from '../../application/ports';
import { PermissionMatrix } from '../../domain/authorization';

export interface RedisClusterClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: 'EX', seconds: number): Promise<unknown>;
  eval(script: string, numberOfKeys: number, ...args: string[]): Promise<unknown>;
}

const SLIDING_WINDOW_LUA = `
local clock = redis.call('TIME')
local now = (tonumber(clock[1]) * 1000) + math.floor(tonumber(clock[2]) / 1000)
local windowMs = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])
local member = ARGV[3] .. ':' .. tostring(now) .. ':' .. tostring(math.random(1, 2147483647))
redis.call('ZREMRANGEBYSCORE', KEYS[1], 0, now - windowMs)
local count = redis.call('ZCARD', KEYS[1])
if count >= limit then
  local oldest = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')
  local retry = windowMs
  if oldest[2] then retry = math.max(1, tonumber(oldest[2]) + windowMs - now) end
  redis.call('PEXPIRE', KEYS[1], windowMs)
  return {0, retry}
end
redis.call('ZADD', KEYS[1], now, member)
redis.call('PEXPIRE', KEYS[1], windowMs)
return {1, 0}
`;

const INVALIDATE_PERMISSION_CACHE_LUA = `
redis.call('DEL', KEYS[1])
redis.call('SET', KEYS[2], ARGV[1])
return 1
`;

const SET_PERMISSION_CACHE_LUA = `
local current = redis.call('GET', KEYS[2])
if current and current ~= ARGV[3] then return 0 end
redis.call('SET', KEYS[2], ARGV[3])
redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2])
return 1
`;

function hashKey(secret: string, input: string): string {
  return createHmac('sha256', secret).update(input, 'utf8').digest('hex');
}

function cacheKey(projectId: string, userId: string): string {
  return `iam:permissions:{${projectId}}:${userId}`;
}

function versionKey(projectId: string, userId: string): string {
  return `iam:permissions-version:{${projectId}}:${userId}`;
}

export class RedisSlidingWindowRateLimiter implements LoginAttemptRateLimiter {
  constructor(
    private readonly redis: RedisClusterClient,
    private readonly keyPepper: string,
    private readonly maxRequests = 8,
    private readonly windowMs = 60_000,
  ) {}

  async consume(key: string, _now: Date): Promise<{ allowed: boolean; retryAfterMs: number }> {
    const digest = hashKey(this.keyPepper, key);
    const redisKey = `iam:login-rate:{${digest}}`;
    const raw = await this.redis.eval(SLIDING_WINDOW_LUA, 1, redisKey, String(this.windowMs), String(this.maxRequests), randomUUID());
    if (!Array.isArray(raw) || raw.length !== 2) throw new Error('Invalid rate limiter response');
    return { allowed: Number(raw[0]) === 1, retryAfterMs: Math.max(0, Number(raw[1]) || 0) };
  }
}

export class RedisPermissionCache implements PermissionCache {
  constructor(private readonly redis: RedisClusterClient) {}

  async get(userId: string, projectId: string): Promise<PermissionMatrix | null> {
    const value = await this.redis.get(cacheKey(projectId, userId));
    if (!value) return null;
    try {
      const parsed = JSON.parse(value) as PermissionMatrix;
      if (!parsed || typeof parsed.version !== 'string' || !Array.isArray(parsed.grants) || !Array.isArray(parsed.buildingIds) || !Array.isArray(parsed.apartmentIds)) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  async set(userId: string, projectId: string, matrix: PermissionMatrix, ttlSeconds: number): Promise<void> {
    const written = await this.redis.eval(SET_PERMISSION_CACHE_LUA, 2, cacheKey(projectId, userId), versionKey(projectId, userId), JSON.stringify(matrix), String(ttlSeconds), matrix.version);
    if (Number(written) !== 1) return;
  }

  async invalidate(userId: string, projectId: string, version: string): Promise<void> {
    await this.redis.eval(INVALIDATE_PERMISSION_CACHE_LUA, 2, cacheKey(projectId, userId), versionKey(projectId, userId), version);
  }
}

function revocationKey(sessionId: string): string {
  return `iam:revoked-session:{${sessionId}}`;
}

export class RedisSessionRevocationStore implements SessionRevocationStore {
  constructor(private readonly redis: RedisClusterClient) {}

  async revoke(sessionId: string, ttlSeconds: number): Promise<void> {
    await this.redis.eval('redis.call("SET", KEYS[1], "1", "EX", ARGV[1]); return 1', 1, revocationKey(sessionId), String(Math.max(1, Math.ceil(ttlSeconds))));
  }

  async isRevoked(sessionId: string): Promise<boolean> {
    return Boolean(await this.redis.get(revocationKey(sessionId)));
  }
}

export class RedisAuthorizationVersionStore implements AuthorizationVersionStore {
  constructor(private readonly redis: RedisClusterClient) {}

  async next(userId: string, projectId: string): Promise<string> {
    const raw = await this.redis.eval('return redis.call("INCR", KEYS[1])', 1, versionKey(projectId, userId));
    return String(raw);
  }
}
