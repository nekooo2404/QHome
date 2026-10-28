import { Module } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { PaymentService } from './application/payment.service';
import { PaymentWebhookService } from './application/webhook.service';
import { ReportService } from './application/report.service';
import { BillingFinanceHttpController } from './interfaces/http/billing-finance.http.controller';
import { PrismaBillingRepository } from './infrastructure/prisma/prisma.billing.repository';
import { RedisIdempotencyGate } from './infrastructure/redis/redis.idempotency';
import { createBillingRedis } from './infrastructure/redis/redis.cluster.client';
import { BILLING_TOKENS } from './billing-finance.tokens';
import { createBillingKafkaProducer } from './infrastructure/messaging/billing.kafka.client';
import { BillingOutboxRelay, BillingOutboxScheduler } from './infrastructure/messaging/billing.outbox.relay';

function requiredEnv(name: string): string { const value = process.env[name]; if (!value) throw new Error(name + ' is required'); return value; }

@Module({
  controllers: [BillingFinanceHttpController],
  providers: [
    { provide: BILLING_TOKENS.Prisma, useFactory: () => new PrismaClient({ datasources: { db: { url: requiredEnv('BILLING_FINANCE_DATABASE_URL') } } }) },
    { provide: BILLING_TOKENS.Redis, useFactory: createBillingRedis },
    { provide: BILLING_TOKENS.Repository, useFactory: (prisma: PrismaClient) => new PrismaBillingRepository(prisma), inject: [BILLING_TOKENS.Prisma] },
    { provide: BILLING_TOKENS.Idempotency, useFactory: (redis) => new RedisIdempotencyGate(redis), inject: [BILLING_TOKENS.Redis] },
    { provide: BILLING_TOKENS.KafkaProducer, useFactory: createBillingKafkaProducer },
    { provide: BILLING_TOKENS.OutboxRelay, useFactory: (prisma: PrismaClient, producer) => new BillingOutboxRelay(prisma, producer), inject: [BILLING_TOKENS.Prisma, BILLING_TOKENS.KafkaProducer] },
    { provide: BillingOutboxRelay, useExisting: BILLING_TOKENS.OutboxRelay },
    BillingOutboxScheduler,
    { provide: PaymentService, useFactory: (repository, accounts, idempotency) => new PaymentService(repository, accounts, idempotency), inject: [BILLING_TOKENS.Repository, BILLING_TOKENS.Repository, BILLING_TOKENS.Idempotency] },
    { provide: PaymentWebhookService, useFactory: (payments) => new PaymentWebhookService(payments, { BANK: requiredEnv('BANK_WEBHOOK_SECRET'), WALLET: requiredEnv('WALLET_WEBHOOK_SECRET') }), inject: [PaymentService] },
    { provide: ReportService, useFactory: (repository) => new ReportService(repository), inject: [BILLING_TOKENS.Repository] },
  ],
})
export class BillingFinanceModule {}
