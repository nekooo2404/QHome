import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { NotificationChannel } from '@prisma/client';
import { Queue, Worker } from 'bullmq';
import CircuitBreaker from 'opossum';
import { CskhRepository, QueueAdapter } from '../../application/ports';
import { CskhService } from '../../application/cskh.service';

export interface NotificationMessage { id: string; channel: NotificationChannel; address: string; title: string; body: string; payload: Record<string, unknown>; }
export interface NotificationProvider { sendBatch(channel: NotificationChannel, messages: NotificationMessage[]): Promise<Array<{ id: string; ok: boolean; providerRef?: string; error?: string }>>; }

class ProviderGateway implements NotificationProvider {
  private readonly breakers = new Map<NotificationChannel, CircuitBreaker>();
  private readonly fcm: { sendEachForMulticast(input: { tokens: string[]; notification: { title: string; body: string }; data: Record<string, string> }): Promise<{ responses: Array<{ success: boolean; messageId?: string; error?: Error }> }> };

  constructor() {
    const firebase = require('firebase-admin/app') as typeof import('firebase-admin/app');
    const messaging = require('firebase-admin/messaging') as typeof import('firebase-admin/messaging');
    const app = firebase.getApps().length ? firebase.getApps()[0] : firebase.initializeApp({ credential: firebase.cert({ projectId: process.env.FCM_PROJECT_ID, clientEmail: process.env.FCM_CLIENT_EMAIL, privateKey: process.env.FCM_PRIVATE_KEY?.replace(/\\n/gu, '\n') }) });
    this.fcm = messaging.getMessaging(app);
  }

  async sendBatch(channel: NotificationChannel, messages: NotificationMessage[]) {
    if (channel === 'PUSH') {
      const result = await this.fcm.sendEachForMulticast({ tokens: messages.map((message) => message.address), notification: { title: messages[0]?.title ?? '', body: messages[0]?.body ?? '' }, data: Object.fromEntries(Object.entries(messages[0]?.payload ?? {}).map(([key, value]) => [key, String(value)])) });
      return messages.map((message, index) => ({ id: message.id, ok: result.responses[index]?.success ?? false, providerRef: result.responses[index]?.messageId, error: result.responses[index]?.error?.message }));
    }
    const breaker = this.breakers.get(channel) ?? this.createBreaker(channel);
    const results = await Promise.all(messages.map(async (message) => { try { const result = await breaker.fire(message) as { providerRef?: string }; return { id: message.id, ok: true, providerRef: result?.providerRef }; } catch (error: unknown) { return { id: message.id, ok: false, error: error instanceof Error ? error.message : 'provider error' }; } }));
    return results;
  }

