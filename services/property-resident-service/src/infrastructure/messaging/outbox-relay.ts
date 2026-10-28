import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';

export interface PropertyKafkaProducer {
  send(input: { topic: string; messages: Array<{ key: string; value: string; headers: Record<string, string> }> }): Promise<void>;
}

export class PropertyResidentOutboxRelay {
  private readonly owner = randomUUID();

  constructor(private readonly prisma: PrismaClient, private readonly producer: PropertyKafkaProducer) {}

  async publishBatch(limit = 100): Promise<number> {
    const events = [];
    for (let index = 0; index < limit; index += 1) {
      const event = await this.claimOne();
      if (!event) break;
      events.push(event);
    }
    if (events.length === 0) return 0;
    try {
      const grouped = new Map<string, typeof events>();
      for (const event of events) grouped.set(event.topic, [...(grouped.get(event.topic) ?? []), event]);
      for (const [topic, topicEvents] of grouped) {
        await this.producer.send({
          topic,
          messages: topicEvents.map((event) => ({ key: `${event.aggregateType}:${event.aggregateId}`, value: JSON.stringify({ eventId: event.eventId, eventType: event.eventType, aggregateType: event.aggregateType, aggregateId: event.aggregateId, payload: event.payload, occurredAt: event.occurredAt.toISOString() }), headers: {} })),
        });
      }
      await this.prisma.outboxEvent.updateMany({ where: { id: { in: events.map((event) => event.id) }, leaseOwner: this.owner }, data: { publishedAt: new Date(), leasedUntil: null, leaseOwner: null } });
      return events.length;
    } catch (error) {
      await this.prisma.outboxEvent.updateMany({ where: { id: { in: events.map((event) => event.id) }, leaseOwner: this.owner }, data: { attempts: { increment: 1 }, nextAttemptAt: new Date(Date.now() + 1000), leasedUntil: null, leaseOwner: null, lastError: error instanceof Error ? error.message.slice(0, 2000) : 'Kafka publish failed' } });
      throw error;
    }
  }

  private async claimOne() {
    const now = new Date();
    return this.prisma.$transaction(async (tx) => {
      const candidate = await tx.outboxEvent.findFirst({ where: { publishedAt: null, nextAttemptAt: { lte: now }, OR: [{ leasedUntil: null }, { leasedUntil: { lt: now } }] }, orderBy: { occurredAt: 'asc' } });
      if (!candidate) return null;
      const result = await tx.outboxEvent.updateMany({ where: { id: candidate.id, publishedAt: null, OR: [{ leasedUntil: null }, { leasedUntil: { lt: now } }] }, data: { leaseOwner: this.owner, leasedUntil: new Date(now.getTime() + 30_000) } });
      return result.count === 1 ? candidate : null;
    });
  }
}

@Injectable()
export class PropertyResidentOutboxScheduler implements OnModuleInit, OnModuleDestroy {
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(private readonly relay: PropertyResidentOutboxRelay) {}

  onModuleInit(): void {
    const intervalMs = Number(process.env.PROPERTY_RESIDENT_OUTBOX_INTERVAL_MS ?? 250);
    this.timer = setInterval(() => {
      if (this.running) return;
      this.running = true;
      void this.relay.publishBatch().catch(() => undefined).finally(() => { this.running = false; });
    }, intervalMs);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }
}
