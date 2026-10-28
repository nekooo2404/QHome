import { randomUUID } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { AssetRepository } from '../../application/ports';
import { ChecklistItemDefinition, ChecklistSubmissionItem } from '../../domain/checklist';
import { MaintenanceTransition } from '../../domain/maintenance.state-machine';

type Tx = Prisma.TransactionClient;

function eventData(input: { projectId?: string; eventType: string; aggregateType: string; aggregateId: string; payload: Record<string, unknown>; correlationId?: string }) {
  return { eventId: randomUUID(), projectId: input.projectId, topic: 'qhome.asset-maintenance.events.v1', eventType: input.eventType, aggregateType: input.aggregateType, aggregateId: input.aggregateId, payload: input.payload as Prisma.InputJsonValue, headers: input.correlationId ? { correlationId: input.correlationId } : {} };
}

export class PrismaAssetRepository implements AssetRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async createAsset(input: Record<string, unknown>, actorId: string, correlationId: string) {
    return this.prisma.$transaction(async (tx) => {
      const asset = await tx.asset.create({ data: input as Prisma.AssetCreateInput });
      await tx.auditLog.create({ data: { projectId: asset.projectId, actorId, action: 'ASSET_CREATED', entityType: 'asset', entityId: asset.id, afterState: asset as unknown as Prisma.InputJsonValue, correlationId } });
      await tx.outboxEvent.create({ data: eventData({ projectId: asset.projectId, eventType: 'asset.created.v1', aggregateType: 'asset', aggregateId: asset.id, payload: { assetId: asset.id }, correlationId }) });
      return asset;
    });
  }

  getAsset(projectId: string, assetId: string) {
    return this.prisma.asset.findFirst({ where: { id: assetId, projectId } });
  }

  async updateAsset(input: { projectId: string; assetId: string; expectedVersion: number; patch: Record<string, unknown>; actorId: string; correlationId: string }) {
    return this.prisma.$transaction(async (tx) => {
      const current = await tx.asset.findFirst({ where: { id: input.assetId, projectId: input.projectId, version: input.expectedVersion } });
      if (!current) throw new Error('Asset not found or optimistic version conflict');
      const updated = await tx.asset.update({ where: { id: current.id }, data: { ...(input.patch as Prisma.AssetUpdateInput), version: { increment: 1 } } });
      await tx.auditLog.create({ data: { projectId: input.projectId, actorId: input.actorId, action: 'ASSET_UPDATED', entityType: 'asset', entityId: updated.id, beforeState: current as unknown as Prisma.InputJsonValue, afterState: updated as unknown as Prisma.InputJsonValue, correlationId: input.correlationId } });
      await tx.outboxEvent.create({ data: eventData({ projectId: input.projectId, eventType: 'asset.updated.v1', aggregateType: 'asset', aggregateId: updated.id, payload: { assetId: updated.id, version: updated.version }, correlationId: input.correlationId }) });
      return updated;
    });
  }

  async transitionWorkOrder(input: { projectId: string; workOrderId: string; expectedVersion: number; transition: MaintenanceTransition; nextStatus: string }) {
    return this.prisma.$transaction(async (tx) => {
      const current = await tx.maintenanceWorkOrder.findFirst({ where: { id: input.workOrderId, projectId: input.projectId, version: input.expectedVersion } });
      if (!current) throw new Error('Work order not found or optimistic version conflict');
      const updated = await tx.maintenanceWorkOrder.update({ where: { id: current.id }, data: { status: input.nextStatus as 'OPEN' | 'ASSIGNED' | 'IN_PROGRESS' | 'BLOCKED' | 'COMPLETED' | 'CANCELLED', version: { increment: 1 }, startedAt: input.nextStatus === 'IN_PROGRESS' && !current.startedAt ? new Date() : undefined, completedAt: input.nextStatus === 'COMPLETED' ? new Date() : undefined } });
      await tx.auditLog.create({ data: { projectId: input.projectId, actorId: input.transition.actorId, action: 'WORK_ORDER_STATE_CHANGED', entityType: 'maintenance_work_order', entityId: updated.id, beforeState: current as unknown as Prisma.InputJsonValue, afterState: updated as unknown as Prisma.InputJsonValue, correlationId: 'state-transition' } });
      await tx.outboxEvent.create({ data: eventData({ projectId: input.projectId, eventType: 'maintenance.work_order.state_changed.v1', aggregateType: 'maintenance_work_order', aggregateId: updated.id, payload: { from: input.transition.from, to: input.transition.to, reason: input.transition.reason } }) });
      return updated;
    });
  }

  async getChecklistDefinitions(templateId: string): Promise<ChecklistItemDefinition[]> {
    const items = await this.prisma.checklistTemplateItem.findMany({ where: { templateId }, select: { id: true, isRequired: true, isPccc: true } });
    return items;
  }

  async submitChecklist(input: { projectId: string; buildingId: string; executionId: string; assetId?: string; templateId: string; actorId: string; results: ChecklistSubmissionItem[]; highPriority: boolean; correlationId: string }) {
    return this.prisma.$transaction(async (tx) => {
      const execution = await tx.checklistExecution.findFirst({ where: { id: input.executionId, projectId: input.projectId, templateId: input.templateId, status: 'IN_PROGRESS' } });
      if (!execution) throw new Error('Checklist execution not found or already submitted');
      await tx.checklistResult.createMany({ data: input.results.map((result) => ({ executionId: execution.id, itemId: result.itemId, status: result.status, severity: result.severity ?? 'NORMAL', notes: result.notes, evidenceRef: result.evidenceRef })) });
      await tx.checklistExecution.update({ where: { id: execution.id }, data: { status: 'SUBMITTED', submittedAt: new Date(), version: { increment: 1 } } });
      let workOrderId: string | undefined;
      if (input.highPriority) {
        const incident = await tx.pcccIncident.create({ data: { projectId: input.projectId, buildingId: input.buildingId, assetId: input.assetId, checklistId: execution.id, title: 'Critical checklist failure', description: 'Critical technical/PCCC checklist item failed', reportedBy: input.actorId } });
        const order = await tx.maintenanceWorkOrder.create({ data: { projectId: input.projectId, assetId: input.assetId, source: 'CHECKLIST', priority: 'CRITICAL', status: 'OPEN', deduplicationKey: 'checklist-critical:' + execution.id, title: 'Urgent checklist failure remediation', description: incident.description } });
        workOrderId = order.id;
        await tx.outboxEvent.create({ data: eventData({ projectId: input.projectId, eventType: 'HIGH_PRIORITY_INCIDENT', aggregateType: 'pccc_incident', aggregateId: incident.id, payload: { incidentId: incident.id, workOrderId: order.id, executionId: execution.id }, correlationId: input.correlationId }) });
      }
      await tx.auditLog.create({ data: { projectId: input.projectId, actorId: input.actorId, action: 'CHECKLIST_SUBMITTED', entityType: 'checklist_execution', entityId: execution.id, afterState: { highPriority: input.highPriority } as Prisma.InputJsonValue, correlationId: input.correlationId } });
      return { executionId: execution.id, workOrderId };
    });
  }

  async findDueMaintenancePlans(now: Date, limit: number, cursor?: string) {
    const rows = await this.prisma.maintenancePlan.findMany({ where: { status: 'ACTIVE', nextDueAt: { lte: now }, ...(cursor ? { id: { gt: cursor } } : {}) }, take: limit + 1, orderBy: { id: 'asc' }, select: { id: true, projectId: true, assetId: true, partnerId: true, nextDueAt: true, intervalDays: true } });
    const visible = rows.length > limit ? rows.slice(0, limit) : rows;
    return { items: visible, nextCursor: rows.length > limit ? visible.at(-1)?.id : undefined };
  }

  async findDuePcccDevices(now: Date, limit: number, cursor?: string) {
    const rows = await this.prisma.pcccDevice.findMany({ where: { nextInspectionAt: { lte: now }, status: { in: ['OPERATIONAL', 'DEGRADED'] }, ...(cursor ? { id: { gt: cursor } } : {}) }, take: limit + 1, orderBy: { id: 'asc' }, select: { id: true, projectId: true, buildingId: true, assetId: true, nextInspectionAt: true, inspectionIntervalDays: true } });
    const visible = rows.length > limit ? rows.slice(0, limit) : rows;
    return { items: visible.map((row) => ({ deviceId: row.id, projectId: row.projectId, buildingId: row.buildingId, assetId: row.assetId, nextInspectionAt: row.nextInspectionAt, intervalDays: row.inspectionIntervalDays })), nextCursor: rows.length > limit ? visible.at(-1)?.id : undefined };
  }

  async createScheduledWorkOrder(input: { projectId: string; assetId: string; maintenancePlanId?: string; source: string; priority: string; dueAt: Date; deduplicationKey: string; title: string; description?: string }) {
    try {
      const order = await this.prisma.maintenanceWorkOrder.create({ data: { ...input, source: input.source as 'SCHEDULED' | 'INCIDENT' | 'CHECKLIST' | 'PCCC_EXPIRY' | 'MANUAL', priority: input.priority as 'LOW' | 'NORMAL' | 'HIGH' | 'CRITICAL', status: 'OPEN' } });
      return { created: true, workOrderId: order.id };
    } catch (error) {
      if ((error as { code?: string }).code === 'P2002') {
        const existing = await this.prisma.maintenanceWorkOrder.findUniqueOrThrow({ where: { deduplicationKey: input.deduplicationKey } });
        return { created: false, workOrderId: existing.id };
      }
      throw error;
    }
  }

  createPcccExpiryWorkOrder(input: { projectId: string; buildingId: string; assetId: string; deviceId: string; dueAt: Date; deduplicationKey: string }) {
    return this.createScheduledWorkOrder({ ...input, source: 'PCCC_EXPIRY', priority: 'HIGH', title: 'PCCC inspection expiry', description: 'PCCC device inspection is due or expired' });
  }
}
