import { randomUUID } from 'node:crypto';
import Decimal from 'decimal.js';
import { Prisma, PrismaClient } from '@prisma/client';
import { PricingPlanRepository, CardRepository, InboxRepository, SmartCardRecord } from '../../application/ports';
import { PricingPlanSnapshot } from '../../domain/pricing.types';

function dec(value: unknown): Decimal { return new Decimal(String(value)); }

function mapCard(value: { id: string; projectId: string; residentId: string; apartmentId: string | null; type: string; chipUid: string; externalNumber: string; status: string; blockReason: string | null; blockedAt: Date | null }): SmartCardRecord {
  return { ...value, type: value.type as SmartCardRecord['type'], status: value.status as SmartCardRecord['status'], blockReason: value.blockReason as SmartCardRecord['blockReason'] };
}

function outbox(input: { projectId?: string; eventType: string; aggregateType: string; aggregateId: string; payload: Record<string, unknown> }) {
  return { eventId: randomUUID(), topic: 'qhome.service-catalog.events.v1', eventType: input.eventType, aggregateType: input.aggregateType, aggregateId: input.aggregateId, projectId: input.projectId, payload: input.payload as Prisma.InputJsonValue };
}

export class PrismaServiceCatalogRepository implements PricingPlanRepository, CardRepository, InboxRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async getSnapshot(planId: string, at: Date): Promise<PricingPlanSnapshot> {
    const plan = await this.prisma.pricingPlan.findFirst({ where: { id: planId, effectiveFrom: { lte: at }, OR: [{ effectiveTo: null }, { effectiveTo: { gt: at } }] }, include: { tiers: { orderBy: { sequence: 'asc' } } } });
    if (!plan) throw new Error('Pricing plan is not active at the requested date');
    return {
      id: plan.id,
      formulaType: plan.formulaType,
      baseAmount: dec(plan.baseAmount),
      unitPrice: dec(plan.unitPrice),
      includedQty: dec(plan.includedQty),
      vatRate: dec(plan.vatRate),
      environmentalFeeRate: dec(plan.environmentalFeeRate),
      currencyCode: plan.currencyCode,
      roundingScale: plan.roundingScale,
      tiers: plan.tiers.map((tier) => ({ lowerBound: dec(tier.lowerBound), upperBound: tier.upperBound === null ? null : dec(tier.upperBound), unitPrice: dec(tier.unitPrice), fixedCharge: dec(tier.fixedCharge), vatRate: dec(tier.vatRate), environmentalFeeRate: dec(tier.environmentalFeeRate), sequence: tier.sequence })),
    };
  }

  async issue(input: { projectId: string; residentId: string; apartmentId?: string; type: SmartCardRecord['type']; chipUid: string; externalNumber: string; expiresAt?: Date }): Promise<SmartCardRecord> {
    return this.prisma.$transaction(async (tx) => {
      const card = await tx.smartCard.create({ data: { ...input, apartmentId: input.apartmentId, status: 'ACTIVE', expiresAt: input.expiresAt } });
      await tx.outboxEvent.create({ data: outbox({ projectId: input.projectId, eventType: 'service_catalog.card.issued.v1', aggregateType: 'smart_card', aggregateId: card.id, payload: { cardId: card.id, residentId: card.residentId, apartmentId: card.apartmentId, type: card.type } }) });
      return mapCard(card);
    });
  }

  async block(cardId: string, reason: NonNullable<SmartCardRecord['blockReason']>): Promise<SmartCardRecord> {
    return this.prisma.$transaction(async (tx) => {
      const card = await tx.smartCard.update({ where: { id: cardId }, data: { status: 'BLOCKED', blockReason: reason, blockedAt: new Date(), version: { increment: 1 } } });
      await tx.outboxEvent.create({ data: outbox({ projectId: card.projectId, eventType: 'service_catalog.card.blocked.v1', aggregateType: 'smart_card', aggregateId: card.id, payload: { cardId: card.id, reason } }) });
      return mapCard(card);
    });
  }

  async unblock(cardId: string): Promise<SmartCardRecord> {
    return this.prisma.$transaction(async (tx) => {
      const card = await tx.smartCard.updateMany({ where: { id: cardId, status: 'BLOCKED' }, data: { status: 'ACTIVE', blockReason: null, blockedAt: null, version: { increment: 1 } } });
      if (card.count !== 1) throw new Error('Card is not blocked or does not exist');
      const updated = await tx.smartCard.findUniqueOrThrow({ where: { id: cardId } });
      await tx.outboxEvent.create({ data: outbox({ projectId: updated.projectId, eventType: 'service_catalog.card.unblocked.v1', aggregateType: 'smart_card', aggregateId: updated.id, payload: { cardId: updated.id } }) });
      return mapCard(updated);
    });
  }

  async revoke(cardId: string): Promise<SmartCardRecord> {
    return this.prisma.$transaction(async (tx) => {
      const card = await tx.smartCard.update({ where: { id: cardId }, data: { status: 'REVOKED', revokedAt: new Date(), version: { increment: 1 } } });
      await tx.outboxEvent.create({ data: outbox({ projectId: card.projectId, eventType: 'service_catalog.card.revoked.v1', aggregateType: 'smart_card', aggregateId: card.id, payload: { cardId: card.id } }) });
      return mapCard(card);
    });
  }

  async blockActiveCardsByResident(projectId: string, residentId: string, reason: NonNullable<SmartCardRecord['blockReason']>): Promise<number> {
    return this.prisma.$transaction(async (tx) => {
      const active = await tx.smartCard.findMany({ where: { projectId, residentId, status: 'ACTIVE' }, select: { id: true } });
      if (active.length === 0) return 0;
      await tx.smartCard.updateMany({ where: { id: { in: active.map((card) => card.id) }, status: 'ACTIVE' }, data: { status: 'BLOCKED', blockReason: reason, blockedAt: new Date(), version: { increment: 1 } } });
      await tx.outboxEvent.createMany({ data: active.map((card) => outbox({ projectId, eventType: 'service_catalog.card.blocked.v1', aggregateType: 'smart_card', aggregateId: card.id, payload: { cardId: card.id, residentId, reason } })) });
      return active.length;
    });
  }

  async processOnce<T>(input: { eventId: string; eventType: string; handler: () => Promise<T> }): Promise<{ processed: boolean; result?: T }> {
    try {
      await this.prisma.inboxMessage.create({ data: { eventId: input.eventId, eventType: input.eventType, status: 'PROCESSING' } });
    } catch (error) {
      if ((error as { code?: string }).code === 'P2002') return { processed: false };
      throw error;
    }
    try {
      const result = await input.handler();
      await this.prisma.inboxMessage.update({ where: { eventId: input.eventId }, data: { status: 'PROCESSED', processedAt: new Date(), attempts: { increment: 1 } } });
      return { processed: true, result };
    } catch (error) {
      await this.prisma.inboxMessage.update({ where: { eventId: input.eventId }, data: { status: 'FAILED', attempts: { increment: 1 }, lastError: error instanceof Error ? error.message.slice(0, 2000) : 'event handler failed' } });
      throw error;
    }
  }
}
