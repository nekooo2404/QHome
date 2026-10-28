import { randomUUID } from 'node:crypto';
import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

export interface AssetOutboxProducer {
  send(input: { topic: string; key: string; value: Record<string, unknown> }): Promise<void>;
}

export class AssetOutboxRelay {
  private readonly owner = randomUUID();
  constructor(private readonly prisma: PrismaClient, private readonly producer: AssetOutboxProducer) {}

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
        await this.prisma.outboxEvent.update({ where: { id: event.id }, data: { attempts: { increment: 1 }, nextAttemptAt: new Date(Date.now() + Math.min(60_000, (event.attempts + 1) * 1000)), leasedUntil: null, leaseOwner: null, lastError: error instanceof Error ? error.message.slice(0, 2000) : 'Kafka publish failed' } });
      }
    }
    return events.length;
  }

  private async claimOne() {
    const now = new Date();
    return this.prisma.$transaction(async (tx) => {
      const candidate = await tx.outboxEvent.findFirst({ where: { publishedAt: null, nextAttemptAt: { lte: now }, OR: [{ leasedUntil: null }, { leasedUntil: { lt: now } }] }, orderBy: { occurredAt: 'asc' } });
      if (!candidate) return null;
      const claimed = await tx.outboxEvent.updateMany({ where: { id: candidate.id, publishedAt: null, OR: [{ leasedUntil: null }, { leasedUntil: { lt: now } }] }, data: { leaseOwner: this.owner, leasedUntil: new Date(now.getTime() + 30_000) } });
      return claimed.count === 1 ? candidate : null;
    });
  }
}

@Injectable()
export class AssetOutboxScheduler implements OnModuleInit, OnModuleDestroy {
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  constructor(private readonly relay: AssetOutboxRelay) {}
  onModuleInit(): void { this.timer = setInterval(() => { if (this.running) return; this.running = true; void this.relay.publishBatch().finally(() => { this.running = false; }); }, Number(process.env.ASSET_MAINTENANCE_OUTBOX_INTERVAL_MS ?? 250)); this.timer.unref(); }
  onModuleDestroy(): void { if (this.timer) clearInterval(this.timer); }
}
