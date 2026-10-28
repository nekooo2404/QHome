import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { MarketplaceRepository } from './ports';
import { OrderSagaOrchestrator } from './order-saga.orchestrator';

@Injectable()
export class OrderSagaRetryScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OrderSagaRetryScheduler.name);
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(private readonly repository: MarketplaceRepository, private readonly saga: OrderSagaOrchestrator) {}

  onModuleInit(): void {
    this.timer = setInterval(() => {
      if (this.running) return;
      this.running = true;
      void this.run().finally(() => { this.running = false; });
    }, Number(process.env.RESIDENT_MARKETPLACE_SAGA_RETRY_INTERVAL_MS ?? 5000));
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async run(): Promise<void> {
    const orders = await this.repository.findOrdersNeedingCompensation(new Date(), 25);
    for (const order of orders) {
      try {
        await this.saga.retryCompensation(order);
      } catch (error: unknown) {
        this.logger.warn(`compensation retry failed for order ${order.id}: ${error instanceof Error ? error.message : 'unknown error'}`);
      }
    }
  }
}
