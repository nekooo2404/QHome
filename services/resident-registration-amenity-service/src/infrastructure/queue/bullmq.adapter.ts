import { Queue } from 'bullmq';
import { DelayedQueue } from '../../application/ports';

export class BullMqDelayedQueue implements DelayedQueue {
  private readonly queue: Queue;
  constructor(redis: { host: string; port: number; password?: string }) {
    this.queue = new Queue('resident-registration-critical', { connection: redis });
  }
  async add(name: string, data: Record<string, unknown>, options: { jobId: string; delay: number; attempts: number }): Promise<void> {
    await this.queue.add(name, data, { jobId: options.jobId, delay: options.delay, attempts: options.attempts, backoff: { type: 'exponential', delay: 1000 }, removeOnComplete: true, removeOnFail: false });
  }
}
