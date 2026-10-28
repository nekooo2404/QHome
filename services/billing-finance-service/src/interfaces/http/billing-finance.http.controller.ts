import { Body, Controller, Get, Headers, Param, Post, Query, Req, Res } from '@nestjs/common';
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
  ) {}

  @Get('/apartments/:apartmentId/receivables')
  receivables(@Headers('x-tenant-id') projectId: string, @Param('apartmentId') apartmentId: string, @Query('currencyCode') currencyCode: string) {
    return this.repository.loadOpenInvoicesForApartment(projectId, apartmentId, currencyCode);
  }

  @Get('/apartments/:apartmentId/consumption-history')
  consumption(@Headers('x-tenant-id') projectId: string, @Param('apartmentId') apartmentId: string, @Query('from') from: string, @Query('to') to: string) {
    return this.repository.getConsumptionHistory(projectId, apartmentId, new Date(from), new Date(to));
  }

  @Post('/payments')
  payment(@Headers('x-tenant-id') projectId: string, @Headers('x-apartment-id') apartmentId: string, @Headers('x-actor-id') residentId: string | undefined, @Headers('idempotency-key') idempotencyKey: string, @Body() body: { provider: string; providerTransactionId: string; channel: 'BANK_TRANSFER' | 'E_WALLET' | 'VIETQR' | 'CASH'; currencyCode: string; grossAmount: string; rawReference?: string }) {
    return this.payments.applyPayment({ ...body, projectId, apartmentId, residentId, idempotencyKey });
  }

  @Post('/webhooks/payments/:provider')
  async webhookPayment(@Param('provider') provider: string, @Headers('x-signature') signature: string, @Headers('x-timestamp') timestamp: string, @Req() request: RawRequest, @Res() response: RawResponse) {
    const rawBody = request.rawBody instanceof Buffer ? request.rawBody.toString('utf8') : request.rawBody;
    if (!rawBody) return response.status(400).json({ error: { code: 'RAW_BODY_REQUIRED', message: 'Raw body is required' } });
    const result = await this.webhook.handle(provider, rawBody, signature, timestamp);
    return response.status(200).json(result);
  }

  @Get('/reports/cash-flow')
  cashFlow(@Headers('x-tenant-id') projectId: string, @Query('from') from: string, @Query('to') to: string) {
    return this.reports.cashFlow(projectId, new Date(from), new Date(to));
  }

  @Get('/reports/receivables')
  reportReceivables(@Headers('x-tenant-id') projectId: string, @Query('asOf') asOf: string) {
    return this.reports.receivables(projectId, new Date(asOf));
  }
}
