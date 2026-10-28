import { createHash } from 'node:crypto';
import { verifyWebhookHmac } from '../domain/webhook-security';
import { PaymentService } from './payment.service';

interface ProviderPaymentPayload {
  eventId: string;
  transactionId: string;
  projectId: string;
  apartmentId: string;
  residentId?: string;
  amount: string;
  currencyCode: string;
  reference?: string;
  occurredAt?: string;
}

export class PaymentWebhookService {
  constructor(private readonly payments: PaymentService, private readonly secrets: Record<string, string>) {}

  async handle(provider: string, rawBody: string, signature: string, timestamp: string): Promise<unknown> {
    const secret = this.secrets[provider];
    if (!secret) throw new Error('Unknown payment provider');
    verifyWebhookHmac(secret, { rawBody, signature, timestamp });
    const payload = JSON.parse(rawBody) as ProviderPaymentPayload;
    if (!payload.eventId || !payload.transactionId || !payload.projectId || !payload.apartmentId || !payload.amount || !payload.currencyCode) throw new Error('Payment webhook payload is incomplete');
    return this.payments.applyPayment({
      projectId: payload.projectId,
      apartmentId: payload.apartmentId,
      residentId: payload.residentId,
      provider,
      providerTransactionId: payload.transactionId,
      providerEventId: payload.eventId,
      idempotencyKey: provider + ':' + payload.eventId,
      channel: provider.toLowerCase().includes('wallet') ? 'E_WALLET' : 'BANK_TRANSFER',
      currencyCode: payload.currencyCode,
      grossAmount: payload.amount,
      rawReference: payload.reference,
      providerOccurredAt: payload.occurredAt ? new Date(payload.occurredAt) : undefined,
      webhookReceipt: { timestamp: new Date(Number(timestamp) * 1000), signature, payloadHash: createHash('sha256').update(rawBody).digest('hex') },
    });
  }
}
