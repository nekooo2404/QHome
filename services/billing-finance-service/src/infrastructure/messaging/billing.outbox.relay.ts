import { randomUUID } from 'node:crypto';
import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

export interface BillingKafkaProducer {
  send(input: { topic: string; key: string; value: Record<string, unknown> }): Promise<void>;
}

interface ClaimedBillingEvent {
  id: string;
  topic: string;
  eventId: string;
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  projectId?: string;
  payload: unknown;
  occurredAt: Date;
  attempts: number;
}

export class BillingOutboxRelay {
  private readonly owner = randomUUID();
  constructor(private readonly prisma: PrismaClient, private readonly producer: BillingKafkaProducer) {}

  async publishBatch(limit = 100): Promise<number> {
    const events = await this.claimBatch(limit);
    if (events.length === 0) return 0;
    const results = await Promise.allSettled(events.map((event) => this.producer.send({ topic: event.topic, key: event.aggregateType + ':' + event.aggregateId, value: { eventId: event.eventId, eventType: event.eventType, aggregateType: event.aggregateType, aggregateId: event.aggregateId, projectId: event.projectId, payload: event.payload, occurredAt: event.occurredAt.toISOString() } })));
    const publishedIds = events.filter((_event, index) => results[index].status === 'fulfilled').map((event) => event.id);
    const failedIds = events.filter((_event, index) => results[index].status === 'rejected').map((event) => event.id);
    if (publishedIds.length) await this.prisma.outboxEvent.updateMany({ where: { id: { in: publishedIds }, leaseOwner: this.owner }, data: { status: 'PUBLISHED', publishedAt: new Date(), leasedUntil: null, leaseOwner: null } });
    if (failedIds.length) await this.prisma.outboxEvent.updateMany({ where: { id: { in: failedIds }, leaseOwner: this.owner }, data: { attempts: { increment: 1 }, nextAttemptAt: new Date(Date.now() + 1000), leasedUntil: null, leaseOwner: null, lastError: 'Kafka publish failed' } });
    return events.length;
  }

  private async claimBatch(limit: number): Promise<ClaimedBillingEvent[]> {
    const now = new Date();
    return this.prisma.$transaction(async (tx) => {
      const candidates = await tx.$queryRawUnsafe<ClaimedBillingEvent[]>(`SELECT id, topic, event_id AS "eventId", event_type AS "eventType", aggregate_type AS "aggregateType", aggregate_id AS "aggregateId", project_id AS "projectId", payload, occurred_at AS "occurredAt", attempts FROM outbox_events WHERE status = 'PENDING' AND next_attempt_at <= $1 AND (leased_until IS NULL OR leased_until < $1) ORDER BY occurred_at ASC, id ASC LIMIT $2 FOR UPDATE SKIP LOCKED`, now, limit);
      if (candidates.length === 0) return [];
      await tx.outboxEvent.updateMany({ where: { id: { in: candidates.map((event) => event.id) } }, data: { leaseOwner: this.owner, leasedUntil: new Date(now.getTime() + 30_000) } });
      return candidates;
    });
  }
}

@Injectable()
export class BillingOutboxScheduler implements OnModuleInit, OnModuleDestroy {
  private timer: NodeJS.Timeout | undefined;
  private active = false;
  constructor(private readonly relay: BillingOutboxRelay) {}
  onModuleInit(): void {
    this.timer = setInterval(() => {
      if (this.active) return;
      this.active = true;
      void this.relay.publishBatch().catch(() => undefined).finally(() => { this.active = false; });
    }, Number(process.env.BILLING_FINANCE_OUTBOX_INTERVAL_MS ?? 250));
    this.timer.unref();
  }
  onModuleDestroy(): void { if (this.timer) clearInterval(this.timer); }
}
