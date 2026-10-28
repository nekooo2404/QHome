import { Kafka } from 'kafkajs';
import { BillingKafkaProducer } from './billing.outbox.relay';

export async function createBillingKafkaProducer(): Promise<BillingKafkaProducer> {
  const brokers = (process.env.BILLING_FINANCE_KAFKA_BROKERS ?? '').split(',').map((value) => value.trim()).filter(Boolean);
  if (brokers.length < 3) throw new Error('BILLING_FINANCE_KAFKA_BROKERS must contain at least three brokers');
  const kafka = new Kafka({ clientId: process.env.BILLING_FINANCE_KAFKA_CLIENT_ID ?? 'billing-finance-service', brokers, ssl: process.env.BILLING_FINANCE_KAFKA_TLS === 'true' });
  const producer = kafka.producer({ idempotent: true, maxInFlightRequests: 5 });
  await producer.connect();
  return { send: (input) => producer.send({ topic: input.topic, messages: [{ key: input.key, value: JSON.stringify(input.value) }] }).then(() => undefined) };
}
