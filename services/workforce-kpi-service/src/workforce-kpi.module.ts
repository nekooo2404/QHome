import { Module } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { WorkforceService } from './application/workforce.service';
import { WorkforceHttpController } from './interfaces/http/workforce.http.controller';
import { PrismaWorkforceRepository, WorkforcePrismaClient } from './infrastructure/prisma/prisma.workforce.repository';
import { WorkforceKafkaConsumer, WorkforceOverdueScheduler } from './infrastructure/messaging/workforce.kafka';
import { WORKFORCE_KPI_TOKENS } from './workforce-kpi.tokens';
import { WorkforceDistributedLock, createWorkforceRedis } from './infrastructure/redis/redis.workforce';

function requiredEnv(name: string): string { const value = process.env[name]; if (!value) throw new Error(`${name} is required`); return value; }

@Module({
  controllers: [WorkforceHttpController],
  providers: [
    { provide: WORKFORCE_KPI_TOKENS.Prisma, useFactory: () => new WorkforcePrismaClient({ datasources: { db: { url: requiredEnv('WORKFORCE_KPI_DATABASE_URL') } } }) },
    { provide: WORKFORCE_KPI_TOKENS.Repository, useFactory: (prisma: PrismaClient) => new PrismaWorkforceRepository(prisma), inject: [WORKFORCE_KPI_TOKENS.Prisma] },
    { provide: WORKFORCE_KPI_TOKENS.Redis, useFactory: createWorkforceRedis },
    { provide: WORKFORCE_KPI_TOKENS.Lock, useFactory: (redis) => new WorkforceDistributedLock(redis), inject: [WORKFORCE_KPI_TOKENS.Redis] },
    { provide: WorkforceService, useFactory: (repository) => new WorkforceService(repository), inject: [WORKFORCE_KPI_TOKENS.Repository] },
    { provide: WorkforceKafkaConsumer, useFactory: (repository, workforce) => new WorkforceKafkaConsumer(repository, workforce), inject: [WORKFORCE_KPI_TOKENS.Repository, WorkforceService] },
    { provide: WorkforceOverdueScheduler, useFactory: (repository, lock) => new WorkforceOverdueScheduler(repository, lock), inject: [WORKFORCE_KPI_TOKENS.Repository, WORKFORCE_KPI_TOKENS.Lock] },
  ],
})
export class WorkforceKpiModule {}
