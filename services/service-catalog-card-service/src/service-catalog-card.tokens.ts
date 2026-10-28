export const SERVICE_CATALOG_TOKENS = {
  Prisma: Symbol('SERVICE_CATALOG_PRISMA'),
  Repository: Symbol('SERVICE_CATALOG_REPOSITORY'),
  Producer: Symbol('SERVICE_CATALOG_KAFKA_PRODUCER'),
  RetryPublisher: Symbol('SERVICE_CATALOG_RETRY_PUBLISHER'),
  OutboxRelay: Symbol('SERVICE_CATALOG_OUTBOX_RELAY'),
} as const;
