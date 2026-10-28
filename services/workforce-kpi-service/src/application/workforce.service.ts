import { TaskSource, TaskStatus } from '@prisma/client';
import { transitionTask } from '../domain/task.state-machine';
import { TaskRepository, WorkforceContext } from './ports';

export class WorkforceService {
  constructor(private readonly repository: TaskRepository) {}

  createTask(context: WorkforceContext, input: { title: string; description?: string; buildingId?: string; departmentId?: string; assigneeId?: string; source?: TaskSource; sourceEntityId?: string; deduplicationKey?: string; difficultyWeight?: number; deadlineAt: string }) {
    const deadlineAt = new Date(input.deadlineAt);
    if (!Number.isFinite(deadlineAt.getTime()) || deadlineAt.getTime() <= Date.now()) throw new Error('deadlineAt must be a future timestamp');
    if (!input.title?.trim() || input.title.length > 300) throw new Error('title is invalid');
    const weight = Number(input.difficultyWeight ?? 1);
    if (!Number.isFinite(weight) || weight <= 0 || weight > 10) throw new Error('difficultyWeight must be between 0 and 10');
    return this.repository.createTask({ projectId: context.projectId, ...input, source: input.source ?? 'MANUAL', deduplicationKey: input.deduplicationKey ?? `manual:${context.actorId}:${Date.now()}`, difficultyWeight: weight.toFixed(4), deadlineAt, actorId: context.actorId, correlationId: context.correlationId });
  }

  async transition(context: WorkforceContext, taskId: string, input: { expectedVersion: number; nextStatus: TaskStatus; reason?: string }) {
    const current = await this.requiredTask(context.projectId, taskId);
    transitionTask({ from: current.status, to: input.nextStatus, actorId: context.actorId, reason: input.reason });
    return this.repository.transitionTask({ projectId: context.projectId, taskId, expectedVersion: input.expectedVersion, nextStatus: input.nextStatus, actorId: context.actorId, actorType: 'EMPLOYEE', reason: input.reason, correlationId: context.correlationId });
  }

  async rate(context: WorkforceContext, taskId: string, input: { score: number; comment?: string }) {
    if (!Number.isFinite(input.score) || input.score < 0 || input.score > 5) throw new Error('score must be between 0 and 5');
    return this.repository.rateTask({ projectId: context.projectId, taskId, ratedBy: context.actorId, score: input.score, comment: input.comment, correlationId: context.correlationId });
  }

  listTasks(context: WorkforceContext, query: { assigneeId?: string; departmentId?: string; status?: TaskStatus; cursor?: string; take?: number }) {
    return this.repository.listTasks({ projectId: context.projectId, ...query, take: Math.min(Math.max(query.take ?? 20, 1), 100) });
  }

  getTask(context: WorkforceContext, taskId: string) { return this.requiredTask(context.projectId, taskId); }

  getKpi(context: WorkforceContext, query: { scopeType: 'EMPLOYEE' | 'DEPARTMENT'; scopeId: string; periodStart: string; periodEnd: string }) {
    const start = new Date(query.periodStart); const end = new Date(query.periodEnd);
    if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end <= start) throw new Error('invalid KPI period');
    return this.repository.getKpiMetrics({ projectId: context.projectId, scopeType: query.scopeType, scopeId: query.scopeId, periodStart: start, periodEnd: end });
  }

  leaderboard(context: WorkforceContext, query: { periodStart: string; periodEnd: string; departmentId?: string; take?: number }) {
    const start = new Date(query.periodStart); const end = new Date(query.periodEnd);
    if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end <= start) throw new Error('invalid KPI period');
    return this.repository.getKpiLeaderboard({ projectId: context.projectId, periodStart: start, periodEnd: end, departmentId: query.departmentId, take: Math.min(Math.max(query.take ?? 50, 1), 200) });
  }

  async handleEvent(event: { eventId: string; eventType: string; projectId: string; payload: Record<string, unknown> }) {
    if (event.eventType === 'maintenance.work_order.state_changed.v1' || event.eventType === 'HIGH_PRIORITY_INCIDENT' || event.eventType === 'resident.ticket.created.v1') {
      const payload = event.payload;
      const source = event.eventType === 'resident.ticket.created.v1' ? 'RESIDENT_TICKET' : event.eventType === 'HIGH_PRIORITY_INCIDENT' ? 'MAINTENANCE_CHECKLIST' : 'MAINTENANCE_WORK_ORDER';
      return this.repository.createTask({ projectId: event.projectId, buildingId: typeof payload.buildingId === 'string' ? payload.buildingId : undefined, departmentId: typeof payload.departmentId === 'string' ? payload.departmentId : undefined, assigneeId: typeof payload.assigneeId === 'string' ? payload.assigneeId : undefined, title: String(payload.title ?? payload.incidentType ?? 'Operational work item'), description: typeof payload.description === 'string' ? payload.description : undefined, source, sourceEventId: event.eventId, sourceEntityId: typeof payload.workOrderId === 'string' ? payload.workOrderId : typeof payload.ticketId === 'string' ? payload.ticketId : undefined, deduplicationKey: `event:${event.eventId}`, difficultyWeight: String(payload.difficultyWeight ?? '1'), deadlineAt: new Date(typeof payload.deadlineAt === 'string' ? payload.deadlineAt : Date.now() + 24 * 60 * 60 * 1000), actorId: 'workforce-kpi-service', correlationId: event.eventId });
    }
    return undefined;
  }

  private async requiredTask(projectId: string, taskId: string) { const task = await this.repository.getTask(projectId, taskId); if (!task) throw new Error('Task not found'); return task; }
}
