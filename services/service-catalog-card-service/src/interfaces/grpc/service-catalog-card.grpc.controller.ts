import { Controller } from '@nestjs/common';
import { Ctx, GrpcMethod, RpcException } from '@nestjs/microservices';
import { status } from '@grpc/grpc-js';
import { getGrpcRequestContext, GrpcCall } from '../../../../../libs/common/src/base-microservice';
import { isStaffContext } from '../../../../../libs/common/src/context-proof';
import { CardLifecycleServiceImpl } from '../../application/card-lifecycle.service';
import { PricingApplicationServiceImpl } from '../../application/pricing.application.service';
import { decimal } from '../../domain/pricing.types';

interface CalculateRequest {
  pricingPlanId?: string;
  quantity?: string;
  areaSqm?: string;
  headcount?: string;
  vehicleCount?: string;
  periodStart?: string;
  periodEnd?: string;
  serviceStart?: string;
  serviceEnd?: string;
}

interface IssueRequest { projectId?: string; residentId?: string; apartmentId?: string; type?: string; chipUid?: string; externalNumber?: string; expiresAt?: string }
interface CardRequest { cardId?: string; reason?: string }

@Controller()
export class ServiceCatalogCardGrpcController {
  constructor(
    private readonly pricing: PricingApplicationServiceImpl,
    private readonly cards: CardLifecycleServiceImpl,
  ) {}

  @GrpcMethod('ServiceCatalogCardService', 'CalculateCharge')
  async calculateCharge(request: CalculateRequest, @Ctx() call: GrpcCall) {
    getGrpcRequestContext(call);
    const planId = this.required(request.pricingPlanId, 'pricing_plan_id');
    const periodStart = this.date(request.periodStart, 'period_start');
    const periodEnd = this.date(request.periodEnd, 'period_end');
    const result = await this.pricing.calculate({ pricingPlanId: planId, context: { quantity: request.quantity ? decimal(request.quantity) : undefined, areaSqm: request.areaSqm ? decimal(request.areaSqm) : undefined, headcount: request.headcount ? decimal(request.headcount) : undefined, vehicleCount: request.vehicleCount ? decimal(request.vehicleCount) : undefined, periodStart, periodEnd, serviceStart: request.serviceStart ? this.date(request.serviceStart, 'service_start') : undefined, serviceEnd: request.serviceEnd ? this.date(request.serviceEnd, 'service_end') : undefined } });
    return { netAmount: result.netAmount.toFixed(), vatAmount: result.vatAmount.toFixed(), environmentalFee: result.environmentalFee.toFixed(), totalAmount: result.totalAmount.toFixed(), currencyCode: result.currencyCode, roundingScale: String(result.roundingScale) };
  }

  @GrpcMethod('ServiceCatalogCardService', 'IssueCard')
  async issueCard(request: IssueRequest, @Ctx() call: GrpcCall) {
    const context = getGrpcRequestContext(call);
    if (!isStaffContext(context)) throw new RpcException({ code: status.PERMISSION_DENIED, message: 'Staff or management role is required' });
    if (request.projectId !== context.tenantId) throw new RpcException({ code: status.PERMISSION_DENIED, message: 'Cross-tenant card issuance denied' });
    const card = await this.cards.issue({ projectId: context.tenantId, residentId: this.required(request.residentId, 'resident_id'), apartmentId: request.apartmentId, type: this.enum(request.type, ['ELEVATOR', 'PARKING', 'APARTMENT_ACCESS'], 'type') as 'ELEVATOR' | 'PARKING' | 'APARTMENT_ACCESS', chipUid: this.required(request.chipUid, 'chip_uid'), externalNumber: this.required(request.externalNumber, 'external_number'), expiresAt: request.expiresAt ? this.date(request.expiresAt, 'expires_at') : undefined });
    return this.cardResponse(card);
  }

  @GrpcMethod('ServiceCatalogCardService', 'BlockCard')
  async blockCard(request: CardRequest, @Ctx() call: GrpcCall) {
    const context = getGrpcRequestContext(call);
    if (!isStaffContext(context)) throw new RpcException({ code: status.PERMISSION_DENIED, message: 'Staff or management role is required' });
    const card = await this.cards.block(context.tenantId, this.required(request.cardId, 'card_id'), this.enum(request.reason, ['OVERDUE_DEBT', 'LOST', 'SECURITY_INCIDENT', 'ADMINISTRATIVE'], 'reason') as 'OVERDUE_DEBT' | 'LOST' | 'SECURITY_INCIDENT' | 'ADMINISTRATIVE');
    return this.cardResponse(card);
  }

  @GrpcMethod('ServiceCatalogCardService', 'UnblockCard')
  async unblockCard(request: CardRequest, @Ctx() call: GrpcCall) {
    const context = getGrpcRequestContext(call);
    if (!isStaffContext(context)) throw new RpcException({ code: status.PERMISSION_DENIED, message: 'Staff or management role is required' });
    return this.cardResponse(await this.cards.unblock(context.tenantId, this.required(request.cardId, 'card_id')));
  }

  private cardResponse(card: Awaited<ReturnType<CardLifecycleServiceImpl['issue']>>) {
    return { id: card.id, projectId: card.projectId, residentId: card.residentId, apartmentId: card.apartmentId ?? '', type: card.type, chipUid: card.chipUid, externalNumber: card.externalNumber, status: card.status, blockedAt: card.blockedAt?.toISOString() ?? '' };
  }

  private required(value: string | undefined, name: string): string { if (!value || value.length > 256) throw new RpcException({ code: status.INVALID_ARGUMENT, message: `${name} is required` }); return value; }
  private date(value: string | undefined, name: string): Date { const date = new Date(this.required(value, name)); if (Number.isNaN(date.getTime())) throw new RpcException({ code: status.INVALID_ARGUMENT, message: `${name} must be RFC3339` }); return date; }
  private enum(value: string | undefined, allowed: string[], name: string): string { const result = this.required(value, name); if (!allowed.includes(result)) throw new RpcException({ code: status.INVALID_ARGUMENT, message: `${name} is invalid` }); return result; }
}
