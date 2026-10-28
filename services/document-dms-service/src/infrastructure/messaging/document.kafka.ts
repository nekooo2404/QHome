import { randomUUID } from 'node:crypto';
import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { Kafka, Producer } from 'kafkajs';

interface DocumentKafkaProducer {
  send(input: { topic: string; key: string; value: Record<string, unknown> }): Promise<void>;
}

function client(): Kafka {
  const brokers = (process.env.DOCUMENT_DMS_KAFKA_BROKERS ?? '').split(',').map((value) => value.trim()).filter(Boolean);
  if (brokers.length < 3) throw new Error('DOCUMENT_DMS_KAFKA_BROKERS must contain at least three brokers');
  return new Kafka({ clientId: process.env.DOCUMENT_DMS_KAFKA_CLIENT_ID ?? 'document-dms-service', brokers, ssl: process.env.DOCUMENT_DMS_KAFKA_TLS === 'true', sasl: process.env.DOCUMENT_DMS_KAFKA_USERNAME && process.env.DOCUMENT_DMS_KAFKA_PASSWORD ? { mechanism: 'scram-sha-512', username: process.env.DOCUMENT_DMS_KAFKA_USERNAME, password: process.env.DOCUMENT_DMS_KAFKA_PASSWORD } : undefined });
}

export async function createDocumentKafkaProducer(): Promise<DocumentKafkaProducer> {
  const producer = client().producer({ idempotent: true, maxInFlightRequests: 5 });
  await producer.connect();
  return new ProducerAdapter(producer);
}

class ProducerAdapter implements DocumentKafkaProducer, OnModuleDestroy {
  constructor(private readonly producer: Producer) {}
  async send(input: { topic: string; key: string; value: Record<string, unknown> }): Promise<void> { await this.producer.send({ topic: input.topic, messages: [{ key: input.key, value: JSON.stringify(input.value) }] }); }
  async onModuleDestroy(): Promise<void> { await this.producer.disconnect(); }
}

export class DocumentOutboxRelay {
  private readonly owner = randomUUID();
  constructor(private readonly prisma: PrismaClient, private readonly producer: DocumentKafkaProducer) {}

  async publishBatch(limit = 100): Promise<number> {
    const events = [];
    for (let index = 0; index < limit; index += 1) {
      const event = await this.claimOne();
      if (!event) break;
      events.push(event);
    }
    for (const event of events) {
      try {
        await this.producer.send({ topic: event.topic, key: `${event.aggregateType}:${event.aggregateId}`, value: { eventId: event.eventId, eventType: event.eventType, aggregateType: event.aggregateType, aggregateId: event.aggregateId, projectId: event.projectId, payload: event.payload, occurredAt: event.occurredAt.toISOString() } });
        await this.prisma.outboxEvent.update({ where: { id: event.id }, data: { publishedAt: new Date(), leasedUntil: null, leaseOwner: null } });
      } catch (error: unknown) {
        await this.prisma.outboxEvent.update({ where: { id: event.id }, data: { attempts: { increment: 1 }, nextAttemptAt: new Date(Date.now() + Math.min(60_000, 1000 * (event.attempts + 1))), leasedUntil: null, leaseOwner: null, lastError: error instanceof Error ? error.message.slice(0, 2000) : 'Kafka publish failed' } });
      }
    }
    return events.length;
  }

  private async claimOne() {
    const now = new Date();
    return this.prisma.$transaction(async (tx) => {
      const candidate = await tx.outboxEvent.findFirst({ where: { publishedAt: null, nextAttemptAt: { lte: now }, OR: [{ leasedUntil: null }, { leasedUntil: { lt: now } }] }, orderBy: { occurredAt: 'asc' } });
      if (!candidate) return null;
      const updated = await tx.outboxEvent.updateMany({ where: { id: candidate.id, publishedAt: null, OR: [{ leasedUntil: null }, { leasedUntil: { lt: now } }] }, data: { leaseOwner: this.owner, leasedUntil: new Date(now.getTime() + 30_000) } });
      return updated.count === 1 ? candidate : null;
    });
  }
}

@Injectable()
export class DocumentOutboxScheduler implements OnModuleInit, OnModuleDestroy {
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  constructor(private readonly relay: DocumentOutboxRelay) {}
  onModuleInit(): void { this.timer = setInterval(() => { if (this.running) return; this.running = true; void this.relay.publishBatch().finally(() => { this.running = false; }); }, Number(process.env.DOCUMENT_DMS_OUTBOX_INTERVAL_MS ?? 250)); this.timer.unref(); }
  onModuleDestroy(): void { if (this.timer) clearInterval(this.timer); }
}
