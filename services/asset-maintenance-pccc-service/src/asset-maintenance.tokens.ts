export const ASSET_TOKENS = {
  Prisma: Symbol('ASSET_PRISMA'),
  Redis: Symbol('ASSET_REDIS'),
  Repository: Symbol('ASSET_REPOSITORY'),
  Producer: Symbol('ASSET_KAFKA_PRODUCER'),
  Lock: Symbol('ASSET_LOCK'),
  Cursor: Symbol('ASSET_CURSOR'),
  IncidentPublisher: Symbol('ASSET_INCIDENT_PUBLISHER'),
} as const;
