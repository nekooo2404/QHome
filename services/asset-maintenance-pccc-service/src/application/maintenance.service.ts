import { hasHighPriorityIncident, validateChecklistSubmission, ChecklistSubmissionItem } from '../domain/checklist';
import { transitionMaintenanceWorkOrder } from '../domain/maintenance.state-machine';
import { AssetRepository } from './ports';

export class MaintenanceService {
  constructor(private readonly repository: AssetRepository) {}

  createAsset(input: Record<string, unknown>, actorId: string, correlationId: string): Promise<unknown> {
    return this.repository.createAsset(input, actorId, correlationId);
  }

  getAsset(projectId: string, assetId: string): Promise<unknown | null> {
    return this.repository.getAsset(projectId, assetId);
  }

  updateAsset(input: { projectId: string; assetId: string; expectedVersion: number; patch: Record<string, unknown>; actorId: string; correlationId: string }): Promise<unknown> {
    return this.repository.updateAsset(input);
  }

  async transitionWorkOrder(input: { projectId: string; workOrderId: string; currentStatus: 'OPEN' | 'ASSIGNED' | 'IN_PROGRESS' | 'BLOCKED' | 'COMPLETED' | 'CANCELLED'; nextStatus: 'OPEN' | 'ASSIGNED' | 'IN_PROGRESS' | 'BLOCKED' | 'COMPLETED' | 'CANCELLED'; expectedVersion: number; actorId: string; reason?: string; correlationId: string }): Promise<unknown> {
    const transition = transitionMaintenanceWorkOrder({ current: input.currentStatus, next: input.nextStatus, actorId: input.actorId, reason: input.reason });
    return this.repository.transitionWorkOrder({ ...input, transition, nextStatus: input.nextStatus, correlationId: input.correlationId });
  }

  async submitChecklist(input: { projectId: string; executionId: string; assetId?: string; templateId: string; actorId: string; results: ChecklistSubmissionItem[]; buildingId: string; correlationId: string }): Promise<unknown> {
    const definitions = await this.repository.getChecklistDefinitions(input.templateId);
    validateChecklistSubmission(definitions, input.results);
    const highPriority = hasHighPriorityIncident(input.results);
    return this.repository.submitChecklist({ ...input, buildingId: input.buildingId, highPriority });
  }

  recordPcccInspection(input: { projectId: string; buildingId: string; deviceId: string; assetId: string; inspectedBy: string; status: 'PASSED' | 'FAILED'; inspectedAt: string; validUntil?: string; findings?: string; certificateRef?: string; correlationId: string }) {
    const inspectedAt = new Date(input.inspectedAt);
    const validUntil = input.validUntil ? new Date(input.validUntil) : undefined;
    if (!Number.isFinite(inspectedAt.getTime()) || (validUntil && !Number.isFinite(validUntil.getTime()))) throw new Error('inspection dates are invalid');
    return this.repository.recordPcccInspection({ ...input, inspectedAt, validUntil });
  }
}