  private createBreaker(channel: NotificationChannel) {
    const breaker = new CircuitBreaker(async (message: NotificationMessage) => {
      const endpoint = process.env[`CSKH_${channel}_PROVIDER_URL`];
      if (!endpoint) throw new Error(`${channel} provider endpoint is not configured`);
      const response = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env[`CSKH_${channel}_PROVIDER_TOKEN`] ?? ''}` }, body: JSON.stringify({ to: message.address, title: message.title, body: message.body, payload: message.payload }) });
      if (!response.ok) throw new Error(`${channel} provider returned HTTP ${response.status}`);
      return await response.json() as { providerRef?: string };
    }, { timeout: Number(process.env.CSKH_PROVIDER_TIMEOUT_MS ?? 5000), errorThresholdPercentage: 50, resetTimeout: Number(process.env.CSKH_PROVIDER_RESET_MS ?? 30000), volumeThreshold: 10 });
    this.breakers.set(channel, breaker);
    return breaker;
  }
}

@Injectable()
export class NotificationQueue implements QueueAdapter, OnModuleDestroy {
  private readonly critical = new Queue('cskh-critical-queue', { connection: { host: process.env.CSKH_REDIS_HOST ?? 'localhost', port: Number(process.env.CSKH_REDIS_PORT ?? 6379) } });
  private readonly bulk = new Queue('cskh-bulk-queue', { connection: { host: process.env.CSKH_REDIS_HOST ?? 'localhost', port: Number(process.env.CSKH_REDIS_PORT ?? 6379) } });
  async add(name: string, data: Record<string, unknown>, options?: Record<string, unknown>): Promise<void> { await (name === 'critical-fanout' ? this.critical : this.bulk).add(name, data, options); }
  async onModuleDestroy(): Promise<void> { await Promise.all([this.critical.close(), this.bulk.close()]); }
}

@Injectable()
export class NotificationFanoutWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(NotificationFanoutWorker.name);
  private readonly provider = new ProviderGateway();
  private readonly workers: Worker[] = [];
  constructor(private readonly repository: CskhRepository) {}

  onModuleInit(): void {
    for (const queueName of ['cskh-critical-queue', 'cskh-bulk-queue']) this.workers.push(new Worker(queueName, async (job) => this.processCampaign(String(job.data.campaignId)), { connection: { host: process.env.CSKH_REDIS_HOST ?? 'localhost', port: Number(process.env.CSKH_REDIS_PORT ?? 6379) }, concurrency: queueName === 'cskh-critical-queue' ? 20 : 5 }));
  }

  async onModuleDestroy(): Promise<void> { await Promise.all(this.workers.map((worker) => worker.close())); }

  private async processCampaign(campaignId: string): Promise<void> {
    const campaign = await this.repository.getCampaign(campaignId);
    if (!campaign) throw new Error('Notification campaign not found');
    let cursor: string | undefined;
    do {
      const page = await this.repository.listEndpoints(campaign.projectId, campaign.targetFilter, campaign.channels, 500, cursor);
      if (!page.items.length) break;
      const ids = await this.repository.createDeliveryLogs({ campaignId, projectId: campaign.projectId, endpoints: page.items.map((item) => ({ id: item.id, channel: item.channel })), providerByChannel: { PUSH: 'FCM', EMAIL: 'EMAIL', SMS: 'SMS', ZALO_ZNS: 'ZNS' } });
      const messages = await this.repository.getDeliveryBatch(ids);
      for (const channel of ['PUSH', 'EMAIL', 'SMS', 'ZALO_ZNS'] as NotificationChannel[]) {
        const batch = messages.filter((message) => message.channel === channel);
        if (!batch.length) continue;
        const results = await this.provider.sendBatch(channel, batch);
        await Promise.all(results.map((result) => result.ok ? this.repository.completeDelivery(result.id, result.providerRef) : this.repository.failDelivery(result.id, 'PROVIDER_ERROR', result.error ?? 'Provider failed', new Date(Date.now() + 1000))));
      }
      cursor = page.nextCursor;
    } while (cursor);
    this.logger.log(`notification campaign ${campaignId} fan-out completed`);
  }
}

@Injectable()
export class CommunityAutomationConsumer implements OnModuleInit, OnModuleDestroy {
  private readonly consumer = new (require('kafkajs').Kafka)({ clientId: 'cskh-community-automation', brokers: (process.env.CSKH_KAFKA_BROKERS ?? '').split(',').map((value: string) => value.trim()).filter(Boolean), ssl: process.env.CSKH_KAFKA_TLS === 'true' }).consumer({ groupId: process.env.CSKH_AUTOMATION_GROUP_ID ?? 'cskh-community-automation' });
  constructor(private readonly service: CskhService) {}
  async onModuleInit(): Promise<void> {
    await this.consumer.connect();
    for (const topic of (process.env.CSKH_AUTOMATION_TOPICS ?? 'qhome.property.events.v1,qhome.community.events.v1').split(',').map((value) => value.trim()).filter(Boolean)) await this.consumer.subscribe({ topic, fromBeginning: false });
    await this.consumer.run({ eachMessage: async ({ message }: any) => {
      if (!message.value) return;
      const event = JSON.parse(message.value.toString()) as { eventType?: string; projectId?: string; payload?: Record<string, unknown> };
      const payload = event.payload ?? {};
      const userId = typeof payload.userId === 'string' ? payload.userId : typeof payload.residentId === 'string' ? payload.residentId : undefined;
      if (!event.projectId || !userId) return;
      if (event.eventType === 'property.resident.created.v1' || event.eventType === 'property.resident.handover_completed.v1') await this.service.enqueueAutomaticCampaign({ projectId: event.projectId, userId, title: 'Chào mừng cư dân QHome', body: 'Chào mừng bạn đến với cộng đồng QHome.' });
      if (event.eventType === 'resident.birthday.v1') await this.service.enqueueAutomaticCampaign({ projectId: event.projectId, userId, title: 'Chúc mừng sinh nhật', body: 'QHome chúc bạn một sinh nhật vui vẻ.' });
      if (event.eventType === 'community.special_event.v1') await this.service.enqueueAutomaticCampaign({ projectId: event.projectId, userId, title: String(payload.title ?? 'Thông báo sự kiện đặc biệt'), body: String(payload.body ?? '') });
    } });
  }
  async onModuleDestroy(): Promise<void> { await this.consumer.disconnect(); }
}
