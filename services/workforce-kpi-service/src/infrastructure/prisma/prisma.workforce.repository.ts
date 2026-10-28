import { randomUUID } from 'node:crypto';
import { Prisma, PrismaClient, TaskStatus } from '@prisma/client';
import Decimal from 'decimal.js';
import { assertTaskTransition, transitionTask } from '../../domain/task.state-machine';
import { TaskRepository, TaskSnapshot } from '../../application/ports';

type Tx = Prisma.TransactionClient;

function mapTask(row: any): TaskSnapshot {
  return { id: row.id, projectId: row.projectId, buildingId: row.buildingId ?? undefined, departmentId: row.departmentId ?? undefined, assigneeId: row.assigneeId ?? undefined, title: row.title, description: row.description ?? undefined, source: row.source, sourceEntityId: row.sourceEntityId ?? undefined, difficultyWeight: String(row.difficultyWeight), deadlineAt: row.deadlineAt, status: row.status, version: row.version, startedAt: row.startedAt ?? undefined, completedAt: row.completedAt ?? undefined, rating: row.rating ? String(row.rating) : undefined };
}

function outbox(projectId: string, eventType: string, aggregateType: string, aggregateId: string, payload: Record<string, unknown>) {
  return { eventId: randomUUID(), projectId, topic: 'qhome.workforce.events.v1', eventType, aggregateType, aggregateId, payload: payload as Prisma.InputJsonValue, headers: {} };
}

function isSerializationConflict(error: unknown): boolean {
  const value = error as { code?: string; meta?: { code?: string }; message?: string };
  return value.code === 'P2034' || value.code === '40001' || value.code === '40P01' || value.meta?.code === '40001' || value.meta?.code === '40P01' || /serialization|deadlock detected|could not serialize/iu.test(value.message ?? '');
}

async function retryBackoff(attempt: number): Promise<void> { await new Promise((resolve) => setTimeout(resolve, Math.min(1000, 25 * (2 ** attempt)) + Math.floor(Math.random() * 25))); }

function periodStart(date: Date): Date { return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1)); }
function periodEnd(start: Date): Date { return new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1)); }

export class WorkforcePrismaClient extends PrismaClient { async onModuleDestroy(): Promise<void> { await this.$disconnect(); } }

