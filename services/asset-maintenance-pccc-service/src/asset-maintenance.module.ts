import { Module } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { MaintenanceService } from './application/maintenance.service';
import { MaintenanceSchedulerService } from './application/scheduler.service';
import { SchedulerRunner } from './application/scheduler.runner';
import { AssetMaintenanceHttpController } from './interfaces/http/asset-maintenance.http.controller';
import { PrismaAssetRepository } from './infrastructure/prisma/prisma.asset.repository';
import { KafkaIncidentPublisher } from './infrastructure/messaging/incident.publisher';
import { createAssetKafkaProducer } from './infrastructure/messaging/kafka.client';
import { RedisDistributedLock, RedisSchedulerCursorStore } from './infrastructure/redis/redis.lock';
import { createAssetRedis } from './infrastructure/redis/redis.client';
import { ASSET_TOKENS } from './asset-maintenance.tokens';

function requiredEnv(name: string): string { const value = process.env[name]; if (!value) throw new Error(name + ' is required'); return value; }

@Module({
  controllers: [AssetMaintenanceHttpController],
  providers: [
    { provide: ASSET_TOKENS.Prisma, useFactory: () => new PrismaClient({ datasources: { db: { url: requiredEnv('ASSET_MAINTENANCE_DATABASE_URL') } } }) },
    { provide: ASSET_TOKENS.Redis, useFactory: createAssetRedis },
    { provide: ASSET_TOKENS.Repository, useFactory: (prisma: PrismaClient) => new PrismaAssetRepository(prisma), inject: [ASSET_TOKENS.Prisma] },
    { provide: ASSET_TOKENS.Producer, useFactory: createAssetKafkaProducer },
    { provide: ASSET_TOKENS.IncidentPublisher, useFactory: (producer) => new KafkaIncidentPublisher(producer), inject: [ASSET_TOKENS.Producer] },
    { provide: ASSET_TOKENS.Lock, useFactory: (redis) => new RedisDistributedLock(redis), inject: [ASSET_TOKENS.Redis] },
    { provide: ASSET_TOKENS.Cursor, useFactory: (redis) => new RedisSchedulerCursorStore(redis), inject: [ASSET_TOKENS.Redis] },
    { provide: MaintenanceService, useFactory: (repository, incidents) => new MaintenanceService(repository, incidents), inject: [ASSET_TOKENS.Repository, ASSET_TOKENS.IncidentPublisher] },
    { provide: MaintenanceSchedulerService, useFactory: (repository, locks, cursors) => new MaintenanceSchedulerService(repository, locks, cursors), inject: [ASSET_TOKENS.Repository, ASSET_TOKENS.Lock, ASSET_TOKENS.Cursor] },
    SchedulerRunner,
  ],
})
export class AssetMaintenanceModule {}
