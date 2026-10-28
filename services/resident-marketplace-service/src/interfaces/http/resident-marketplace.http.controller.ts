import { Body, Controller, Get, Headers, HttpException, Param, Post, Query, Req } from '@nestjs/common';
import { ContextRequest, getRequestContext, requireApartmentId } from '../../../../../libs/common/src/base-microservice';
import { MarketplaceContext } from '../../application/ports';
import { MarketplaceService } from '../../application/marketplace.service';

type OrderBody = {
  type: 'INTERNAL_SHOP' | 'HOME_SERVICE';
  currencyCode: string;
  items: Array<{ productId?: string; serviceCatalogId?: string; quantity: number }>;
  scheduledStart?: string;
  scheduledEnd?: string;
  notes?: string;
  addressSnapshot?: Record<string, unknown>;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const HOME_SERVICE_CATEGORIES = new Set(['APARTMENT_CLEANING', 'REPAIR_MAINTENANCE', 'HEALTHCARE', 'ITEM_CLEANING', 'INTERIOR_EXTERIOR_CLEANING', 'HVAC']);

@Controller('/v1')
export class ResidentMarketplaceHttpController {
  constructor(private readonly service: MarketplaceService) {}

  @Get('/utility-contracts')
  utilityContracts(@Req() request: ContextRequest) {
    const context = this.context(request);
    return this.service.listUtilityContracts(context.projectId, context.apartmentId);
  }

  @Post('/utility-contracts/:contractId/connect')
  connectUtilityContract(@Req() request: ContextRequest, @Param('contractId') contractId: string) {
    if (!UUID.test(contractId)) throw new HttpException('contractId is invalid', 400);
    return this.service.connectUtilityContract(this.context(request), contractId);
  }

  @Get('/marketplace/shops')
  shops(@Req() request: ContextRequest) {
    const context = this.context(request);
    return this.service.listShops(context.projectId, context.buildingId);
  }

  @Get('/marketplace/shops/:shopId/products')
  products(@Req() request: ContextRequest, @Param('shopId') shopId: string) {
    const context = this.context(request);
    if (!UUID.test(shopId)) throw new HttpException('shopId is invalid', 400);
    return this.service.listProducts(context.projectId, context.buildingId, shopId);
  }

  @Get('/marketplace/home-services')
  homeServices(@Req() request: ContextRequest, @Query('category') category?: string) {
    const context = this.context(request);
    if (category && !HOME_SERVICE_CATEGORIES.has(category)) throw new HttpException('category is invalid', 400);
    return this.service.listHomeServices(context.projectId, context.buildingId, category);
  }

  @Post('/marketplace/orders')
  createOrder(@Req() request: ContextRequest, @Headers('idempotency-key') idempotencyKey: string, @Body() body: OrderBody) {
    const context = this.context(request);
    const residentId = context.residentId;
    if (!residentId) throw new HttpException('resident identity is required', 401);
    if (!body || !['INTERNAL_SHOP', 'HOME_SERVICE'].includes(body.type)) throw new HttpException('order type is invalid', 400);
    if (!/^[A-Z]{3}$/.test(body.currencyCode ?? '')) throw new HttpException('currencyCode is invalid', 400);
    if (!Array.isArray(body.items)) throw new HttpException('items are required', 400);
    if (!idempotencyKey?.trim() || idempotencyKey.length > 160) throw new HttpException('idempotency-key is invalid', 400);
    if (body.items.some((item) => !item || typeof item.quantity !== 'number' || !Number.isInteger(item.quantity) || item.quantity <= 0 || Boolean(item.productId) === Boolean(item.serviceCatalogId) || (item.productId !== undefined && !UUID.test(item.productId)) || (item.serviceCatalogId !== undefined && !UUID.test(item.serviceCatalogId)))) throw new HttpException('each item must contain exactly one valid productId or serviceCatalogId and a positive integer quantity', 400);
    if (body.addressSnapshot !== undefined && (typeof body.addressSnapshot !== 'object' || body.addressSnapshot === null || Array.isArray(body.addressSnapshot))) throw new HttpException('addressSnapshot must be an object', 400);
    if (body.notes !== undefined && body.notes.length > 4000) throw new HttpException('notes is too long', 400);

    const scheduledStart = body.scheduledStart ? new Date(body.scheduledStart) : undefined;
    const scheduledEnd = body.scheduledEnd ? new Date(body.scheduledEnd) : undefined;
    if ((scheduledStart && !Number.isFinite(scheduledStart.getTime())) || (scheduledEnd && !Number.isFinite(scheduledEnd.getTime()))) throw new HttpException('scheduled time is invalid', 400);
    return this.service.createOrder({
      projectId: context.projectId,
      buildingId: context.buildingId,
      apartmentId: context.apartmentId,
      residentId,
      actorId: context.actorId ?? residentId,
      correlationId: context.correlationId,
      type: body.type,
      idempotencyKey,
      currencyCode: body.currencyCode,
      items: body.items,
      scheduledStart,
      scheduledEnd,
      addressSnapshot: { ...(body.addressSnapshot ?? {}), apartmentId: context.apartmentId, buildingId: context.buildingId },
      notes: body.notes,
    });
  }

  @Get('/marketplace/orders/:orderId')
  getOrder(@Req() request: ContextRequest, @Param('orderId') orderId: string) {
    if (!UUID.test(orderId)) throw new HttpException('orderId is invalid', 400);
    return this.service.getOrder(this.context(request), orderId);
  }

  @Get('/marketplace/orders')
  listOrders(@Req() request: ContextRequest, @Query('take') take?: string, @Query('cursor') cursor?: string) {
    return this.service.listOrders(this.context(request), take ? Number(take) : 20, cursor);
  }

  @Post('/marketplace/orders/:orderId/cancel')
  cancelOrder(@Req() request: ContextRequest, @Param('orderId') orderId: string, @Body() body: { reason?: string }) {
    if (!UUID.test(orderId)) throw new HttpException('orderId is invalid', 400);
    return this.service.cancelOrder(this.context(request), orderId, body?.reason ?? 'Cancelled by resident');
  }

  private context(request: ContextRequest): MarketplaceContext {
    const transport = getRequestContext(request);
    const apartmentId = requireApartmentId(request);
    if (!transport.buildingId) throw new HttpException('x-building-id is required for marketplace operations', 400);
    return {
      projectId: transport.tenantId,
      buildingId: transport.buildingId,
      apartmentId,
      residentId: transport.subject ?? transport.actorId ?? '',
      actorId: transport.actorId ?? transport.subject ?? '',
      correlationId: transport.correlationId,
    };
  }
}