export class PrismaWorkforceRepository implements TaskRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async createTask(input: { projectId: string; buildingId?: string; departmentId?: string; assigneeId?: string; title: string; description?: string; source: any; sourceEventId?: string; sourceEntityId?: string; deduplicationKey: string; difficultyWeight: string; deadlineAt: Date; actorId: string; correlationId: string }): Promise<TaskSnapshot> {
    return this.withSerializableRetry(async (tx) => {
      const existing = await tx.task.findUnique({ where: { projectId_deduplicationKey: { projectId: input.projectId, deduplicationKey: input.deduplicationKey } } });
      if (existing) return mapTask(existing);
      const task = await tx.task.create({ data: { projectId: input.projectId, buildingId: input.buildingId, departmentId: input.departmentId, assigneeId: input.assigneeId, title: input.title, description: input.description, source: input.source, sourceEventId: input.sourceEventId, sourceEntityId: input.sourceEntityId, deduplicationKey: input.deduplicationKey, difficultyWeight: input.difficultyWeight, deadlineAt: input.deadlineAt, status: input.assigneeId ? 'ASSIGNED' : 'CREATED', assignedAt: input.assigneeId ? new Date() : undefined, createdBy: input.actorId } });
      await tx.taskWorkflowLog.create({ data: { taskId: task.id, projectId: input.projectId, fromStatus: null, toStatus: task.status, actorId: input.actorId, actorType: input.actorId === 'workforce-kpi-service' ? 'SYSTEM' : 'MANAGER', correlationId: input.correlationId } });
      await tx.outboxEvent.create({ data: outbox(input.projectId, 'workforce.task.created.v1', 'task', task.id, { taskId: task.id, source: input.source, assigneeId: input.assigneeId, deadlineAt: input.deadlineAt.toISOString() }) });
      return mapTask(task);
    });
  }

  async getTask(projectId: string, taskId: string): Promise<TaskSnapshot | null> { const row = await this.prisma.task.findFirst({ where: { id: taskId, projectId } }); return row ? mapTask(row) : null; }

  async listTasks(input: { projectId: string; assigneeId?: string; departmentId?: string; status?: TaskStatus; cursor?: string; take: number }) {
    const rows = await this.prisma.task.findMany({ where: { projectId: input.projectId, assigneeId: input.assigneeId, departmentId: input.departmentId, status: input.status }, orderBy: [{ deadlineAt: 'asc' }, { id: 'asc' }], take: input.take + 1, ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}) });
    const visible = rows.length > input.take ? rows.slice(0, input.take) : rows;
    return { items: visible.map(mapTask), nextCursor: rows.length > input.take ? visible.at(-1)?.id : undefined };
  }

  async transitionTask(input: { projectId: string; taskId: string; expectedVersion: number; nextStatus: TaskStatus; actorId: string; actorType: 'EMPLOYEE' | 'MANAGER' | 'SYSTEM' | 'RESIDENT'; reason?: string; correlationId: string }): Promise<TaskSnapshot> {
    return this.withSerializableRetry(async (tx) => {
      const row = (await tx.$queryRawUnsafe<Array<any>>('SELECT * FROM workforce_tasks WHERE id = $1::uuid AND project_id = $2::uuid FOR UPDATE', input.taskId, input.projectId))[0];
      if (!row || row.version !== input.expectedVersion) throw new Error('Task not found or version conflict');
      const transition = transitionTask({ from: row.status, to: input.nextStatus, actorId: input.actorId, reason: input.reason });
      const updated = await tx.task.update({ where: { id: input.taskId }, data: { status: input.nextStatus, version: { increment: 1 }, acceptedAt: input.nextStatus === 'ACCEPTED' ? new Date() : undefined, startedAt: ['IN_PROGRESS', 'REJECTED'].includes(input.nextStatus) && !row.started_at ? new Date() : undefined, submittedAt: input.nextStatus === 'SUBMITTED' ? new Date() : undefined, completedAt: input.nextStatus === 'COMPLETED' ? new Date() : undefined, cancelledAt: input.nextStatus === 'CANCELLED' ? new Date() : undefined } });
      await tx.taskWorkflowLog.create({ data: { taskId: input.taskId, projectId: input.projectId, fromStatus: transition.from, toStatus: transition.to, actorId: input.actorId, actorType: input.actorType, reason: input.reason, correlationId: input.correlationId, occurredAt: transition.occurredAt } });
      if (input.nextStatus === 'COMPLETED') await this.refreshMetrics(tx, updated.id, updated.projectId, updated.assigneeId, updated.departmentId);
      await tx.outboxEvent.create({ data: outbox(input.projectId, 'workforce.task.status_changed.v1', 'task', input.taskId, { taskId: input.taskId, fromStatus: transition.from, toStatus: transition.to, assigneeId: updated.assigneeId, departmentId: updated.departmentId }) });
      return mapTask(updated);
    });
  }

  async rateTask(input: { projectId: string; taskId: string; ratedBy: string; score: number; comment?: string; correlationId: string }): Promise<TaskSnapshot> {
    return this.withSerializableRetry(async (tx) => {
      const task = await tx.task.findFirst({ where: { id: input.taskId, projectId: input.projectId, status: 'COMPLETED' } });
      if (!task) throw new Error('Only completed tasks can be rated');
      await tx.taskRating.upsert({ where: { taskId_ratedBy: { taskId: input.taskId, ratedBy: input.ratedBy } }, create: { taskId: input.taskId, projectId: input.projectId, ratedBy: input.ratedBy, score: input.score, comment: input.comment }, update: { score: input.score, comment: input.comment } });
      const aggregate = await tx.taskRating.aggregate({ where: { taskId: input.taskId }, _avg: { score: true } });
      const updated = await tx.task.update({ where: { id: input.taskId }, data: { rating: aggregate._avg.score ?? input.score } });
      await this.refreshMetrics(tx, updated.id, updated.projectId, updated.assigneeId, updated.departmentId);
      return mapTask(updated);
    });
  }

  private async refreshMetrics(tx: Tx, taskId: string, projectId: string, assigneeId: string | null, departmentId: string | null): Promise<void> {
    const task = await tx.task.findUnique({ where: { id: taskId } });
    if (!task || !task.completedAt) return;
    const start = periodStart(task.completedAt); const end = periodEnd(start);
    const targets = [{ scopeType: 'EMPLOYEE' as const, scopeId: assigneeId, departmentId }, { scopeType: 'DEPARTMENT' as const, scopeId: departmentId, departmentId }].filter((target) => target.scopeId);
    for (const target of targets) {
      const scopeColumn = target.scopeType === 'EMPLOYEE' ? 'assignee_id' : 'department_id';
      const aggregate = (await tx.$queryRawUnsafe<Array<{ assigned_count: bigint; completed_count: bigint; on_time_count: bigint; overdue_count: bigint; total_minutes: Prisma.Decimal; total_rating: Prisma.Decimal; weighted_score: Prisma.Decimal }>>(`SELECT COUNT(*) FILTER (WHERE created_at >= $2 AND created_at < $3) AS assigned_count, COUNT(*) FILTER (WHERE status = 'COMPLETED' AND completed_at >= $2 AND completed_at < $3) AS completed_count, COUNT(*) FILTER (WHERE status = 'COMPLETED' AND completed_at >= $2 AND completed_at < $3 AND completed_at <= deadline_at) AS on_time_count, COUNT(*) FILTER (WHERE (status = 'OVERDUE' OR (status = 'COMPLETED' AND completed_at > deadline_at)) AND created_at >= $2 AND created_at < $3) AS overdue_count, COALESCE(SUM(EXTRACT(EPOCH FROM (completed_at - COALESCE(started_at, completed_at))) / 60) FILTER (WHERE status = 'COMPLETED' AND completed_at >= $2 AND completed_at < $3), 0) AS total_minutes, COALESCE(SUM(COALESCE(rating, 5)) FILTER (WHERE status = 'COMPLETED' AND completed_at >= $2 AND completed_at < $3), 0) AS total_rating, COALESCE(SUM(difficulty_weight * (CASE WHEN completed_at <= deadline_at THEN 0.6 ELSE GREATEST(0, 0.6 * (1 - LEAST(1, EXTRACT(EPOCH FROM (completed_at - deadline_at)) / 86400))) END + (COALESCE(rating, 5) / 5.0) * 0.4) * 100) FILTER (WHERE status = 'COMPLETED' AND completed_at >= $2 AND completed_at < $3), 0) AS weighted_score FROM workforce_tasks WHERE project_id = $1::uuid AND ${scopeColumn} = $4::uuid`, projectId, start, end, target.scopeId!))[0];
      const assignedCount = Number(aggregate?.assigned_count ?? 0n); const completedCount = Number(aggregate?.completed_count ?? 0n); const onTimeCount = Number(aggregate?.on_time_count ?? 0n); const overdueCount = Number(aggregate?.overdue_count ?? 0n); const totalMinutes = Number(aggregate?.total_minutes ?? 0); const totalRating = new Decimal(String(aggregate?.total_rating ?? 0)); const weightedScore = new Decimal(String(aggregate?.weighted_score ?? 0));
      await tx.employeeKpiMetrics.upsert({ where: { projectId_scopeType_scopeId_periodStart: { projectId, scopeType: target.scopeType, scopeId: target.scopeId!, periodStart: start } }, create: { projectId, departmentId: target.departmentId, scopeType: target.scopeType, scopeId: target.scopeId!, periodStart: start, periodEnd: end, assignedCount, completedCount, onTimeCount, overdueCount, totalCompletionMinutes: BigInt(totalMinutes), totalRating: totalRating.toFixed(6), weightedScore: weightedScore.toFixed(6), completionRate: assignedCount ? new Decimal(completedCount).div(assignedCount).toFixed(6) : '0', onTimeRate: completedCount ? new Decimal(onTimeCount).div(completedCount).toFixed(6) : '0', averageCompletionMinutes: completedCount ? new Decimal(totalMinutes).div(completedCount).toFixed(6) : '0', averageRating: completedCount ? totalRating.div(completedCount).toFixed(6) : '0' }, update: { departmentId: target.departmentId, assignedCount, completedCount, onTimeCount, overdueCount, totalCompletionMinutes: BigInt(totalMinutes), totalRating: totalRating.toFixed(6), weightedScore: weightedScore.toFixed(6), completionRate: assignedCount ? new Decimal(completedCount).div(assignedCount).toFixed(6) : '0', onTimeRate: completedCount ? new Decimal(onTimeCount).div(completedCount).toFixed(6) : '0', averageCompletionMinutes: completedCount ? new Decimal(totalMinutes).div(completedCount).toFixed(6) : '0', averageRating: completedCount ? totalRating.div(completedCount).toFixed(6) : '0', version: { increment: 1 } } });
    }
  }

  async getKpiMetrics(input: { projectId: string; scopeType: 'EMPLOYEE' | 'DEPARTMENT'; scopeId: string; periodStart: Date; periodEnd: Date }) { const metric = await this.prisma.employeeKpiMetrics.findUnique({ where: { projectId_scopeType_scopeId_periodStart: { projectId: input.projectId, scopeType: input.scopeType, scopeId: input.scopeId, periodStart: input.periodStart } } }); return metric ? { ...metric, totalCompletionMinutes: String(metric.totalCompletionMinutes) } : null; }
  async getKpiLeaderboard(input: { projectId: string; periodStart: Date; periodEnd: Date; departmentId?: string; take: number }) { const rows = await this.prisma.employeeKpiMetrics.findMany({ where: { projectId: input.projectId, scopeType: 'EMPLOYEE', periodStart: input.periodStart, ...(input.departmentId ? { departmentId: input.departmentId } : {}) }, orderBy: [{ weightedScore: 'desc' }, { onTimeRate: 'desc' }], take: input.take }); return rows.map((row) => ({ ...row, totalCompletionMinutes: String(row.totalCompletionMinutes) })); }
  async markOverdue(now: Date, take: number): Promise<number> { const rows = await this.prisma.task.findMany({ where: { deadlineAt: { lt: now }, status: { in: ['ASSIGNED', 'ACCEPTED', 'IN_PROGRESS'] } }, select: { id: true, projectId: true, version: true, status: true, assigneeId: true, departmentId: true }, take }); let count = 0; for (const row of rows) { const changed = await this.prisma.$transaction(async (tx) => { const updated = await tx.task.updateMany({ where: { id: row.id, version: row.version, status: { in: ['ASSIGNED', 'ACCEPTED', 'IN_PROGRESS'] } }, data: { status: 'OVERDUE', version: { increment: 1 } } }); if (updated.count !== 1) return false; await tx.taskWorkflowLog.create({ data: { taskId: row.id, projectId: row.projectId, fromStatus: row.status, toStatus: 'OVERDUE', actorId: '00000000-0000-0000-0000-000000000000', actorType: 'SYSTEM', reason: 'Deadline exceeded', correlationId: `overdue:${row.id}` } }); await tx.outboxEvent.create({ data: outbox(row.projectId, 'workforce.task.overdue.v1', 'task', row.id, { taskId: row.id, assigneeId: row.assigneeId, departmentId: row.departmentId }) }); return true; }); count += changed ? 1 : 0; } return count; }

  private async withSerializableRetry<T>(operation: (tx: Tx) => Promise<T>): Promise<T> {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try { return await this.prisma.$transaction(operation, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, maxWait: 5000, timeout: 15000 }); }
      catch (error: unknown) { if (!isSerializationConflict(error) || attempt === 3) throw error; await retryBackoff(attempt); }
    }
    throw new Error('Serializable transaction retry budget exhausted');
  }
  async beginInbox(eventId: string, eventType: string) { return this.prisma.$transaction(async (tx) => { const current = await tx.inboxEvent.findUnique({ where: { eventId } }); if (current?.status === 'PROCESSED') return false; if (current) await tx.inboxEvent.update({ where: { eventId }, data: { status: 'PROCESSING', attempts: { increment: 1 } } }); else await tx.inboxEvent.create({ data: { eventId, eventType, status: 'PROCESSING', attempts: 1 } }); return true; }); }
  completeInbox(eventId: string) { return this.prisma.inboxEvent.update({ where: { eventId }, data: { status: 'PROCESSED', processedAt: new Date(), lastError: null } }).then(() => undefined); }
  failInbox(eventId: string, error: string) { return this.prisma.inboxEvent.update({ where: { eventId }, data: { status: 'FAILED', lastError: error.slice(0, 2000) } }).then(() => undefined); }
}
