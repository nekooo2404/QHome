import { randomUUID } from 'node:crypto';
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { Kafka, Producer } from 'kafkajs';
import { KafkaProducer } from '../../application/ports';

export const MARKETPLACE_EVENTS_TOPIC = 'qhome.marketplace.events.v1';
export const BILLING_EVENTS_TOPIC = 'qhome.billing.events.v1';

function kafkaClient(clientId: string): Kafka {
  const brokers = (process.env.RESIDENT_MARKETPLACE_KAFKA_BROKERS ?? '').split(',').map((value) => value.trim()).filter(Boolean);
  if (brokers.length < 3) throw new Error('RESIDENT_MARKETPLACE_KAFKA_BROKERS must contain at least three brokers');
  return new Kafka({
    clientId,
    brokers,
    ssl: process.env.RESIDENT_MARKETPLACE_KAFKA_TLS === 'true',
    sasl: process.env.RESIDENT_MARKETPLACE_KAFKA_USERNAME && process.env.RESIDENT_MARKETPLACE_KAFKA_PASSWORD
      ? { mechanism: 'scram-sha-512', username: process.env.RESIDENT_MARKETPLACE_KAFKA_USERNAME, password: process.env.RESIDENT_MARKETPLACE_KAFKA_PASSWORD }
      : undefined,
  });
}

class MarketplaceKafkaProducerClient implements KafkaProducer, OnModuleDestroy {
  constructor(private readonly producer: Producer) {}

  send(input: { topic: string; key: string; value: Record<string, unknown>; headers?: Record<string, string> }): Promise<void> {
    return this.producer.send({ topic: input.topic, messages: [{ key: input.key, value: JSON.stringify(input.value), headers: input.headers }] }).then(() => undefined);
  }

  async close(): Promise<void> {
    await this.producer.disconnect();
  }

  onModuleDestroy(): Promise<void> {
    return this.close();
  }
}

export async function createMarketplaceKafkaProducer(): Promise<KafkaProducer> {
  const producer = kafkaClient(process.env.RESIDENT_MARKETPLACE_KAFKA_CLIENT_ID ?? 'resident-marketplace-service').producer({ idempotent: true, maxInFlightRequests: 5 });
  await producer.connect();
  return new MarketplaceKafkaProducerClient(producer);
}

export class MarketplaceOutboxRelay {
  private readonly owner = randomUUID();

  constructor(private readonly prisma: PrismaClient, private readonly producer: KafkaProducer) {}

  async publishBatch(limit = 100): Promise<number> {
    const events = [];
    for (let index = 0; index < limit; index += 1) {
      const event = await this.claimOne();
      if (!event) break;
      events.push(event);
    }
    for (const event of events) {
      try {
        await this.producer.send({
          topic: event.topic,
          key: `${event.aggregateType}:${event.aggregateId}`,
          value: { eventId: event.eventId, eventType: event.eventType, aggregateType: event.aggregateType, aggregateId: event.aggregateId, projectId: event.projectId, payload: event.payload, occurredAt: event.occurredAt.toISOString() },
          headers: { 'x-event-id': event.eventId, 'x-event-type': event.eventType },
        });
        await this.prisma.outboxEvent.update({ where: { id: event.id }, data: { status: 'PUBLISHED', publishedAt: new Date(), leasedUntil: null, leaseOwner: null } });
      } catch (error: unknown) {
        await this.prisma.outboxEvent.update({ where: { id: event.id }, data: { status: 'FAILED', attempts: { increment: 1 }, nextAttemptAt: new Date(Date.now() + Math.min(60_000, 1000 * (event.attempts + 1))), leasedUntil: null, leaseOwner: null, lastError: error instanceof Error ? error.message.slice(0, 2000) : 'Kafka publish failed' } });
      }
    }
    return events.length;
  }

  private async claimOne() {
    const now = new Date();
    return this.prisma.$transaction(async (tx) => {
      const candidate = await tx.outboxEvent.findFirst({ where: { status: { in: ['PENDING', 'FAILED'] }, nextAttemptAt: { lte: now }, OR: [{ leasedUntil: null }, { leasedUntil: { lt: now } }] }, orderBy: { occurredAt: 'asc' } });
      if (!candidate) return null;
      const claimed = await tx.outboxEvent.updateMany({ where: { id: candidate.id, status: { in: ['PENDING', 'FAILED'] }, OR: [{ leasedUntil: null }, { leasedUntil: { lt: now } }] }, data: { leasedUntil: new Date(now.getTime() + 30_000), leaseOwner: this.owner } });
      return claimed.count === 1 ? candidate : null;
    });
  }
}

