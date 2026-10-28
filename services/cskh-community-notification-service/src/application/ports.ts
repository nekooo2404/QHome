import { NotificationChannel, NotificationPriority, TicketStatus } from '@prisma/client';

export interface SupportContext { projectId: string; actorId: string; correlationId: string; buildingId?: string; apartmentId?: string; }
export interface TicketSnapshot { id: string; projectId: string; residentId: string; assignedTo?: string; assignedDepartmentId?: string; status: TicketStatus; subject: string; priority: string; firstResponseDueAt: Date; resolutionDueAt: Date; version: number; }

export interface CskhRepository {
  createNews(input: { projectId: string; buildingId?: string; type: string; title: string; body: string; publishedAt?: Date; expiresAt?: Date; actorId: string; correlationId: string }): Promise<Record<string, unknown>>;
  listNews(input: { projectId: string; buildingId?: string; cursor?: string; take: number }): Promise<{ items: Array<Record<string, unknown>>; nextCursor?: string }>;
  createTicket(input: { projectId: string; buildingId?: string; apartmentId?: string; residentId: string; type: string; priority: string; subject: string; description: string; firstResponseDueAt: Date; resolutionDueAt: Date; sourceEventId?: string; actorId: string; correlationId: string }): Promise<TicketSnapshot>;
  getTicket(projectId: string, ticketId: string): Promise<TicketSnapshot | null>;
  listTickets(input: { projectId: string; residentId?: string; assignedTo?: string; status?: TicketStatus; cursor?: string; take: number }): Promise<{ items: TicketSnapshot[]; nextCursor?: string }>;
  transitionTicket(input: { projectId: string; ticketId: string; expectedVersion: number; nextStatus: TicketStatus; actorId: string; comment?: string; correlationId: string }): Promise<TicketSnapshot>;
  assignTicket(input: { projectId: string; ticketId: string; expectedVersion: number; assignedTo?: string; departmentId?: string; actorId: string; correlationId: string }): Promise<TicketSnapshot>;
  rateTicket(input: { projectId: string; ticketId: string; residentId: string; score: number; comment?: string; correlationId: string }): Promise<TicketSnapshot>;
  listEndpoints(projectId: string, targetFilter: Record<string, unknown>, channels: NotificationChannel[], limit: number, cursor?: string): Promise<{ items: Array<{ id: string; userId: string; apartmentId?: string; channel: NotificationChannel; address: string }>; nextCursor?: string }>;
  createCampaign(input: { projectId: string; title: string; priority: NotificationPriority; payload: Record<string, unknown>; targetFilter: Record<string, unknown>; channels: NotificationChannel[]; createdBy: string }): Promise<{ id: string; projectId: string; priority: NotificationPriority }>;
  getCampaign(id: string): Promise<{ id: string; projectId: string; title: string; payload: Record<string, unknown>; targetFilter: Record<string, unknown>; channels: NotificationChannel[] } | null>;
  createDeliveryLogs(input: { campaignId: string; projectId: string; endpoints: Array<{ id: string; channel: NotificationChannel }>; providerByChannel: Record<string, string> }): Promise<string[]>;
  getDeliveryBatch(ids: string[]): Promise<Array<{ id: string; channel: NotificationChannel; address: string; title: string; body: string; payload: Record<string, unknown> }>>;
  claimDelivery(id: string): Promise<{ id: string; campaignId: string; endpointId: string; channel: NotificationChannel; attempt: number } | null>;
  completeDelivery(id: string, providerRef?: string): Promise<void>;
  failDelivery(id: string, errorCode: string, errorMessage: string, retryAt?: Date): Promise<void>;
  beginInbox(eventId: string, eventType: string): Promise<boolean>;
  completeInbox(eventId: string): Promise<void>;
  failInbox(eventId: string, error: string): Promise<void>;
}

export interface ChannelProvider { send(input: { channel: NotificationChannel; address: string; title: string; body: string; payload: Record<string, unknown> }): Promise<{ providerRef?: string }>; }
export interface QueueAdapter { add(name: string, data: Record<string, unknown>, options?: Record<string, unknown>): Promise<void>; }
