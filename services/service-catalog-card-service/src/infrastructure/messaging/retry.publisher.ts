export interface CardKafkaProducer {
  send(input: { topic: string; key: string; value: Record<string, unknown>; headers?: Record<string, string> }): Promise<void>;
}

export class CardRetryPublisher {
  constructor(
    private readonly producer: CardKafkaProducer,
    private readonly retryTopic = 'qhome.service-catalog.card-debt-retry.v1',
    private readonly dlqTopic = 'qhome.service-catalog.card-debt-dlq.v1',
  ) {}

  publishRetry(input: { eventId: string; eventType: string; payload: Record<string, unknown>; attempt: number; availableAt: Date }): Promise<void> {
    return this.producer.send({ topic: this.retryTopic, key: input.eventId, value: { ...input.payload, eventId: input.eventId, eventType: input.eventType, attempt: input.attempt, availableAt: input.availableAt.toISOString() } });
  }

  publishDlq(input: { eventId: string; eventType: string; payload: Record<string, unknown>; attempts: number; error: string }): Promise<void> {
    return this.producer.send({ topic: this.dlqTopic, key: input.eventId, value: { ...input.payload, eventId: input.eventId, eventType: input.eventType, attempts: input.attempts, error: input.error } });
  }
}
