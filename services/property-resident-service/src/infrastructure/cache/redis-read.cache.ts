import { ReadCache } from '../../application/ports';

export interface RedisCacheClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: 'EX', ttlSeconds: number): Promise<unknown>;
  del(key: string): Promise<unknown>;
}

export class RedisReadCache implements ReadCache {
  constructor(private readonly redis: RedisCacheClient) {}

  async get<T>(key: string): Promise<T | null> {
    const value = await this.redis.get(key);
    if (!value) return null;
    try {
      return JSON.parse(value) as T;
    } catch {
      await this.redis.del(key);
      return null;
    }
  }

  async set<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
    await this.redis.set(key, JSON.stringify(value), 'EX', ttlSeconds);
  }

  async delete(key: string): Promise<void> {
    await this.redis.del(key);
  }
}

export const PROPERTY_RESIDENT_CACHE_KEYS = {
  apartment: (projectId: string, apartmentId: string) => `property:apartment:{${projectId}}:${apartmentId}`,
  directory: (projectId: string, buildingId: string, departmentId?: string) => `property:directory:{${projectId}}:${buildingId}:${departmentId ?? '*'}`,
  residentApartments: (projectId: string, residentId: string) => `property:resident-apartments:{${projectId}}:${residentId}`,
  apartmentVehicles: (projectId: string, apartmentId: string) => `property:apartment-vehicles:{${projectId}}:${apartmentId}`,
};
