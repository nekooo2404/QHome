import { Kafka } from 'kafkajs';
import { AssetKafkaProducer } from './incident.publisher';

export async function createAssetKafkaProducer(): Promise<AssetKafkaProducer> {
  const brokers = (process.env.ASSET_MAINTENANCE_KAFKA_BROKERS ?? '').split(',').map((value) => value.trim()).filter(Boolean);
  if (brokers.length < 3) throw new Error('ASSET_MAINTENANCE_KAFKA_BROKERS must contain at least three brokers');
  const kafka = new Kafka({ clientId: 'asset-maintenance-pccc-service', brokers, ssl: process.env.ASSET_MAINTENANCE_KAFKA_TLS === 'true' });
  const producer = kafka.producer({ idempotent: true, maxInFlightRequests: 5 });
  await producer.connect();
  return { send: (input) => producer.send({ topic: input.topic, messages: [{ key: input.key, value: JSON.stringify(input.value) }] }).then(() => undefined) };
}
