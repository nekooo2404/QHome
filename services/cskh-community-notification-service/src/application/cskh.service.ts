import { NotificationChannel, NotificationPriority, TicketStatus } from '@prisma/client';
import { assertTicketTransition } from '../domain/ticket.state-machine';
import { CskhRepository, QueueAdapter, SupportContext } from './ports';

export class CskhService {
  constructor(private readonly repository: CskhRepository, private readonly queue: QueueAdapter) {}

  createNews(context: SupportContext, body: { type: string; title: string; body: string; buildingId?: string; publishedAt?: string; expiresAt?: string }) {
    if (!['BQT_BQL', 'INTERNAL_COMMUNITY', 'GOVERNMENT'].includes(body.type)) throw new Error('news type is invalid');
    return this.repository.createNews({ ...body, projectId: context.projectId, buildingId: body.buildingId ?? context.buildingId, publishedAt: body.publishedAt ? new Date(body.publishedAt) : new Date(), expiresAt: body.expiresAt ? new Date(body.expiresAt) : undefined, actorId: context.actorId, correlationId: context.correlationId });
  }

  listNews(context: SupportContext, query: { cursor?: string; take?: number }) { return this.repository.listNews({ projectId: context.projectId, buildingId: context.buildingId, cursor: query.cursor, take: Math.min(Math.max(query.take ?? 20, 1), 100) }); }

  createTicket(context: SupportContext, body: { type: string; priority?: string; subject: string; description: string; firstResponseMinutes?: number; resolutionMinutes?: number }) {
    if (!['SUGGESTION', 'SUPPORT', 'COMPLAINT'].includes(body.type)) throw new Error('ticket type is invalid');
    const now = new Date(); const first = Number(body.firstResponseMinutes ?? 60); const resolution = Number(body.resolutionMinutes ?? 1440);
    if (!Number.isInteger(first) || first <= 0 || !Number.isInteger(resolution) || resolution <= first) throw new Error('invalid SLA durations');
    return this.repository.createTicket({ projectId: context.projectId, buildingId: context.buildingId, apartmentId: context.apartmentId, residentId: context.actorId, type: body.type, priority: body.priority ?? 'NORMAL', subject: body.subject, description: body.description, firstResponseDueAt: new Date(now.getTime() + first * 60_000), resolutionDueAt: new Date(now.getTime() + resolution * 60_000), actorId: context.actorId, correlationId: context.correlationId });
  }

  async transitionTicket(context: SupportContext, ticketId: string, body: { expectedVersion: number; nextStatus: TicketStatus; comment?: string }) {
    const current = await this.requiredTicket(context.projectId, ticketId); assertTicketTransition(current.status, body.nextStatus);
    return this.repository.transitionTicket({ projectId: context.projectId, ticketId, expectedVersion: body.expectedVersion, nextStatus: body.nextStatus, actorId: context.actorId, comment: body.comment, correlationId: context.correlationId });
  }

  assignTicket(context: SupportContext, ticketId: string, body: { expectedVersion: number; assignedTo?: string; departmentId?: string }) { return this.repository.assignTicket({ projectId: context.projectId, ticketId, ...body, actorId: context.actorId, correlationId: context.correlationId }); }
  rateTicket(context: SupportContext, ticketId: string, body: { score: number; comment?: string }) { if (body.score < 0 || body.score > 5) throw new Error('score must be between 0 and 5'); return this.repository.rateTicket({ projectId: context.projectId, ticketId, residentId: context.actorId, ...body, correlationId: context.correlationId }); }
  listTickets(context: SupportContext, query: { status?: TicketStatus; assignedTo?: string; cursor?: string; take?: number }) { return this.repository.listTickets({ projectId: context.projectId, residentId: context.actorId, ...query, take: Math.min(Math.max(query.take ?? 20, 1), 100) }); }

  async enqueueCampaign(context: SupportContext, body: { title: string; payload: Record<string, unknown>; targetFilter: Record<string, unknown>; channels: NotificationChannel[]; priority: NotificationPriority }) {
    if (!body.channels?.length || body.channels.some((channel) => !Object.values(NotificationChannel).includes(channel))) throw new Error('notification channels are invalid');
    if (!Object.values(NotificationPriority).includes(body.priority)) throw new Error('notification priority is invalid');
    const campaign = await this.repository.createCampaign({ projectId: context.projectId, ...body, createdBy: context.actorId });
    await this.queue.add(body.priority === 'CRITICAL' ? 'critical-fanout' : 'bulk-fanout', { campaignId: campaign.id }, { attempts: 5, backoff: { type: 'exponential', delay: 1000 }, priority: body.priority === 'CRITICAL' ? 1 : 10 });
    return campaign;
  }

  enqueueAutomaticCampaign(input: { projectId: string; userId: string; title: string; body: string }) {
    return this.enqueueCampaign({ projectId: input.projectId, actorId: '00000000-0000-0000-0000-000000000000', correlationId: `automatic:${input.userId}` }, { title: input.title, payload: { body: input.body }, targetFilter: { userId: input.userId }, channels: ['PUSH', 'EMAIL'], priority: 'BULK' });
  }

  private async requiredTicket(projectId: string, ticketId: string) { const ticket = await this.repository.getTicket(projectId, ticketId); if (!ticket) throw new Error('Ticket not found'); return ticket; }
}
