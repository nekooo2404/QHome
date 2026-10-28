import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { MaintenanceSchedulerService } from './scheduler.service';

@Injectable()
export class SchedulerRunner implements OnModuleInit, OnModuleDestroy {
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  constructor(private readonly scheduler: MaintenanceSchedulerService) {}

  onModuleInit(): void {
    this.timer = setInterval(() => {
      if (this.running) return;
      this.running = true;
      void Promise.all([this.scheduler.scanDueMaintenance(), this.scheduler.scanDuePccc()]).catch(() => undefined).finally(() => { this.running = false; });
    }, Number(process.env.ASSET_MAINTENANCE_SCHEDULER_INTERVAL_MS ?? 60_000));
    this.timer.unref();
  }

  onModuleDestroy(): void { if (this.timer) clearInterval(this.timer); }
}
