import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';

export interface KafkaProducer {
  send(input: {
    topic: string;
    messages: Array<{
      key: string;
      value: string;
      headers: Record<string, string>;
    }>;
  }): Promise<void>;
}

interface ClaimedOutboxEvent {
  id: string;
  topic: string;
  eventId: string;
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  payload: unknown;
  headers: unknown;
  occurredAt: Date;
}

export class KafkaOutboxRelay {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly producer: KafkaProducer,
    private readonly serviceInstanceId = randomUUID(),
    private readonly leaseMs = 30_000,
  ) {}

  async publishBatch(batchSize = 100): Promise<number> {
    const published: ClaimedOutboxEvent[] = [];
    for (let index = 0; index < batchSize; index += 1) {
      const event = await this.claimOne();
      if (!event) break;
      published.push(event);
    }
    if (published.length === 0) return 0;

    try {
      const byTopic = new Map<string, ClaimedOutboxEvent[]>();
      for (const event of published) {
        const topicEvents = byTopic.get(event.topic) ?? [];
        topicEvents.push(event);
        byTopic.set(event.topic, topicEvents);
      }
      for (const [topic, events] of byTopic) {
        await this.producer.send({
          topic,
          messages: events.map((event) => ({
            key: `${event.aggregateType}:${event.aggregateId}`,
            value: JSON.stringify({
              eventId: event.eventId,
              eventType: event.eventType,
              aggregateType: event.aggregateType,
              aggregateId: event.aggregateId,
              payload: event.payload,
              occurredAt: event.occurredAt.toISOString(),
            }),
            headers: this.normalizeHeaders(event.headers),
          })),
        });
      }
      await this.prisma.outboxEvent.updateMany({
        where: { id: { in: published.map((event) => event.id) }, leaseOwner: this.serviceInstanceId },
        data: { publishedAt: new Date(), leasedUntil: null, leaseOwner: null },
      });
      return published.length;
    } catch (error) {
      const now = Date.now();
      await this.prisma.outboxEvent.updateMany({
        where: { id: { in: published.map((event) => event.id) }, leaseOwner: this.serviceInstanceId },
        data: {
          attempts: { increment: 1 },
          nextAttemptAt: new Date(now + 1000),
          leasedUntil: null,
          leaseOwner: null,
          lastError: error instanceof Error ? error.message.slice(0, 2000) : 'Kafka publish failed',
        },
      });
      throw error;
    }
  }

  private async claimOne(): Promise<ClaimedOutboxEvent | null> {
    const now = new Date();
    const leaseUntil = new Date(now.getTime() + this.leaseMs);
    return this.prisma.$transaction(async (tx) => {
      const candidate = await tx.outboxEvent.findFirst({
        where: {
          publishedAt: null,
          nextAttemptAt: { lte: now },
          OR: [{ leasedUntil: null }, { leasedUntil: { lt: now } }],
        },
        orderBy: { occurredAt: 'asc' },
      });
      if (!candidate) return null;
      const updated = await tx.outboxEvent.updateMany({
        where: {
          id: candidate.id,
          publishedAt: null,
          OR: [{ leasedUntil: null }, { leasedUntil: { lt: now } }],
        },
        data: { leaseOwner: this.serviceInstanceId, leasedUntil: leaseUntil },
      });
      if (updated.count !== 1) return null;
      return candidate;
    });
  }

  private normalizeHeaders(value: unknown): Record<string, string> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    const result: Record<string, string> = {};
    for (const [key, header] of Object.entries(value)) {
      if (typeof header === 'string') result[key] = header;
    }
    return result;
  }
}
