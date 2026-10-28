import { Module } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { PropertyResidentService } from './application/property-resident.service';
import { BulkImportService } from './application/bulk-import.service';
import { PropertyResidentHttpController } from './interfaces/http/property-resident.http.controller';
import { PropertyResidentGrpcController } from './interfaces/grpc/property-resident.grpc.controller';
import { PROPERTY_RESIDENT_TOKENS } from './property-resident.tokens';
import { PrismaPropertyResidentRepository } from './infrastructure/prisma/prisma-property-resident.repository';
import { RedisReadCache } from './infrastructure/cache/redis-read.cache';
import { PROPERTY_RESIDENT_CACHE_KEYS } from './infrastructure/cache/redis-read.cache';
import { createPropertyRedis } from './infrastructure/messaging/redis-cluster.client';
import { createPropertyKafkaProducer } from './infrastructure/messaging/kafka.client';
import { PropertyResidentOutboxRelay, PropertyResidentOutboxScheduler } from './infrastructure/messaging/outbox-relay';
import { RedisCacheClient } from './infrastructure/cache/redis-read.cache';
import { PropertyKafkaProducer } from './infrastructure/messaging/outbox-relay';
import { PropertyResidentRepository, ReadCache } from './application/ports';

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

@Module({
  controllers: [PropertyResidentHttpController, PropertyResidentGrpcController],
  providers: [
    { provide: PROPERTY_RESIDENT_TOKENS.Primary, useFactory: () => new PrismaClient({ datasources: { db: { url: requiredEnv('PROPERTY_RESIDENT_DATABASE_URL') } } }) },
    { provide: PROPERTY_RESIDENT_TOKENS.Replica, useFactory: () => new PrismaClient({ datasources: { db: { url: process.env.PROPERTY_RESIDENT_REPLICA_DATABASE_URL ?? requiredEnv('PROPERTY_RESIDENT_DATABASE_URL') } } }) },
    { provide: PROPERTY_RESIDENT_TOKENS.Redis, useFactory: createPropertyRedis },
    { provide: PROPERTY_RESIDENT_TOKENS.Repository, useFactory: (primary: PrismaClient, replica: PrismaClient) => new PrismaPropertyResidentRepository(primary, replica), inject: [PROPERTY_RESIDENT_TOKENS.Primary, PROPERTY_RESIDENT_TOKENS.Replica] },
    { provide: PROPERTY_RESIDENT_TOKENS.Cache, useFactory: (redis: RedisCacheClient) => new RedisReadCache(redis), inject: [PROPERTY_RESIDENT_TOKENS.Redis] },
    { provide: PROPERTY_RESIDENT_TOKENS.KafkaProducer, useFactory: createPropertyKafkaProducer },
    { provide: PROPERTY_RESIDENT_TOKENS.OutboxRelay, useFactory: (primary: PrismaClient, producer: PropertyKafkaProducer) => new PropertyResidentOutboxRelay(primary, producer), inject: [PROPERTY_RESIDENT_TOKENS.Primary, PROPERTY_RESIDENT_TOKENS.KafkaProducer] },
    { provide: PropertyResidentOutboxRelay, useExisting: PROPERTY_RESIDENT_TOKENS.OutboxRelay },
    PropertyResidentOutboxScheduler,
    {
      provide: PropertyResidentService,
      useFactory: (repository: PropertyResidentRepository, cache: ReadCache) => new PropertyResidentService(repository, cache, PROPERTY_RESIDENT_CACHE_KEYS, Number(process.env.PROPERTY_RESIDENT_CACHE_TTL_SECONDS ?? 60)),
      inject: [PROPERTY_RESIDENT_TOKENS.Repository, PROPERTY_RESIDENT_TOKENS.Cache],
    },
    {
      provide: BulkImportService,
      useFactory: (repository: PropertyResidentRepository, cache: ReadCache) => new BulkImportService(repository, cache, PROPERTY_RESIDENT_CACHE_KEYS, Number(process.env.PROPERTY_RESIDENT_IMPORT_BATCH_SIZE ?? 500)),
      inject: [PROPERTY_RESIDENT_TOKENS.Repository, PROPERTY_RESIDENT_TOKENS.Cache],
    },
  ],
})
export class PropertyResidentModule {}
