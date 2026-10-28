import { Module } from '@nestjs/common';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { PrismaClient } from '@prisma/client';
import { GrpcBillingFinanceClient } from './infrastructure/billing/grpc-billing-finance.client';
import { MarketplaceOutboxRelay, MarketplaceOutboxScheduler, BillingPaymentEventConsumer, createMarketplaceKafkaProducer } from './infrastructure/messaging/marketplace.kafka';
import { MarketplacePrismaClient, PrismaMarketplaceRepository } from './infrastructure/prisma/prisma.marketplace.repository';
import { RedisMarketplaceCache, createMarketplaceRedis } from './infrastructure/redis/redis.cache';
import { MarketplaceService } from './application/marketplace.service';
import { OrderSagaOrchestrator } from './application/order-saga.orchestrator';
import { OrderSagaRetryScheduler } from './application/order-saga.retry.scheduler';
import { ResidentMarketplaceHttpController } from './interfaces/http/resident-marketplace.http.controller';
import { MARKETPLACE_TOKENS } from './marketplace.tokens';

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(name + ' is required');
  return value;
}

@Module({
  imports: [ClientsModule.register([{
    name: MARKETPLACE_TOKENS.BillingGrpcClient,
    transport: Transport.GRPC,
    options: {
      package: 'qhome.billing.finance.v1',
      protoPath: '../../../proto/billing_finance_marketplace.proto',
      url: process.env.BILLING_FINANCE_GRPC_URL ?? 'billing-finance-service:50054',
      includeDirs: ['../../../proto'],
      loader: { keepCase: false, longs: String, enums: String, defaults: true, oneofs: true },
    },
  }])],
  controllers: [ResidentMarketplaceHttpController],
  providers: [
    { provide: MARKETPLACE_TOKENS.Prisma, useFactory: () => new MarketplacePrismaClient({ datasources: { db: { url: requiredEnv('RESIDENT_MARKETPLACE_DATABASE_URL') } } }) },
    { provide: MARKETPLACE_TOKENS.Redis, useFactory: createMarketplaceRedis },
    { provide: MARKETPLACE_TOKENS.Cache, useFactory: (redis) => new RedisMarketplaceCache(redis), inject: [MARKETPLACE_TOKENS.Redis] },
    { provide: MARKETPLACE_TOKENS.Repository, useFactory: (prisma: PrismaClient) => new PrismaMarketplaceRepository(prisma), inject: [MARKETPLACE_TOKENS.Prisma] },
    { provide: MARKETPLACE_TOKENS.KafkaProducer, useFactory: createMarketplaceKafkaProducer },
    { provide: MARKETPLACE_TOKENS.OutboxRelay, useFactory: (prisma: PrismaClient, producer) => new MarketplaceOutboxRelay(prisma, producer), inject: [MARKETPLACE_TOKENS.Prisma, MARKETPLACE_TOKENS.KafkaProducer] },
    { provide: MarketplaceOutboxRelay, useExisting: MARKETPLACE_TOKENS.OutboxRelay },
    MarketplaceOutboxScheduler,
    { provide: MARKETPLACE_TOKENS.BillingClient, useFactory: (client) => new GrpcBillingFinanceClient(client), inject: [MARKETPLACE_TOKENS.BillingGrpcClient] },
    { provide: OrderSagaOrchestrator, useFactory: (repository, billing) => new OrderSagaOrchestrator(repository, billing), inject: [MARKETPLACE_TOKENS.Repository, MARKETPLACE_TOKENS.BillingClient] },
    { provide: OrderSagaRetryScheduler, useFactory: (repository, saga) => new OrderSagaRetryScheduler(repository, saga), inject: [MARKETPLACE_TOKENS.Repository, OrderSagaOrchestrator] },
    { provide: MarketplaceService, useFactory: (repository, cache, saga) => new MarketplaceService(repository, cache, saga), inject: [MARKETPLACE_TOKENS.Repository, MARKETPLACE_TOKENS.Cache, OrderSagaOrchestrator] },
    { provide: BillingPaymentEventConsumer, useFactory: (prisma, service) => new BillingPaymentEventConsumer(prisma, (event) => service.handleBillingEvent(event)), inject: [MARKETPLACE_TOKENS.Prisma, MarketplaceService] },
  ],
})
export class ResidentMarketplaceModule {}
