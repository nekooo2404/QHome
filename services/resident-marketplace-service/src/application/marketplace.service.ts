import { createHash } from 'node:crypto';
import { HttpException } from '@nestjs/common';
import { MarketplaceCache, MarketplaceContext, MarketplaceRepository, CreateOrderInput } from './ports';
import { OrderSagaOrchestrator } from './order-saga.orchestrator';

export class MarketplaceService {
  constructor(
    private readonly repository: MarketplaceRepository,
    private readonly cache: MarketplaceCache,
    private readonly saga: OrderSagaOrchestrator,
  ) {}

  async listShops(projectId: string, buildingId: string) {
    const key = `marketplace:shops:${projectId}:${buildingId}`;
    const cached = await this.cache.get(key);
    if (cached) return cached;
    const value = await this.repository.listShops(projectId, buildingId);
    await this.cache.set(key, value, Number(process.env.RESIDENT_MARKETPLACE_CATALOG_TTL_SECONDS ?? 30));
    return value;
  }

  async listProducts(projectId: string, buildingId: string, shopId: string) {
    const key = `marketplace:products:${projectId}:${buildingId}:${shopId}`;
    const cached = await this.cache.get(key);
    if (cached) return cached;
    const value = await this.repository.listProducts(projectId, buildingId, shopId);
    await this.cache.set(key, value, Number(process.env.RESIDENT_MARKETPLACE_CATALOG_TTL_SECONDS ?? 30));
    return value;
  }

  async listHomeServices(projectId: string, buildingId: string, category?: string) {
    const key = `marketplace:home-services:${projectId}:${buildingId}:${category ?? 'all'}`;
    const cached = await this.cache.get(key);
    if (cached) return cached;
    const value = await this.repository.listHomeServices(projectId, buildingId, category);
    await this.cache.set(key, value, Number(process.env.RESIDENT_MARKETPLACE_CATALOG_TTL_SECONDS ?? 30));
    return value;
  }

  listUtilityContracts(projectId: string, apartmentId: string) {
    return this.repository.listUtilityContracts(projectId, apartmentId);
  }

  connectUtilityContract(context: MarketplaceContext, contractId: string) {
    return this.repository.requestUtilityConnection({ projectId: context.projectId, apartmentId: context.apartmentId, contractId, actorId: context.actorId, correlationId: context.correlationId });
  }

  async createOrder(input: Omit<CreateOrderInput, 'requestHash'>) {
    if (!input.idempotencyKey?.trim()) throw new HttpException('idempotency-key is required', 400);
    if (!input.items.length) throw new HttpException('at least one order item is required', 400);
    const requestHash = createHash('sha256').update(JSON.stringify({
      buildingId: input.buildingId,
      type: input.type,
      currencyCode: input.currencyCode,
      items: input.items,
      scheduledStart: input.scheduledStart?.toISOString(),
      scheduledEnd: input.scheduledEnd?.toISOString(),
      addressSnapshot: input.addressSnapshot,
      notes: input.notes,
    })).digest('hex');
    const order = await this.repository.createOrder({ ...input, requestHash });
    return this.saga.startPayment(order, input);
  }

  getOrder(context: MarketplaceContext, orderId: string) {
    return this.repository.getOrder(context.projectId, context.apartmentId, orderId).then((order) => {
      if (!order) throw new HttpException('order not found', 404);
      return order;
    });
  }

  listOrders(context: MarketplaceContext, take = 20, cursor?: string) {
    return this.repository.listOrders(context.projectId, context.apartmentId, Math.min(Math.max(Number(take) || 20, 1), 100), cursor);
  }

  async cancelOrder(context: MarketplaceContext, orderId: string, reason: string) {
    if (!reason?.trim()) throw new HttpException('cancellation reason is required', 400);
    const order = await this.getOrder(context, orderId);
    return this.saga.cancelOrder(order, context, reason);
  }

  async handleBillingEvent(event: import('./ports').BillingPaymentEvent) {
    return this.saga.handleBillingEvent(event);
  }
}
