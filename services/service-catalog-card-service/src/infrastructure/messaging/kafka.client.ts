import { Kafka } from 'kafkajs';
import { CardKafkaProducer } from './retry.publisher';

export async function createCardKafkaProducer(): Promise<CardKafkaProducer> {
  const brokers = (process.env.SERVICE_CATALOG_KAFKA_BROKERS ?? '').split(',').map((value) => value.trim()).filter(Boolean);
  if (brokers.length < 3) throw new Error('SERVICE_CATALOG_KAFKA_BROKERS must contain at least three brokers');
  const kafka = new Kafka({
    clientId: process.env.SERVICE_CATALOG_KAFKA_CLIENT_ID ?? 'service-catalog-card-service',
    brokers,
    ssl: process.env.SERVICE_CATALOG_KAFKA_TLS === 'true',
    sasl: process.env.SERVICE_CATALOG_KAFKA_USERNAME && process.env.SERVICE_CATALOG_KAFKA_PASSWORD
      ? { mechanism: 'scram-sha-512', username: process.env.SERVICE_CATALOG_KAFKA_USERNAME, password: process.env.SERVICE_CATALOG_KAFKA_PASSWORD }
      : undefined,
  });
  const producer = kafka.producer({ idempotent: true, maxInFlightRequests: 5 });
  await producer.connect();
  return { send: (input) => producer.send({ topic: input.topic, messages: [{ key: input.key, value: JSON.stringify(input.value), headers: input.headers }] }).then(() => undefined) };
}
