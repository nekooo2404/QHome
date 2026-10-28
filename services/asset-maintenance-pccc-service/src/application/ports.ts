import { ChecklistItemDefinition, ChecklistSubmissionItem } from '../domain/checklist';
import { MaintenanceTransition } from '../domain/maintenance.state-machine';

export interface AssetRepository {
  createAsset(input: Record<string, unknown>, actorId: string, correlationId: string): Promise<unknown>;
  getAsset(projectId: string, assetId: string): Promise<unknown | null>;
  updateAsset(input: { projectId: string; assetId: string; expectedVersion: number; patch: Record<string, unknown>; actorId: string; correlationId: string }): Promise<unknown>;
  transitionWorkOrder(input: { projectId: string; workOrderId: string; expectedVersion: number; transition: MaintenanceTransition; nextStatus: string }): Promise<unknown>;
  getChecklistDefinitions(templateId: string): Promise<ChecklistItemDefinition[]>;
  submitChecklist(input: { projectId: string; buildingId: string; executionId: string; assetId?: string; templateId: string; actorId: string; results: ChecklistSubmissionItem[]; highPriority: boolean; correlationId: string }): Promise<{ executionId: string; incidentId?: string; workOrderId?: string }>;
  findDueMaintenancePlans(now: Date, limit: number, cursor?: string): Promise<{ items: Array<{ id: string; projectId: string; assetId: string; partnerId?: string; nextDueAt: Date; intervalDays: number }>; nextCursor?: string }>;
  findDuePcccDevices(now: Date, limit: number, cursor?: string): Promise<{ items: Array<{ deviceId: string; projectId: string; buildingId: string; assetId: string; nextInspectionAt: Date; intervalDays: number }>; nextCursor?: string }>;
  createScheduledWorkOrder(input: { projectId: string; assetId: string; maintenancePlanId?: string; source: string; priority: string; dueAt: Date; deduplicationKey: string; title: string; description?: string }): Promise<{ created: boolean; workOrderId: string }>;
  createPcccExpiryWorkOrder(input: { projectId: string; buildingId: string; assetId: string; deviceId: string; dueAt: Date; deduplicationKey: string }): Promise<{ created: boolean; workOrderId: string }>;
}

export interface IncidentPublisher {
  publishHighPriorityIncident(input: { eventId: string; projectId: string; buildingId: string; assetId?: string; incidentType: string; sourceId: string; title: string; description: string; actorId: string; correlationId: string }): Promise<void>;
}

export interface DistributedLockProvider {
  acquire(key: string, ttlMs: number): Promise<{ release(): Promise<void> } | null>;
}

export interface SchedulerCursorStore {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
}
