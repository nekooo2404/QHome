import { randomUUID } from 'node:crypto';
import { OnModuleDestroy } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { MarketplaceRepository, CatalogProduct, CatalogShop, CreateOrderInput, HomeServiceCatalogItem, OrderSnapshot, TechnicianCandidate, UtilityContractSnapshot } from '../../application/ports';
import { ServiceOrderStatus, transitionOrder as assertTransition } from '../../domain/order.state-machine';

type Tx = Prisma.TransactionClient;

const asRecord = (value: Prisma.JsonValue | null | undefined): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
};

const asBigInt = (value: unknown): bigint => BigInt(String(value));
const asString = (value: unknown): string => String(value);
const isSerializationConflict = (error: unknown): boolean => (error as { code?: string }).code === 'P2034';

function outbox(projectId: string, eventType: string, aggregateType: string, aggregateId: string, payload: Record<string, unknown>) {
  return {
    eventId: randomUUID(),
    projectId,
    topic: 'qhome.marketplace.events.v1',
    eventType,
    aggregateType,
    aggregateId,
    payload: payload as Prisma.InputJsonValue,
    headers: {},
  };
}

function orderInclude() {
  return {
    shop: { select: { partnerId: true } },
    serviceCatalog: { select: { category: true, code: true, requiredSkills: true, partnerId: true, requiresTechnician: true } },
    items: true,
    assignments: true,
  } as const;
}

function mapOrder(row: any): OrderSnapshot {
  return {
    id: row.id,
    projectId: row.projectId,
    apartmentId: row.apartmentId,
    residentId: row.residentId,
    type: row.type as OrderSnapshot['type'],
    status: row.status as ServiceOrderStatus,
    shopId: row.shopId ?? undefined,
    shopPartnerId: row.shop?.partnerId ?? undefined,
    serviceCatalogId: row.serviceCatalogId ?? undefined,
    serviceCategory: row.serviceCatalog?.category ?? undefined,
    servicePartnerId: row.serviceCatalog?.partnerId ?? undefined,
    requiresTechnician: row.serviceCatalog?.requiresTechnician ?? false,
    requiredSkills: row.serviceCatalog?.requiredSkills ?? [],
    currencyCode: row.currencyCode,
    subtotalMinorUnits: asString(row.subtotalMinorUnits),
    serviceFeeMinorUnits: asString(row.serviceFeeMinorUnits),
    totalMinorUnits: asString(row.totalMinorUnits),
    scheduledStart: row.scheduledStart ?? undefined,
    scheduledEnd: row.scheduledEnd ?? undefined,
    addressSnapshot: asRecord(row.addressSnapshot),
    notes: row.notes ?? undefined,
    paymentIntentId: row.paymentIntentId ?? undefined,
    idempotencyKey: row.idempotencyKey,
    version: row.version,
    paidAt: row.paidAt ?? undefined,
    completedAt: row.completedAt ?? undefined,
    cancelledAt: row.cancelledAt ?? undefined,
    refundedAt: row.refundedAt ?? undefined,
    cancellationReason: row.cancellationReason ?? undefined,
    items: row.items.map((item: any) => ({
      id: item.id,
      productId: item.productId ?? undefined,
      serviceCatalogId: item.serviceCatalogId ?? undefined,
      description: item.descriptionSnapshot,
      sku: item.skuSnapshot ?? undefined,
      quantity: item.quantity,
      unitPriceMinorUnits: asString(item.unitPriceMinorUnits),
      totalMinorUnits: asString(item.totalMinorUnits),
    })),
    assignments: row.assignments.map((assignment: any) => ({
      id: assignment.id,
      partnerId: assignment.partnerId,
      technicianId: assignment.technicianId ?? undefined,
      type: assignment.type,
      status: assignment.status,
    })),
  };
}

