export const REGISTRATION_TOKENS = {
  Prisma: Symbol('REGISTRATION_PRISMA'),
  Redis: Symbol('REGISTRATION_REDIS'),
  Repository: Symbol('REGISTRATION_REPOSITORY'),
  Lock: Symbol('REGISTRATION_LOCK'),
  Queue: Symbol('REGISTRATION_QUEUE'),
  EventPublisher: Symbol('REGISTRATION_EVENT_PUBLISHER'),
} as const;
