import { Module } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { PricingCalculationEngine } from './domain/pricing-calculation.engine';
import { PricingApplicationServiceImpl } from './application/pricing.application.service';
import { CardLifecycleServiceImpl } from './application/card-lifecycle.service';
import { PrismaServiceCatalogRepository } from './infrastructure/prisma/prisma.service-catalog.repository';
import { CardRetryPublisher } from './infrastructure/messaging/retry.publisher';
import { CatalogOutboxRelay, CatalogOutboxScheduler } from './infrastructure/messaging/outbox-relay';
import { createCardKafkaProducer } from './infrastructure/messaging/kafka.client';
import { SERVICE_CATALOG_TOKENS } from './service-catalog-card.tokens';
import { ServiceCatalogCardGrpcController } from './interfaces/grpc/service-catalog-card.grpc.controller';
import { CardDebtKafkaController } from './interfaces/kafka/card-debt.kafka.controller';

function requiredEnv(name: string): string { const value = process.env[name]; if (!value) throw new Error(`${name} is required`); return value; }

@Module({
  controllers: [ServiceCatalogCardGrpcController, CardDebtKafkaController],
  providers: [
    { provide: SERVICE_CATALOG_TOKENS.Prisma, useFactory: () => new PrismaClient({ datasources: { db: { url: requiredEnv('SERVICE_CATALOG_DATABASE_URL') } } }) },
    { provide: SERVICE_CATALOG_TOKENS.Repository, useFactory: (prisma: PrismaClient) => new PrismaServiceCatalogRepository(prisma), inject: [SERVICE_CATALOG_TOKENS.Prisma] },
    { provide: PricingCalculationEngine, useClass: PricingCalculationEngine },
    { provide: SERVICE_CATALOG_TOKENS.Producer, useFactory: createCardKafkaProducer },
    { provide: SERVICE_CATALOG_TOKENS.RetryPublisher, useFactory: (producer) => new CardRetryPublisher(producer), inject: [SERVICE_CATALOG_TOKENS.Producer] },
    { provide: SERVICE_CATALOG_TOKENS.OutboxRelay, useFactory: (prisma: PrismaClient, producer) => new CatalogOutboxRelay(prisma, producer), inject: [SERVICE_CATALOG_TOKENS.Prisma, SERVICE_CATALOG_TOKENS.Producer] },
    { provide: CatalogOutboxRelay, useExisting: SERVICE_CATALOG_TOKENS.OutboxRelay },
    CatalogOutboxScheduler,
    { provide: PricingApplicationServiceImpl, useFactory: (repository, engine) => new PricingApplicationServiceImpl(repository, engine), inject: [SERVICE_CATALOG_TOKENS.Repository, PricingCalculationEngine] },
    { provide: CardLifecycleServiceImpl, useFactory: (repository, inbox, retryPublisher) => new CardLifecycleServiceImpl(repository, inbox, retryPublisher, Number(process.env.SERVICE_CATALOG_CARD_MAX_ATTEMPTS ?? 5)), inject: [SERVICE_CATALOG_TOKENS.Repository, SERVICE_CATALOG_TOKENS.Repository, SERVICE_CATALOG_TOKENS.RetryPublisher] },
  ],
})
export class ServiceCatalogCardModule {}
