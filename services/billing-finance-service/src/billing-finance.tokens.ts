export const BILLING_TOKENS = {
  Prisma: Symbol('BILLING_PRISMA'),
  Redis: Symbol('BILLING_REDIS'),
  Repository: Symbol('BILLING_REPOSITORY'),
  Idempotency: Symbol('BILLING_IDEMPOTENCY'),
  PricingClient: Symbol('BILLING_PRICING_CLIENT'),
  ApartmentClient: Symbol('BILLING_APARTMENT_CLIENT'),
  Queue: Symbol('BILLING_QUEUE'),
  KafkaProducer: Symbol('BILLING_KAFKA_PRODUCER'),
  OutboxRelay: Symbol('BILLING_OUTBOX_RELAY'),
} as const;
