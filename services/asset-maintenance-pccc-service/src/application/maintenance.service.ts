import { randomUUID } from 'node:crypto';
import { hasHighPriorityIncident, validateChecklistSubmission, ChecklistSubmissionItem } from '../domain/checklist';
import { transitionMaintenanceWorkOrder } from '../domain/maintenance.state-machine';
import { AssetRepository, IncidentPublisher } from './ports';

export class MaintenanceService {
  constructor(private readonly repository: AssetRepository, private readonly incidents: IncidentPublisher) {}

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
    return this.repository.transitionWorkOrder({ ...input, transition, nextStatus: input.nextStatus });
  }

  async submitChecklist(input: { projectId: string; executionId: string; assetId?: string; templateId: string; actorId: string; results: ChecklistSubmissionItem[]; buildingId: string; correlationId: string }): Promise<unknown> {
    const definitions = await this.repository.getChecklistDefinitions(input.templateId);
    validateChecklistSubmission(definitions, input.results);
    const highPriority = hasHighPriorityIncident(input.results);
    const result = await this.repository.submitChecklist({ ...input, buildingId: input.buildingId, highPriority });
    if (highPriority) {
      await this.incidents.publishHighPriorityIncident({
        eventId: randomUUID(),
        projectId: input.projectId,
        buildingId: input.buildingId,
        assetId: input.assetId,
        incidentType: 'PCCC_CHECKLIST_CRITICAL_FAILURE',
        sourceId: input.executionId,
        title: 'Critical PCCC checklist failure',
        description: 'A required PCCC checklist item was marked critical failure',
        actorId: input.actorId,
        correlationId: input.correlationId,
      });
    }
    return result;
  }
}
