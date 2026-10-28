export const DOCUMENT_DMS_TOKENS = {
  Prisma: Symbol('DOCUMENT_DMS_PRISMA'),
  Redis: Symbol('DOCUMENT_DMS_REDIS'),
  AccessCache: Symbol('DOCUMENT_DMS_ACCESS_CACHE'),
  Repository: Symbol('DOCUMENT_DMS_REPOSITORY'),
  Storage: Symbol('DOCUMENT_DMS_STORAGE'),
  IamGrpcClient: Symbol('DOCUMENT_DMS_IAM_GRPC_CLIENT'),
  IamAuthorization: Symbol('DOCUMENT_DMS_IAM_AUTHORIZATION'),
  KafkaProducer: Symbol('DOCUMENT_DMS_KAFKA_PRODUCER'),
  OutboxRelay: Symbol('DOCUMENT_DMS_OUTBOX_RELAY'),
} as const;
