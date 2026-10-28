import { Logger, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Kafka } from 'kafkajs';
import { WorkforceService } from '../../application/workforce.service';
import { TaskRepository } from '../../application/ports';
import { WorkforceDistributedLock } from '../redis/redis.workforce';

function kafka() { const brokers = (process.env.WORKFORCE_KPI_KAFKA_BROKERS ?? '').split(',').map((value) => value.trim()).filter(Boolean); if (brokers.length < 3) throw new Error('WORKFORCE_KPI_KAFKA_BROKERS must contain at least three brokers'); return new Kafka({ clientId: process.env.WORKFORCE_KPI_KAFKA_CLIENT_ID ?? 'workforce-kpi-service', brokers, ssl: process.env.WORKFORCE_KPI_KAFKA_TLS === 'true' }); }

@Injectable()
export class WorkforceKafkaConsumer implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WorkforceKafkaConsumer.name);
  private readonly consumer = kafka().consumer({ groupId: process.env.WORKFORCE_KPI_KAFKA_GROUP_ID ?? 'workforce-kpi-service' });
  constructor(private readonly repository: TaskRepository, private readonly workforce: WorkforceService) {}

  async onModuleInit(): Promise<void> {
    await this.consumer.connect();
    for (const topic of (process.env.WORKFORCE_KPI_KAFKA_TOPICS ?? 'qhome.asset-maintenance.events.v1,qhome.workforce.high-priority-incidents.v1,qhome.resident-registration.events.v1,qhome.resident.events.v1').split(',').map((value) => value.trim()).filter(Boolean)) await this.consumer.subscribe({ topic, fromBeginning: false });
    await this.consumer.run({ eachMessage: async ({ message }) => {
      if (!message.value) return;
      const event = JSON.parse(message.value.toString()) as { eventId?: string; eventType?: string; projectId?: string; payload?: Record<string, unknown> };
      const projectId = event.projectId ?? (typeof event.payload?.projectId === 'string' ? event.payload.projectId : undefined);
      if (!event.eventId || !event.eventType || !projectId) return;
      if (!(await this.repository.beginInbox(event.eventId, event.eventType))) return;
      try { await this.workforce.handleEvent({ eventId: event.eventId, eventType: event.eventType, projectId, payload: event.payload ?? {} }); await this.repository.completeInbox(event.eventId); }
      catch (error: unknown) { await this.repository.failInbox(event.eventId, error instanceof Error ? error.message : 'event processing failed'); this.logger.error(error); throw error; }
    } });
  }
  async onModuleDestroy(): Promise<void> { await this.consumer.disconnect(); }
}

@Injectable()
export class WorkforceOverdueScheduler implements OnModuleInit, OnModuleDestroy {
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  constructor(private readonly repository: TaskRepository, private readonly lock: WorkforceDistributedLock) {}
  onModuleInit(): void { this.timer = setInterval(() => { if (this.running) return; this.running = true; void this.run().finally(() => { this.running = false; }); }, Number(process.env.WORKFORCE_KPI_OVERDUE_INTERVAL_MS ?? 60000)); this.timer.unref(); }
  onModuleDestroy(): void { if (this.timer) clearInterval(this.timer); }
  private async run(): Promise<void> { const lock = await this.lock.acquire('workforce-kpi:overdue-scan', 55_000); if (!lock) return; try { await this.repository.markOverdue(new Date(), 100); } finally { await lock.release(); } }
}