async function findOrder(client: PrismaClient | Tx, projectId: string, apartmentId: string | undefined, orderId: string) {
  return client.serviceOrder.findFirst({
    where: { id: orderId, projectId, ...(apartmentId ? { apartmentId } : {}) },
    include: orderInclude(),
  });
}

export class MarketplacePrismaClient extends PrismaClient implements OnModuleDestroy {
  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}

export class PrismaMarketplaceRepository implements MarketplaceRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async createOrder(input: CreateOrderInput): Promise<OrderSnapshot> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await this.prisma.$transaction((tx) => this.createOrderTransaction(tx, input), {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
          maxWait: 5000,
          timeout: 15000,
        });
      } catch (error: unknown) {
        if (!isSerializationConflict(error) || attempt === 2) throw error;
      }
    }
    throw new Error('order creation retry budget exhausted');
  }

  private async createOrderTransaction(tx: Tx, input: CreateOrderInput): Promise<OrderSnapshot> {
    if (!input.projectId || !input.apartmentId || !input.residentId || !input.buildingId) throw new Error('project, apartment, resident, and building are required');
    if (!/^[A-Z]{3}$/.test(input.currencyCode)) throw new Error('currencyCode must be an ISO 4217 code');
    if (!input.items.length || input.items.length > 50) throw new Error('order item count is out of range');
    if (!input.idempotencyKey || input.idempotencyKey.length > 160) throw new Error('idempotencyKey is invalid');

    const existing = await tx.serviceOrder.findUnique({ where: { projectId_idempotencyKey: { projectId: input.projectId, idempotencyKey: input.idempotencyKey } }, include: orderInclude() });
    if (existing) {
      if (existing.idempotencyHash !== input.requestHash) throw new Error('idempotency key was reused with a different order');
      return mapOrder(existing);
    }

    const normalizedItems = input.items.map((item) => ({ ...item, quantity: Number(item.quantity) }));
    if (normalizedItems.some((item) => !Number.isInteger(item.quantity) || item.quantity <= 0 || item.quantity > 10000)) throw new Error('quantity must be a positive integer no greater than 10000');

    let shopId: string | undefined;
    let serviceCatalogId: string | undefined;
    const itemRows: Array<{ productId?: string; serviceCatalogId?: string; description: string; sku?: string; quantity: number; unitPriceMinorUnits: bigint; totalMinorUnits: bigint; metadataSnapshot: Prisma.InputJsonValue }> = [];
    let subtotal = 0n;

    if (input.type === 'INTERNAL_SHOP') {
      if (normalizedItems.some((item) => !item.productId || item.serviceCatalogId)) throw new Error('internal-shop orders require product items only');
      const productIds = Array.from(new Set(normalizedItems.map((item) => item.productId!))).sort();
      const products = await tx.product.findMany({ where: { id: { in: productIds }, projectId: input.projectId, status: 'ACTIVE', shop: { status: 'ACTIVE', OR: [{ buildingId: null }, { buildingId: input.buildingId }] } }, include: { shop: { select: { id: true } } } });
      if (products.length !== productIds.length) throw new Error('one or more products are unavailable for this building');
      if (products.some((product) => product.currencyCode !== input.currencyCode || product.priceMinorUnits <= 0n)) throw new Error('one or more products have an invalid price or currency');
      shopId = products[0].shopId;
      if (products.some((product) => product.shopId !== shopId)) throw new Error('an order may contain products from one internal shop only');

      const productById = new Map(products.map((product) => [product.id, product]));
      const quantities = new Map<string, number>();
      for (const item of normalizedItems) quantities.set(item.productId!, (quantities.get(item.productId!) ?? 0) + item.quantity);
      for (const productId of Array.from(quantities.keys()).sort()) {
        const quantity = quantities.get(productId)!;
        const locked = await tx.$queryRawUnsafe<Array<{ available_quantity: number; reserved_quantity: number; version: number }>>(
          'SELECT available_quantity, reserved_quantity, version FROM product_inventories WHERE product_id = $1::uuid AND building_id = $2::uuid FOR UPDATE',
          productId,
          input.buildingId,
        );
        if (!locked[0] || locked[0].available_quantity < quantity) throw new Error(`insufficient inventory for product ${productId}`);
        const updated = await tx.productInventory.updateMany({ where: { productId, buildingId: input.buildingId, version: locked[0].version }, data: { availableQuantity: { decrement: quantity }, reservedQuantity: { increment: quantity }, version: { increment: 1 } } });
        if (updated.count !== 1) throw new Error(`inventory changed while reserving product ${productId}`);
      }
      for (const item of normalizedItems) {
        const product = productById.get(item.productId!)!;
        const unit = asBigInt(product.priceMinorUnits);
        const total = unit * BigInt(item.quantity);
        subtotal += total;
        itemRows.push({ productId: product.id, description: product.name, sku: product.sku, quantity: item.quantity, unitPriceMinorUnits: unit, totalMinorUnits: total, metadataSnapshot: product.metadata as Prisma.InputJsonValue });
      }
    } else {
      if (normalizedItems.length !== 1 || !normalizedItems[0].serviceCatalogId || normalizedItems[0].productId) throw new Error('home-service orders require exactly one service item');
      if (!input.scheduledStart || !input.scheduledEnd || !Number.isFinite(input.scheduledStart.getTime()) || !Number.isFinite(input.scheduledEnd.getTime()) || input.scheduledEnd <= input.scheduledStart) throw new Error('a valid service time window is required');
      serviceCatalogId = normalizedItems[0].serviceCatalogId;
      const service = await tx.homeServiceCatalog.findFirst({ where: { id: serviceCatalogId, projectId: input.projectId, status: 'ACTIVE', OR: [{ availableBuildingIds: { isEmpty: true } }, { availableBuildingIds: { has: input.buildingId } }], AND: [{ OR: [{ partner: { is: null } }, { partner: { is: { status: 'ACTIVE' } } }] }] } });
      if (!service) throw new Error('home service is unavailable for this building');
      if (service.basePriceMinorUnits <= 0n) throw new Error('home service price must be positive');
      if (service.currencyCode !== input.currencyCode) throw new Error('order currency does not match service currency');
      const unit = asBigInt(service.basePriceMinorUnits);
      const total = unit * BigInt(normalizedItems[0].quantity);
      subtotal = total;
      itemRows.push({ serviceCatalogId: service.id, description: service.name, quantity: normalizedItems[0].quantity, unitPriceMinorUnits: unit, totalMinorUnits: total, metadataSnapshot: service.metadata as Prisma.InputJsonValue });
    }

    const order = await tx.serviceOrder.create({
      data: {
        projectId: input.projectId,
        apartmentId: input.apartmentId,
        residentId: input.residentId,
        type: input.type,
        status: 'CREATED',
        shopId,
        serviceCatalogId,
        currencyCode: input.currencyCode,
        subtotalMinorUnits: subtotal,
        serviceFeeMinorUnits: 0n,
        totalMinorUnits: subtotal,
        scheduledStart: input.scheduledStart,
        scheduledEnd: input.scheduledEnd,
        addressSnapshot: { ...input.addressSnapshot, buildingId: input.buildingId } as Prisma.InputJsonValue,
        notes: input.notes,
        idempotencyKey: input.idempotencyKey,
        idempotencyHash: input.requestHash,
        items: { create: itemRows.map((item) => ({ productId: item.productId, serviceCatalogId: item.serviceCatalogId, descriptionSnapshot: item.description, skuSnapshot: item.sku, quantity: item.quantity, unitPriceMinorUnits: item.unitPriceMinorUnits, totalMinorUnits: item.totalMinorUnits, metadataSnapshot: item.metadataSnapshot })) },
      },
      include: orderInclude(),
    });
    await tx.paymentSaga.create({ data: { orderId: order.id, projectId: input.projectId, status: 'CREATED', currentStep: 'ORDER_CREATED' } });
    await tx.orderTransition.create({ data: { orderId: order.id, projectId: input.projectId, fromStatus: null, toStatus: 'CREATED', actorId: input.actorId, correlationId: input.correlationId, occurredAt: new Date() } });
    await tx.outboxEvent.create({ data: outbox(input.projectId, 'marketplace.order.created.v1', 'service_order', order.id, { orderId: order.id, apartmentId: input.apartmentId, residentId: input.residentId, type: input.type, totalMinorUnits: subtotal.toString(), currencyCode: input.currencyCode }) });
    return mapOrder(order);
  }

  async getOrder(projectId: string, apartmentId: string | undefined, orderId: string): Promise<OrderSnapshot | null> {
    const order = await findOrder(this.prisma, projectId, apartmentId, orderId);
    return order ? mapOrder(order) : null;
  }

  async listOrders(projectId: string, apartmentId: string, take: number, cursor?: string): Promise<{ items: OrderSnapshot[]; nextCursor?: string }> {
    const rows = await this.prisma.serviceOrder.findMany({ where: { projectId, apartmentId }, include: orderInclude(), orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: take + 1, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}) });
    const visible = rows.length > take ? rows.slice(0, take) : rows;
    return { items: visible.map(mapOrder), nextCursor: rows.length > take ? visible.at(-1)?.id : undefined };
  }

  async findOrdersNeedingCompensation(now: Date, take: number): Promise<OrderSnapshot[]> {
    const rows = await this.prisma.serviceOrder.findMany({ where: { status: 'CANCELLED', paymentIntentId: { not: null }, saga: { is: { status: { in: ['COMPENSATING', 'FAILED'] }, nextAttemptAt: { lte: now } } } }, include: orderInclude(), orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }], take });
    return rows.map(mapOrder);
  }

  async setPaymentIntent(input: { projectId: string; orderId: string; paymentIntentId: string; expectedVersion: number }): Promise<OrderSnapshot> {
    return this.prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRawUnsafe<Array<{ id: string; version: number; status: string; payment_intent_id: string | null }>>('SELECT id, version, status, payment_intent_id FROM service_orders WHERE id = $1::uuid AND project_id = $2::uuid FOR UPDATE', input.orderId, input.projectId);
      const row = locked[0];
      if (!row || row.version !== input.expectedVersion) throw new Error('order version conflict while attaching payment intent');
      if (!['PAYMENT_PENDING', 'CANCELLED'].includes(row.status)) throw new Error('payment intent cannot be attached in the current order state');
      if (row.payment_intent_id && row.payment_intent_id !== input.paymentIntentId) throw new Error('payment intent conflicts with the order');
      await tx.serviceOrder.update({ where: { id: input.orderId }, data: { paymentIntentId: input.paymentIntentId, version: { increment: 1 } } });
      await tx.paymentSaga.update({ where: { orderId: input.orderId }, data: { paymentIntentId: input.paymentIntentId, version: { increment: 1 } } });
      const updated = await findOrder(tx, input.projectId, undefined, input.orderId);
      if (!updated) throw new Error('order disappeared while attaching payment intent');
      return mapOrder(updated);
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, maxWait: 5000, timeout: 10000 });
  }

  async transitionOrder(input: { projectId: string; orderId: string; expectedVersion: number; nextStatus: ServiceOrderStatus; actorId: string; reason?: string; correlationId: string }): Promise<OrderSnapshot> {
    return this.prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRawUnsafe<Array<{ id: string; project_id: string; apartment_id: string; status: ServiceOrderStatus; version: number; type: string; address_snapshot: Prisma.JsonValue }>>('SELECT id, project_id, apartment_id, status, version, type, address_snapshot FROM service_orders WHERE id = $1::uuid AND project_id = $2::uuid FOR UPDATE', input.orderId, input.projectId);
      const row = locked[0];
      if (!row || row.version !== input.expectedVersion) throw new Error('order not found or version conflict');
      const transition = assertTransition({ current: row.status, next: input.nextStatus, actorId: input.actorId, reason: input.reason });

      if (input.nextStatus === 'CANCELLED' || input.nextStatus === 'COMPLETED') {
        const buildingId = asRecord(row.address_snapshot).buildingId;
        if (row.type === 'INTERNAL_SHOP' && typeof buildingId !== 'string') throw new Error('order building scope is missing');
        await this.releaseReservedInventory(tx, input.orderId, row.type === 'INTERNAL_SHOP', input.nextStatus === 'CANCELLED', buildingId as string | undefined);
      }
      if (input.nextStatus === 'CANCELLED' || input.nextStatus === 'COMPLETED') {
        const assignments = await tx.technicianAssignment.findMany({ where: { orderId: input.orderId, status: { in: ['OFFERED', 'ACCEPTED'] }, technicianId: { not: null } }, select: { technicianId: true } });
        for (const assignment of assignments) {
          await tx.technicianProfile.updateMany({ where: { id: assignment.technicianId!, currentLoad: { gt: 0 } }, data: { currentLoad: { decrement: 1 }, version: { increment: 1 }, status: 'ACTIVE' } });
        }
        await tx.technicianAssignment.updateMany({ where: { orderId: input.orderId, status: { in: ['OFFERED', 'ACCEPTED'] } }, data: { status: input.nextStatus === 'COMPLETED' ? 'COMPLETED' : 'CANCELLED', reason: input.reason, version: { increment: 1 } } });
      }

      const updated = await tx.serviceOrder.update({ where: { id: input.orderId }, data: {
        status: input.nextStatus,
        version: { increment: 1 },
        paidAt: input.nextStatus === 'PAID' ? new Date() : undefined,
        completedAt: input.nextStatus === 'COMPLETED' ? new Date() : undefined,
        cancelledAt: input.nextStatus === 'CANCELLED' ? new Date() : undefined,
        refundedAt: input.nextStatus === 'REFUNDED' ? new Date() : undefined,
        cancellationReason: input.nextStatus === 'CANCELLED' ? input.reason : undefined,
      } });
      await tx.orderTransition.create({ data: { orderId: input.orderId, projectId: input.projectId, fromStatus: transition.from, toStatus: transition.to, actorId: input.actorId, reason: input.reason, correlationId: input.correlationId, occurredAt: transition.occurredAt } });
      await tx.outboxEvent.create({ data: outbox(input.projectId, 'marketplace.order.status_changed.v1', 'service_order', input.orderId, { orderId: input.orderId, fromStatus: transition.from, toStatus: transition.to, reason: input.reason, version: updated.version }) });
      const result = await findOrder(tx, input.projectId, undefined, input.orderId);
      if (!result) throw new Error('order disappeared after transition');
      return mapOrder(result);
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, maxWait: 5000, timeout: 15000 });
  }

  private async releaseReservedInventory(tx: Tx, orderId: string, internalShop: boolean, cancelled: boolean, buildingId?: string): Promise<void> {
    if (!internalShop) return;
    if (!buildingId) throw new Error('inventory building scope is required');
    const items = await tx.serviceOrderItem.findMany({ where: { orderId, productId: { not: null } }, select: { productId: true, quantity: true } });
    for (const item of items) {
      const updated = await tx.productInventory.updateMany({ where: { productId: item.productId!, buildingId, reservedQuantity: { gte: item.quantity } }, data: { reservedQuantity: { decrement: item.quantity }, ...(cancelled ? { availableQuantity: { increment: item.quantity } } : {}), version: { increment: 1 } } });
      if (updated.count !== 1) throw new Error('inventory reservation is inconsistent with the order');
    }
  }

  async assignOrder(input: { projectId: string; orderId: string; expectedVersion: number; actorId: string; correlationId: string; partnerId: string; technicianId?: string; score?: number }): Promise<OrderSnapshot> {
    return this.prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRawUnsafe<Array<{ id: string; status: ServiceOrderStatus; version: number; apartment_id: string; scheduled_start: Date | null; scheduled_end: Date | null }>>('SELECT id, status, version, apartment_id, scheduled_start, scheduled_end FROM service_orders WHERE id = $1::uuid AND project_id = $2::uuid FOR UPDATE', input.orderId, input.projectId);
      const order = locked[0];
      if (!order || order.version !== input.expectedVersion) throw new Error('order not found or version conflict while assigning partner');
      const transition = assertTransition({ current: order.status, next: 'PARTNER_ASSIGNED', actorId: input.actorId });
      const partner = await tx.servicePartner.findFirst({ where: { id: input.partnerId, projectId: input.projectId, status: 'ACTIVE' } });
      if (!partner) throw new Error('fulfillment partner is unavailable');

      let type: 'SHOP_PARTNER' | 'TECHNICIAN' = 'SHOP_PARTNER';
      if (input.technicianId) {
        type = 'TECHNICIAN';
        const technician = await tx.$queryRawUnsafe<Array<{ id: string; partner_id: string; status: string; current_load: number; max_concurrent_jobs: number }>>('SELECT id, partner_id, status, current_load, max_concurrent_jobs FROM technician_profiles WHERE id = $1::uuid AND project_id = $2::uuid FOR UPDATE', input.technicianId, input.projectId);
        if (!technician[0] || technician[0].partner_id !== input.partnerId || !['ACTIVE', 'BUSY'].includes(technician[0].status) || technician[0].current_load >= technician[0].max_concurrent_jobs) throw new Error('technician is unavailable');
        if (order.scheduled_start && order.scheduled_end) {
          const conflicts = await tx.$queryRawUnsafe<Array<{ id: string }>>('SELECT ta.id FROM technician_assignments ta JOIN service_orders so ON so.id = ta.order_id WHERE ta.technician_id = $1::uuid AND ta.status = \'ACCEPTED\' AND so.scheduled_start < $3 AND so.scheduled_end > $2 FOR UPDATE', input.technicianId, order.scheduled_start, order.scheduled_end);
          if (conflicts.length >= technician[0].max_concurrent_jobs) throw new Error('technician has no capacity in the requested time window');
        }
        await tx.technicianProfile.update({ where: { id: input.technicianId }, data: { currentLoad: { increment: 1 }, version: { increment: 1 }, status: 'BUSY' } });
      }
      await tx.technicianAssignment.create({ data: { orderId: input.orderId, projectId: input.projectId, partnerId: input.partnerId, technicianId: input.technicianId, type, status: 'ACCEPTED', score: input.score ?? 0 } });
      const updated = await tx.serviceOrder.update({ where: { id: input.orderId }, data: { status: 'PARTNER_ASSIGNED', version: { increment: 1 } } });
      await tx.orderTransition.create({ data: { orderId: input.orderId, projectId: input.projectId, fromStatus: transition.from, toStatus: transition.to, actorId: input.actorId, correlationId: input.correlationId, occurredAt: transition.occurredAt } });
      await tx.paymentSaga.update({ where: { orderId: input.orderId }, data: { status: 'DISPATCHED', currentStep: 'PARTNER_ASSIGNED', version: { increment: 1 } } });
      await tx.outboxEvent.create({ data: outbox(input.projectId, 'marketplace.order.partner_assigned.v1', 'service_order', input.orderId, { orderId: input.orderId, partnerId: input.partnerId, technicianId: input.technicianId, assignmentType: type, version: updated.version }) });
      const result = await findOrder(tx, input.projectId, undefined, input.orderId);
      if (!result) throw new Error('order disappeared after partner assignment');
      return mapOrder(result);
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, maxWait: 5000, timeout: 15000 });
  }

  async findTechnicianCandidates(input: { projectId: string; buildingId: string; skills: string[]; startsAt: Date; endsAt: Date }): Promise<TechnicianCandidate[]> {
    const rows = await this.prisma.technicianProfile.findMany({ where: { projectId: input.projectId, status: { in: ['ACTIVE', 'BUSY'] }, buildingIds: { has: input.buildingId }, ...(input.skills.length ? { skills: { hasEvery: input.skills } } : {}), availability: { some: { buildingId: input.buildingId, status: 'AVAILABLE', startsAt: { lte: input.startsAt }, endsAt: { gte: input.endsAt } } } }, orderBy: [{ currentLoad: 'asc' }, { rating: 'desc' }, { id: 'asc' }], take: 20 });
    return rows.filter((row) => row.currentLoad < row.maxConcurrentJobs).map((row) => ({ id: row.id, partnerId: row.partnerId, currentLoad: row.currentLoad, maxConcurrentJobs: row.maxConcurrentJobs, score: Number(row.rating) * 100 - row.currentLoad }));
  }

  async listShops(projectId: string, buildingId: string): Promise<CatalogShop[]> {
    const rows = await this.prisma.internalShop.findMany({ where: { projectId, status: 'ACTIVE', OR: [{ buildingId: null }, { buildingId }] }, orderBy: [{ name: 'asc' }, { id: 'asc' }] });
    return rows.map((row) => ({ id: row.id, projectId: row.projectId, buildingId: row.buildingId ?? undefined, partnerId: row.partnerId ?? undefined, name: row.name, slug: row.slug, description: row.description ?? undefined, status: row.status, opensAt: row.opensAt ?? undefined, closesAt: row.closesAt ?? undefined, metadata: asRecord(row.metadata) }));
  }

  async listProducts(projectId: string, buildingId: string, shopId: string): Promise<CatalogProduct[]> {
    const rows = await this.prisma.product.findMany({ where: { projectId, shopId, status: 'ACTIVE', shop: { status: 'ACTIVE', OR: [{ buildingId: null }, { buildingId }] } }, include: { inventory: { where: { buildingId }, select: { availableQuantity: true } } }, orderBy: [{ name: 'asc' }, { id: 'asc' }] });
    return rows.map((row) => ({ id: row.id, shopId: row.shopId, sku: row.sku, name: row.name, description: row.description ?? undefined, currencyCode: row.currencyCode, priceMinorUnits: asString(row.priceMinorUnits), status: row.status, availableQuantity: row.inventory[0]?.availableQuantity ?? 0, metadata: asRecord(row.metadata) }));
  }

  async listHomeServices(projectId: string, buildingId: string, category?: string): Promise<HomeServiceCatalogItem[]> {
    const rows = await this.prisma.homeServiceCatalog.findMany({ where: { projectId, status: 'ACTIVE', ...(category ? { category: category as any } : {}), OR: [{ availableBuildingIds: { isEmpty: true } }, { availableBuildingIds: { has: buildingId } }] }, orderBy: [{ name: 'asc' }, { id: 'asc' }] });
    return rows.map((row) => ({ id: row.id, projectId: row.projectId, partnerId: row.partnerId ?? undefined, code: row.code, name: row.name, category: row.category, description: row.description ?? undefined, currencyCode: row.currencyCode, basePriceMinorUnits: asString(row.basePriceMinorUnits), durationMinutes: row.durationMinutes, requiresTechnician: row.requiresTechnician, status: row.status, metadata: asRecord(row.metadata) }));
  }

  async listUtilityContracts(projectId: string, apartmentId: string): Promise<UtilityContractSnapshot[]> {
    const rows = await this.prisma.utilityContract.findMany({ where: { projectId, apartmentId }, orderBy: [{ serviceType: 'asc' }, { startsAt: 'desc' }] });
    return rows.map((row) => ({ id: row.id, serviceType: row.serviceType, providerName: row.providerName, contractNumber: row.contractNumber, status: row.status, connectionStatus: row.connectionStatus, accountReference: row.accountReference, startsAt: row.startsAt, endsAt: row.endsAt ?? undefined, connectedAt: row.connectedAt ?? undefined }));
  }

  async requestUtilityConnection(input: { projectId: string; apartmentId: string; contractId: string; actorId: string; correlationId: string }): Promise<UtilityContractSnapshot> {
    return this.prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRawUnsafe<Array<{ id: string; status: string; connection_status: string }>>('SELECT id, status, connection_status FROM utility_contracts WHERE id = $1::uuid AND project_id = $2::uuid AND apartment_id = $3::uuid FOR UPDATE', input.contractId, input.projectId, input.apartmentId);
      const contract = locked[0];
      if (!contract) throw new Error('utility contract not found');
      if (!['ACTIVE', 'SUSPENDED'].includes(contract.status)) throw new Error('utility contract cannot be connected in its current state');
      if (contract.connection_status === 'CONNECTED' || contract.connection_status === 'PENDING') {
        const current = await tx.utilityContract.findUnique({ where: { id: input.contractId } });
        if (!current) throw new Error('utility contract not found');
        return { id: current.id, serviceType: current.serviceType, providerName: current.providerName, contractNumber: current.contractNumber, status: current.status, connectionStatus: current.connectionStatus, accountReference: current.accountReference, startsAt: current.startsAt, endsAt: current.endsAt ?? undefined, connectedAt: current.connectedAt ?? undefined };
      }
      const updated = await tx.utilityContract.update({ where: { id: input.contractId }, data: { connectionStatus: 'PENDING', connectionRequestedAt: new Date() } });
      await tx.outboxEvent.create({ data: outbox(input.projectId, 'utility.connection.requested.v1', 'utility_contract', input.contractId, { contractId: input.contractId, apartmentId: input.apartmentId, residentId: input.actorId, serviceType: updated.serviceType, accountReference: updated.accountReference }) });
      return { id: updated.id, serviceType: updated.serviceType, providerName: updated.providerName, contractNumber: updated.contractNumber, status: updated.status, connectionStatus: updated.connectionStatus, accountReference: updated.accountReference, startsAt: updated.startsAt, endsAt: updated.endsAt ?? undefined, connectedAt: updated.connectedAt ?? undefined };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, maxWait: 5000, timeout: 10000 });
  }

  async updateSaga(input: { projectId: string; orderId: string; status: string; currentStep: string; paymentIntentId?: string; refundId?: string; lastError?: string; nextAttemptAt?: Date }): Promise<void> {
    await this.prisma.paymentSaga.update({ where: { orderId: input.orderId }, data: { status: input.status as any, currentStep: input.currentStep, paymentIntentId: input.paymentIntentId, refundId: input.refundId, lastError: input.lastError, ...(input.nextAttemptAt ? { nextAttemptAt: input.nextAttemptAt } : {}), ...(input.status === 'FAILED' ? { attempts: { increment: 1 } } : {}), version: { increment: 1 } } });
  }

  async beginInboxMessage(eventId: string, eventType: string): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.inboxMessage.findUnique({ where: { eventId } });
      if (existing?.status === 'PROCESSED') return false;
      if (existing) {
        await tx.inboxMessage.update({ where: { eventId }, data: { status: 'PROCESSING', attempts: { increment: 1 }, lastError: null } });
      } else {
        await tx.inboxMessage.create({ data: { eventId, eventType, status: 'PROCESSING', attempts: 1 } });
      }
      return true;
    });
  }

  completeInboxMessage(eventId: string): Promise<void> {
    return this.prisma.inboxMessage.update({ where: { eventId }, data: { status: 'PROCESSED', processedAt: new Date(), lastError: null } }).then(() => undefined);
  }

  failInboxMessage(eventId: string, error: string): Promise<void> {
    return this.prisma.inboxMessage.update({ where: { eventId }, data: { status: 'FAILED', lastError: error.slice(0, 2000) } }).then(() => undefined);
  }
}
