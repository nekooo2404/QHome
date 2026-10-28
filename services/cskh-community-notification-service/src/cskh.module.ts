import { Module } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { CskhService } from './application/cskh.service';
import { CskhHttpController } from './interfaces/http/cskh.http.controller';
import { CskhPrismaClient, PrismaCskhRepository } from './infrastructure/prisma/prisma.cskh.repository';
import { CommunityAutomationConsumer, NotificationFanoutWorker, NotificationQueue } from './infrastructure/messaging/notification.worker';
import { CSKH_TOKENS } from './cskh.tokens';

function requiredEnv(name: string): string { const value = process.env[name]; if (!value) throw new Error(`${name} is required`); return value; }

@Module({
  controllers: [CskhHttpController],
  providers: [
    { provide: CSKH_TOKENS.Prisma, useFactory: () => new CskhPrismaClient({ datasources: { db: { url: requiredEnv('CSKH_NOTIFICATION_DATABASE_URL') } } }) },
    { provide: CSKH_TOKENS.Repository, useFactory: (prisma: PrismaClient) => new PrismaCskhRepository(prisma), inject: [CSKH_TOKENS.Prisma] },
    { provide: CSKH_TOKENS.Queue, useClass: NotificationQueue },
    { provide: CskhService, useFactory: (repository, queue) => new CskhService(repository, queue), inject: [CSKH_TOKENS.Repository, CSKH_TOKENS.Queue] },
    { provide: NotificationFanoutWorker, useFactory: (repository) => new NotificationFanoutWorker(repository), inject: [CSKH_TOKENS.Repository] },
    { provide: CommunityAutomationConsumer, useFactory: (service) => new CommunityAutomationConsumer(service), inject: [CskhService] },
  ],
})
export class CskhNotificationModule {}
