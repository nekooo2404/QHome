import { randomUUID } from 'node:crypto';
import { Prisma, PrismaClient, TicketStatus } from '@prisma/client';
import { CskhRepository, TicketSnapshot } from '../../application/ports';
import { assertTicketTransition, transitionTicket } from '../../domain/ticket.state-machine';

type Tx = Prisma.TransactionClient;
const mapTicket = (row: any): TicketSnapshot => ({ id: row.id, projectId: row.projectId, residentId: row.residentId, assignedTo: row.assignedTo ?? undefined, assignedDepartmentId: row.assignedDepartmentId ?? undefined, status: row.status, subject: row.subject, priority: row.priority, firstResponseDueAt: row.firstResponseDueAt, resolutionDueAt: row.resolutionDueAt, version: row.version });
const event = (projectId: string, eventType: string, aggregateType: string, aggregateId: string, payload: Record<string, unknown>) => ({ eventId: randomUUID(), projectId, topic: 'qhome.cskh.events.v1', eventType, aggregateType, aggregateId, payload: payload as Prisma.InputJsonValue, headers: {} });

export class CskhPrismaClient extends PrismaClient { async onModuleDestroy(): Promise<void> { await this.$disconnect(); } }

export class PrismaCskhRepository implements CskhRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async createNews(input: { projectId: string; buildingId?: string; type: string; title: string; body: string; publishedAt?: Date; expiresAt?: Date; actorId: string; correlationId: string }) {
    const news = await this.prisma.newsFeed.create({ data: { projectId: input.projectId, buildingId: input.buildingId, type: input.type as any, status: input.publishedAt ? 'PUBLISHED' : 'DRAFT', title: input.title, body: input.body, publishedAt: input.publishedAt, expiresAt: input.expiresAt, createdBy: input.actorId } });
    await this.prisma.outboxEvent.create({ data: event(input.projectId, 'cskh.news.published.v1', 'news_feed', news.id, { newsId: news.id, buildingId: news.buildingId, type: news.type }) });
    return news;
  }

  async listNews(input: { projectId: string; buildingId?: string; cursor?: string; take: number }) {
    const rows = await this.prisma.newsFeed.findMany({ where: { projectId: input.projectId, status: 'PUBLISHED', ...(input.buildingId ? { OR: [{ buildingId: null }, { buildingId: input.buildingId }] } : {}), OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] }, orderBy: [{ publishedAt: 'desc' }, { id: 'desc' }], take: input.take + 1, ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}) });
    const items = rows.length > input.take ? rows.slice(0, input.take) : rows;
    return { items, nextCursor: rows.length > input.take ? items.at(-1)?.id : undefined };
  }

  async createTicket(input: { projectId: string; buildingId?: string; apartmentId?: string; residentId: string; type: string; priority: string; subject: string; description: string; firstResponseDueAt: Date; resolutionDueAt: Date; sourceEventId?: string; actorId: string; correlationId: string }) {
    return this.prisma.$transaction(async (tx) => {
      const ticket = await tx.ticket.create({ data: { projectId: input.projectId, buildingId: input.buildingId, apartmentId: input.apartmentId, residentId: input.residentId, type: input.type as any, priority: input.priority as any, subject: input.subject, description: input.description, firstResponseDueAt: input.firstResponseDueAt, resolutionDueAt: input.resolutionDueAt, sourceEventId: input.sourceEventId } });
      await tx.ticketHistory.create({ data: { ticketId: ticket.id, projectId: input.projectId, toStatus: 'OPEN', actorId: input.actorId, actorType: 'RESIDENT', correlationId: input.correlationId } });
      await tx.ticketSlaEvent.createMany({ data: [{ ticketId: ticket.id, projectId: input.projectId, type: 'RESPONSE_DUE', dueAt: input.firstResponseDueAt }, { ticketId: ticket.id, projectId: input.projectId, type: 'RESOLUTION_DUE', dueAt: input.resolutionDueAt }] });
      await tx.outboxEvent.create({ data: event(input.projectId, 'cskh.ticket.created.v1', 'ticket', ticket.id, { ticketId: ticket.id, residentId: input.residentId, buildingId: input.buildingId, priority: ticket.priority }) });
      return mapTicket(ticket);
    });
  }

  async getTicket(projectId: string, ticketId: string) { const ticket = await this.prisma.ticket.findFirst({ where: { id: ticketId, projectId } }); return ticket ? mapTicket(ticket) : null; }
  async listTickets(input: { projectId: string; residentId?: string; assignedTo?: string; status?: TicketStatus; cursor?: string; take: number }) { const rows = await this.prisma.ticket.findMany({ where: { projectId: input.projectId, residentId: input.residentId, assignedTo: input.assignedTo, status: input.status }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: input.take + 1, ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}) }); const items = rows.length > input.take ? rows.slice(0, input.take) : rows; return { items: items.map(mapTicket), nextCursor: rows.length > input.take ? items.at(-1)?.id : undefined }; }

  async transitionTicket(input: { projectId: string; ticketId: string; expectedVersion: number; nextStatus: TicketStatus; actorId: string; comment?: string; correlationId: string }): Promise<TicketSnapshot> {
    return this.prisma.$transaction(async (tx) => {
      const row = (await tx.$queryRawUnsafe<Array<any>>('SELECT * FROM support_tickets WHERE id = $1::uuid AND project_id = $2::uuid FOR UPDATE', input.ticketId, input.projectId))[0];
      if (!row || row.version !== input.expectedVersion) throw new Error('Ticket not found or version conflict');
      const transition = transitionTicket({ from: row.status, to: input.nextStatus, actorId: input.actorId });
      const updated = await tx.ticket.update({ where: { id: input.ticketId }, data: { status: input.nextStatus, version: { increment: 1 }, firstRespondedAt: ['ASSIGNED', 'IN_PROGRESS'].includes(input.nextStatus) && !row.first_responded_at ? new Date() : undefined, resolvedAt: input.nextStatus === 'RESOLVED' ? new Date() : undefined, closedAt: input.nextStatus === 'CLOSED' ? new Date() : undefined } });
      await tx.ticketHistory.create({ data: { ticketId: input.ticketId, projectId: input.projectId, fromStatus: transition.from, toStatus: transition.to, actorId: input.actorId, actorType: 'STAFF', comment: input.comment, correlationId: input.correlationId } });
      await tx.outboxEvent.create({ data: event(input.projectId, 'cskh.ticket.status_changed.v1', 'ticket', input.ticketId, { ticketId: input.ticketId, fromStatus: transition.from, toStatus: transition.to }) });
      return mapTicket(updated);
    });
  }

  async assignTicket(input: { projectId: string; ticketId: string; expectedVersion: number; assignedTo?: string; departmentId?: string; actorId: string; correlationId: string }): Promise<TicketSnapshot> {
    const updated = await this.prisma.ticket.updateMany({ where: { id: input.ticketId, projectId: input.projectId, version: input.expectedVersion, status: { in: ['OPEN', 'ASSIGNED'] } }, data: { assignedTo: input.assignedTo, assignedDepartmentId: input.departmentId, status: 'ASSIGNED', version: { increment: 1 } } });
    if (updated.count !== 1) throw new Error('Ticket not found or version conflict');
    const ticket = await this.prisma.ticket.findUniqueOrThrow({ where: { id: input.ticketId } });
    await this.prisma.ticketHistory.create({ data: { ticketId: ticket.id, projectId: input.projectId, fromStatus: 'OPEN', toStatus: 'ASSIGNED', actorId: input.actorId, actorType: 'STAFF', correlationId: input.correlationId } });
    return mapTicket(ticket);
  }

  async rateTicket(input: { projectId: string; ticketId: string; residentId: string; score: number; comment?: string; correlationId: string }): Promise<TicketSnapshot> {
    const updated = await this.prisma.ticket.updateMany({ where: { id: input.ticketId, projectId: input.projectId, residentId: input.residentId, status: { in: ['RESOLVED', 'CLOSED'] } }, data: { satisfactionScore: input.score, satisfactionComment: input.comment } });
    if (updated.count !== 1) throw new Error('Ticket is not rateable');
    return mapTicket(await this.prisma.ticket.findUniqueOrThrow({ where: { id: input.ticketId } }));
  }

  async listEndpoints(projectId: string, targetFilter: Record<string, unknown>, channels: any[], limit: number, cursor?: string) { const rows = await this.prisma.deviceEndpoint.findMany({ where: { projectId, isActive: true, channel: { in: channels }, ...(typeof targetFilter.userId === 'string' ? { userId: targetFilter.userId } : {}), ...(typeof targetFilter.apartmentId === 'string' ? { apartmentId: targetFilter.apartmentId } : {}) }, take: limit, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}), orderBy: { id: 'asc' } }); return { items: rows.map((row) => ({ id: row.id, userId: row.userId, apartmentId: row.apartmentId ?? undefined, channel: row.channel, address: row.address })), nextCursor: rows.length === limit ? rows.at(-1)?.id : undefined }; }
  async createCampaign(input: { projectId: string; title: string; priority: any; payload: Record<string, unknown>; targetFilter: Record<string, unknown>; channels: any[]; createdBy: string }) { const campaign = await this.prisma.notificationCampaign.create({ data: { projectId: input.projectId, priority: input.priority, title: input.title, payload: input.payload as Prisma.InputJsonValue, targetFilter: input.targetFilter as Prisma.InputJsonValue, channels: input.channels, createdBy: input.createdBy } }); return { id: campaign.id, projectId: campaign.projectId, priority: campaign.priority }; }
  async getCampaign(id: string) { const campaign = await this.prisma.notificationCampaign.findUnique({ where: { id } }); if (!campaign) return null; return { id: campaign.id, projectId: campaign.projectId, title: campaign.title, payload: campaign.payload as Record<string, unknown>, targetFilter: campaign.targetFilter as Record<string, unknown>, channels: campaign.channels }; }
  async createDeliveryLogs(input: { campaignId: string; projectId: string; endpoints: Array<{ id: string; channel: any }>; providerByChannel: Record<string, string> }): Promise<string[]> { await this.prisma.deliveryLog.createMany({ data: input.endpoints.map((endpoint) => ({ campaignId: input.campaignId, endpointId: endpoint.id, projectId: input.projectId, channel: endpoint.channel, provider: input.providerByChannel[endpoint.channel] ?? endpoint.channel })), skipDuplicates: true }); const rows = await this.prisma.deliveryLog.findMany({ where: { campaignId: input.campaignId, endpointId: { in: input.endpoints.map((endpoint) => endpoint.id) } }, select: { id: true } }); return rows.map((row) => row.id); }
  async getDeliveryBatch(ids: string[]) { const rows = await this.prisma.deliveryLog.findMany({ where: { id: { in: ids } }, include: { endpoint: true, campaign: true } }); return rows.filter((row) => row.endpoint).map((row) => ({ id: row.id, channel: row.channel, address: row.endpoint!.address, title: row.campaign.title, body: typeof row.campaign.payload === 'object' && row.campaign.payload !== null && !Array.isArray(row.campaign.payload) && typeof (row.campaign.payload as any).body === 'string' ? (row.campaign.payload as any).body : row.campaign.title, payload: row.campaign.payload as Record<string, unknown> })); }
  async claimDelivery(id: string) { const row = await this.prisma.deliveryLog.updateMany({ where: { id, status: { in: ['PENDING', 'RETRYING'] }, nextAttemptAt: { lte: new Date() } }, data: { status: 'RETRYING', attempt: { increment: 1 } } }); if (row.count !== 1) return null; const delivery = await this.prisma.deliveryLog.findUniqueOrThrow({ where: { id } }); return { id: delivery.id, campaignId: delivery.campaignId, endpointId: delivery.endpointId!, channel: delivery.channel, attempt: delivery.attempt }; }
  completeDelivery(id: string, providerRef?: string) { return this.prisma.deliveryLog.update({ where: { id }, data: { status: 'SENT', providerRef, sentAt: new Date() } }).then(() => undefined); }
  failDelivery(id: string, errorCode: string, errorMessage: string, retryAt?: Date) { return this.prisma.deliveryLog.update({ where: { id }, data: retryAt ? { status: 'RETRYING', errorCode, errorMessage, nextAttemptAt: retryAt } : { status: 'FAILED', errorCode, errorMessage, failedAt: new Date() } }).then(() => undefined); }
  async beginInbox(eventId: string, eventType: string) { return this.prisma.$transaction(async (tx) => { const current = await tx.inboxEvent.findUnique({ where: { eventId } }); if (current?.status === 'PROCESSED') return false; if (current) await tx.inboxEvent.update({ where: { eventId }, data: { status: 'PROCESSING', attempts: { increment: 1 } } }); else await tx.inboxEvent.create({ data: { eventId, eventType, status: 'PROCESSING', attempts: 1 } }); return true; }); }
  completeInbox(eventId: string) { return this.prisma.inboxEvent.update({ where: { eventId }, data: { status: 'PROCESSED', processedAt: new Date() } }).then(() => undefined); }
  failInbox(eventId: string, error: string) { return this.prisma.inboxEvent.update({ where: { eventId }, data: { status: 'FAILED', lastError: error.slice(0, 2000) } }).then(() => undefined); }
}