@Injectable()
export class MarketplaceOutboxScheduler implements OnModuleInit, OnModuleDestroy {
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(private readonly relay: MarketplaceOutboxRelay) {}

  onModuleInit(): void {
    this.timer = setInterval(() => {
      if (this.running) return;
      this.running = true;
      void this.relay.publishBatch().finally(() => { this.running = false; });
    }, Number(process.env.RESIDENT_MARKETPLACE_OUTBOX_INTERVAL_MS ?? 250));
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }
}

export type BillingEventHandler = (event: { eventId: string; eventType: string; projectId: string; orderId: string; paymentIntentId: string; refundId?: string; amountMinorUnits?: string; currencyCode?: string; occurredAt?: string; correlationId?: string }) => Promise<unknown>;

@Injectable()
export class BillingPaymentEventConsumer implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BillingPaymentEventConsumer.name);
  private readonly consumer = kafkaClient(process.env.RESIDENT_MARKETPLACE_KAFKA_CLIENT_ID ?? 'resident-marketplace-service').consumer({ groupId: process.env.RESIDENT_MARKETPLACE_KAFKA_GROUP_ID ?? 'resident-marketplace-service' });

  constructor(private readonly prisma: PrismaClient, private readonly handler: BillingEventHandler) {}

  async onModuleInit(): Promise<void> {
    await this.consumer.connect();
    await this.consumer.subscribe({ topic: BILLING_EVENTS_TOPIC, fromBeginning: false });
    await this.consumer.run({ eachMessage: async ({ message }) => {
      if (!message.value) return;
      const event = JSON.parse(message.value.toString()) as { eventId?: string; eventType?: string; projectId?: string; payload?: Record<string, unknown> };
      const payload = event.payload ?? {};
      const eventId = String(event.eventId ?? message.headers?.['x-event-id'] ?? '');
      const eventType = String(event.eventType ?? message.headers?.['x-event-type'] ?? '');
      if (!eventId || !eventType || typeof payload.orderId !== 'string' || typeof payload.paymentIntentId !== 'string' || typeof event.projectId !== 'string') {
        this.logger.warn('ignoring malformed billing event');
        return;
      }
      if (!(await this.prisma.$transaction(async (tx) => {
        const existing = await tx.inboxMessage.findUnique({ where: { eventId } });
        if (existing?.status === 'PROCESSED') return false;
        if (existing) {
          await tx.inboxMessage.update({ where: { eventId }, data: { status: 'PROCESSING', attempts: { increment: 1 }, lastError: null } });
        } else {
          await tx.inboxMessage.create({ data: { eventId, eventType, status: 'PROCESSING', attempts: 1 } });
        }
        return true;
      }))) return;
      try {
        await this.handler({ eventId, eventType, projectId: event.projectId, orderId: String(payload.orderId), paymentIntentId: String(payload.paymentIntentId), refundId: typeof payload.refundId === 'string' ? payload.refundId : undefined, amountMinorUnits: typeof payload.amountMinorUnits === 'string' ? payload.amountMinorUnits : undefined, currencyCode: typeof payload.currencyCode === 'string' ? payload.currencyCode : undefined, occurredAt: typeof payload.occurredAt === 'string' ? payload.occurredAt : undefined, correlationId: typeof payload.correlationId === 'string' ? payload.correlationId : undefined });
        await this.prisma.inboxMessage.update({ where: { eventId }, data: { status: 'PROCESSED', processedAt: new Date(), lastError: null } });
      } catch (error: unknown) {
        await this.prisma.inboxMessage.update({ where: { eventId }, data: { status: 'FAILED', lastError: error instanceof Error ? error.message.slice(0, 2000) : 'billing event processing failed' } });
        throw error;
      }
    } });
  }

  async onModuleDestroy(): Promise<void> {
    await this.consumer.disconnect();
  }
}
