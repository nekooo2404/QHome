import { Kafka } from 'kafkajs';
import { PropertyKafkaProducer } from './outbox-relay';

export async function createPropertyKafkaProducer(): Promise<PropertyKafkaProducer> {
  const brokers = (process.env.PROPERTY_RESIDENT_KAFKA_BROKERS ?? '').split(',').map((value) => value.trim()).filter(Boolean);
  if (brokers.length < 3) throw new Error('PROPERTY_RESIDENT_KAFKA_BROKERS must contain at least three brokers');
  const kafka = new Kafka({
    clientId: process.env.PROPERTY_RESIDENT_KAFKA_CLIENT_ID ?? 'property-resident-service',
    brokers,
    ssl: process.env.PROPERTY_RESIDENT_KAFKA_TLS === 'true',
    sasl: process.env.PROPERTY_RESIDENT_KAFKA_USERNAME && process.env.PROPERTY_RESIDENT_KAFKA_PASSWORD
      ? { mechanism: 'scram-sha-512', username: process.env.PROPERTY_RESIDENT_KAFKA_USERNAME, password: process.env.PROPERTY_RESIDENT_KAFKA_PASSWORD }
      : undefined,
  });
  const producer = kafka.producer({ idempotent: true, maxInFlightRequests: 5 });
  await producer.connect();
  return { send: (input) => producer.send({ topic: input.topic, messages: input.messages }) .then(() => undefined) };
}
