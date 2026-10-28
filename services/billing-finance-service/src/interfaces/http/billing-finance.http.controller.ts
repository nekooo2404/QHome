import { Body, Controller, Get, Headers, Param, Post, Query, Req, Res } from '@nestjs/common';
import { ContextRequest, getRequestContext } from '../../../../../libs/common/src/base-microservice';
import { assertApartmentScope, assertStaffScope } from '../../../../../libs/common/src/apartment-scope';
import { InvoiceIssueWorker } from '../../application/invoice-issue.worker';
import { PaymentService } from '../../application/payment.service';
import { PaymentWebhookService } from '../../application/webhook.service';
import { ReportService } from '../../application/report.service';
import { PaymentRepository } from '../../application/ports';

interface RawRequest { rawBody?: Buffer | string }
interface RawResponse { status(code: number): { json(body: unknown): void } }

@Controller('/v1')
export class BillingFinanceHttpController {
  constructor(
    private readonly payments: PaymentService,
    private readonly webhook: PaymentWebhookService,
    private readonly reports: ReportService,
    private readonly repository: PaymentRepository,
    private readonly invoiceIssue: InvoiceIssueWorker,
  ) {}

  @Get('/apartments/:apartmentId/receivables')
  receivables(@Req() request: ContextRequest, @Param('apartmentId') apartmentId: string, @Query('currencyCode') currencyCode: string) {
    const context = getRequestContext(request);
    assertApartmentScope(context, apartmentId);
    return this.repository.loadOpenInvoicesForApartment(context.tenantId, apartmentId, currencyCode);
  }

  @Get('/apartments/:apartmentId/consumption-history')
  consumption(@Req() request: ContextRequest, @Param('apartmentId') apartmentId: string, @Query('from') from: string, @Query('to') to: string) {
    const context = getRequestContext(request);
    assertApartmentScope(context, apartmentId);
    return this.repository.getConsumptionHistory(context.tenantId, apartmentId, new Date(from), new Date(to));
  }

  @Post('/payments')
  payment(@Req() request: ContextRequest, @Headers('x-apartment-id') apartmentId: string, @Headers('idempotency-key') idempotencyKey: string, @Body() body: { provider: string; providerTransactionId: string; channel: 'BANK_TRANSFER' | 'E_WALLET' | 'VIETQR' | 'CASH'; currencyCode: string; grossAmount: string; rawReference?: string }) {
    const context = getRequestContext(request);
    assertApartmentScope(context, apartmentId);
    return this.payments.applyPayment({ ...body, projectId: context.tenantId, apartmentId, residentId: context.actorId, idempotencyKey });
  }

  @Post('/webhooks/payments/:provider')
  async webhookPayment(@Param('provider') provider: string, @Headers('x-signature') signature: string, @Headers('x-timestamp') timestamp: string, @Req() request: RawRequest, @Res() response: RawResponse) {
    const rawBody = request.rawBody instanceof Buffer ? request.rawBody.toString('utf8') : request.rawBody;
    if (!rawBody) return response.status(400).json({ error: { code: 'RAW_BODY_REQUIRED', message: 'Raw body is required' } });
    const result = await this.webhook.handle(provider, rawBody, signature, timestamp);
    return response.status(200).json(result);
  }

  @Get('/reports/cash-flow')
  cashFlow(@Req() request: ContextRequest, @Query('from') from: string, @Query('to') to: string) {
    const context = getRequestContext(request);
    assertStaffScope(context);
    return this.reports.cashFlow(context.tenantId, new Date(from), new Date(to));
  }

  @Get('/reports/receivables')
  reportReceivables(@Req() request: ContextRequest, @Query('asOf') asOf: string) {
    const context = getRequestContext(request); assertStaffScope(context); return this.reports.receivables(context.tenantId, new Date(asOf));
  }

  @Post('/invoices/issue-batch')
  issueBatch(@Req() request: ContextRequest, @Body() body: { billingPeriodId: string; items: Array<{ apartmentId: string; residentId?: string; serviceId: string; description: string; quantity: string; unitPrice: string; netAmount: string; vatAmount: string; totalAmount: string; currencyCode: string; pricingSnapshot: Record<string, unknown> }> }) {
    const context = getRequestContext(request);
    assertStaffScope(context);
    return this.invoiceIssue.process({ projectId: context.tenantId, billingPeriodId: body.billingPeriodId, items: body.items });
  }
}
