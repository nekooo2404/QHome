import { TaskStatus, TaskSource } from '@prisma/client';

export interface WorkforceContext { projectId: string; actorId: string; correlationId: string; buildingId?: string; }

export interface TaskSnapshot {
  id: string; projectId: string; buildingId?: string; departmentId?: string; assigneeId?: string; title: string; description?: string; source: TaskSource; sourceEntityId?: string; difficultyWeight: string; deadlineAt: Date; status: TaskStatus; version: number; startedAt?: Date; completedAt?: Date; rating?: string;
}

export interface TaskRepository {
  createTask(input: { projectId: string; buildingId?: string; departmentId?: string; assigneeId?: string; title: string; description?: string; source: TaskSource; sourceEventId?: string; sourceEntityId?: string; deduplicationKey: string; difficultyWeight: string; deadlineAt: Date; actorId: string; correlationId: string }): Promise<TaskSnapshot>;
  getTask(projectId: string, taskId: string): Promise<TaskSnapshot | null>;
  listTasks(input: { projectId: string; assigneeId?: string; departmentId?: string; status?: TaskStatus; cursor?: string; take: number }): Promise<{ items: TaskSnapshot[]; nextCursor?: string }>;
  transitionTask(input: { projectId: string; taskId: string; expectedVersion: number; nextStatus: TaskStatus; actorId: string; actorType: 'EMPLOYEE' | 'MANAGER' | 'SYSTEM' | 'RESIDENT'; reason?: string; correlationId: string }): Promise<TaskSnapshot>;
  rateTask(input: { projectId: string; taskId: string; ratedBy: string; score: number; comment?: string; correlationId: string }): Promise<TaskSnapshot>;
  markOverdue(now: Date, take: number): Promise<number>;
  getKpiMetrics(input: { projectId: string; scopeType: 'EMPLOYEE' | 'DEPARTMENT'; scopeId: string; periodStart: Date; periodEnd: Date }): Promise<Record<string, unknown> | null>;
  getKpiLeaderboard(input: { projectId: string; periodStart: Date; periodEnd: Date; departmentId?: string; take: number }): Promise<Array<Record<string, unknown>>>;
  beginInbox(eventId: string, eventType: string): Promise<boolean>;
  completeInbox(eventId: string): Promise<void>;
  failInbox(eventId: string, error: string): Promise<void>;
}

export interface WorkforceRedis {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ...args: Array<string | number>): Promise<unknown>;
}

export interface WorkforceKafkaProducer { send(input: { topic: string; key: string; value: Record<string, unknown> }): Promise<void>; }
