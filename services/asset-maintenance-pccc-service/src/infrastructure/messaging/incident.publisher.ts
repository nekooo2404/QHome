import { randomUUID } from 'node:crypto';

export interface AssetKafkaProducer {
  send(input: { topic: string; key: string; value: Record<string, unknown> }): Promise<void>;
}

export class KafkaIncidentPublisher {
  constructor(private readonly producer: AssetKafkaProducer) {}

  publishHighPriorityIncident(input: { eventId: string; projectId: string; buildingId: string; assetId?: string; incidentType: string; sourceId: string; title: string; description: string; actorId: string; correlationId: string }): Promise<void> {
    return this.producer.send({ topic: 'qhome.workforce.high-priority-incidents.v1', key: input.sourceId, value: { ...input, eventId: input.eventId || randomUUID(), priority: 'HIGH_PRIORITY_INCIDENT' } });
  }
}
