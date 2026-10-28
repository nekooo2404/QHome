import { Kafka } from 'kafkajs';
import { KafkaProducer } from './outbox-relay';

export async function createKafkaProducer(): Promise<KafkaProducer> {
  const brokers = (process.env.IAM_KAFKA_BROKERS ?? '').split(',').map((value) => value.trim()).filter(Boolean);
  if (brokers.length < 3) throw new Error('IAM_KAFKA_BROKERS must contain at least three brokers');
  const kafka = new Kafka({
    clientId: process.env.IAM_KAFKA_CLIENT_ID ?? 'iam-tenant-service',
    brokers,
    ssl: process.env.IAM_KAFKA_TLS === 'true',
    sasl: process.env.IAM_KAFKA_USERNAME && process.env.IAM_KAFKA_PASSWORD
      ? { mechanism: 'scram-sha-512', username: process.env.IAM_KAFKA_USERNAME, password: process.env.IAM_KAFKA_PASSWORD }
      : undefined,
  });
  const producer = kafka.producer({ idempotent: true, maxInFlightRequests: 5, transactionalId: process.env.IAM_KAFKA_TRANSACTIONAL_ID });
  await producer.connect();
  return {
    async send(input) {
      await producer.send({
        topic: input.topic,
        messages: input.messages.map((message) => ({
          key: message.key,
          value: message.value,
          headers: message.headers,
        })),
      });
    },
  };
}
