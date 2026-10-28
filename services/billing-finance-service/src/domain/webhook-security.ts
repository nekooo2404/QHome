import { createHmac, timingSafeEqual } from 'node:crypto';

export interface WebhookVerificationInput {
  rawBody: string | Buffer;
  signature: string;
  timestamp: string;
  nowMs?: number;
  maxAgeMs?: number;
}

export function verifyWebhookHmac(secret: string, input: WebhookVerificationInput): void {
  if (!secret || !input.signature || !/^\d+$/u.test(input.timestamp)) throw new Error('Webhook signature metadata is invalid');
  const timestampMs = Number(input.timestamp) * 1000;
  const nowMs = input.nowMs ?? Date.now();
  const maxAgeMs = input.maxAgeMs ?? 300_000;
  if (!Number.isSafeInteger(timestampMs) || Math.abs(nowMs - timestampMs) > maxAgeMs) throw new Error('Webhook timestamp is outside replay window');
  const signedPayload = `${input.timestamp}.${typeof input.rawBody === 'string' ? input.rawBody : input.rawBody.toString('utf8')}`;
  const expected = createHmac('sha256', secret).update(signedPayload).digest('hex');
  const provided = input.signature.replace(/^sha256=/u, '').toLowerCase();
  const expectedBuffer = Buffer.from(expected, 'hex');
  const providedBuffer = Buffer.from(provided, 'hex');
  if (expectedBuffer.length !== providedBuffer.length || !timingSafeEqual(expectedBuffer, providedBuffer)) throw new Error('Webhook signature is invalid');
}
