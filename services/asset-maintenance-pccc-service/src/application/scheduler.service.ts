import { AssetRepository, DistributedLockProvider, SchedulerCursorStore } from './ports';

export class MaintenanceSchedulerService {
  constructor(private readonly repository: AssetRepository, private readonly locks: DistributedLockProvider, private readonly cursors: SchedulerCursorStore, private readonly lockTtlMs = 55_000, private readonly pageSize = 200) {}

  async scanDueMaintenance(now = new Date()): Promise<{ created: number; skipped: boolean }> {
    const lock = await this.locks.acquire('qhome:asset-maintenance:scheduler:maintenance-due', this.lockTtlMs);
    if (!lock) return { created: 0, skipped: true };
    try {
      let cursor = await this.cursors.get('maintenance-due');
      let created = 0;
      do {
        const page = await this.repository.findDueMaintenancePlans(now, this.pageSize, cursor);
        for (const plan of page.items) {
          const result = await this.repository.createScheduledWorkOrder({ projectId: plan.projectId, assetId: plan.assetId, maintenancePlanId: plan.id, source: 'SCHEDULED', priority: 'NORMAL', dueAt: plan.nextDueAt, deduplicationKey: 'maintenance-plan:' + plan.id + ':' + plan.nextDueAt.toISOString(), title: 'Scheduled maintenance: ' + plan.id });
          if (result.created) created += 1;
        }
        cursor = page.nextCursor;
        if (cursor) await this.cursors.set('maintenance-due', cursor, 300);
      } while (cursor);
      return { created, skipped: false };
    } finally {
      await lock.release();
    }
  }

  async scanDuePccc(now = new Date()): Promise<{ created: number; skipped: boolean }> {
    const lock = await this.locks.acquire('qhome:asset-maintenance:scheduler:pccc-expiry', this.lockTtlMs);
    if (!lock) return { created: 0, skipped: true };
    try {
      let cursor = await this.cursors.get('pccc-expiry');
      let created = 0;
      do {
        const page = await this.repository.findDuePcccDevices(now, this.pageSize, cursor);
        for (const device of page.items) {
          const result = await this.repository.createPcccExpiryWorkOrder({ projectId: device.projectId, buildingId: device.buildingId, assetId: device.assetId, deviceId: device.deviceId, dueAt: device.nextInspectionAt, deduplicationKey: 'pccc-expiry:' + device.deviceId + ':' + device.nextInspectionAt.toISOString() });
          if (result.created) created += 1;
        }
        cursor = page.nextCursor;
        if (cursor) await this.cursors.set('pccc-expiry', cursor, 300);
      } while (cursor);
      return { created, skipped: false };
    } finally {
      await lock.release();
    }
  }
}
