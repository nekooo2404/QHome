import { Module } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { AmenityBookingService } from './application/booking.service';
import { RegistrationService } from './application/registration.service';
import { ResidentRegistrationHttpController } from './interfaces/http/resident-registration.http.controller';
import { PrismaRegistrationRepository } from './infrastructure/prisma/prisma.registration.repository';
import { RedisRedlock } from './infrastructure/redis/redis.lock';
import { BullMqDelayedQueue } from './infrastructure/queue/bullmq.adapter';
import { SecurityQrPassService } from './domain/qr-pass';
import { REGISTRATION_TOKENS } from './registration.tokens';
import { createRegistrationRedis } from './infrastructure/redis/redis.client';

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(name + ' is required');
  return value;
}

@Module({
  controllers: [ResidentRegistrationHttpController],
  providers: [
    { provide: REGISTRATION_TOKENS.Prisma, useFactory: () => new PrismaClient({ datasources: { db: { url: requiredEnv('RESIDENT_REGISTRATION_DATABASE_URL') } } }) },
    { provide: REGISTRATION_TOKENS.Redis, useFactory: createRegistrationRedis },
    { provide: REGISTRATION_TOKENS.Repository, useFactory: (prisma: PrismaClient) => new PrismaRegistrationRepository(prisma), inject: [REGISTRATION_TOKENS.Prisma] },
    { provide: REGISTRATION_TOKENS.Lock, useFactory: (redis) => new RedisRedlock(redis), inject: [REGISTRATION_TOKENS.Redis] },
    { provide: REGISTRATION_TOKENS.Queue, useFactory: () => new BullMqDelayedQueue({ host: requiredEnv('RESIDENT_REGISTRATION_REDIS_HOST'), port: Number(process.env.RESIDENT_REGISTRATION_REDIS_PORT ?? 6379), password: process.env.RESIDENT_REGISTRATION_REDIS_PASSWORD }) },
    { provide: SecurityQrPassService, useFactory: () => new SecurityQrPassService(requiredEnv('SECURITY_PASS_HMAC_SECRET')) },
    { provide: AmenityBookingService, useFactory: (repository, lock, queue) => new AmenityBookingService(repository, lock, queue), inject: [REGISTRATION_TOKENS.Repository, REGISTRATION_TOKENS.Lock, REGISTRATION_TOKENS.Queue] },
    { provide: RegistrationService, useFactory: (repository, passes) => new RegistrationService(repository, passes, { publish: async () => undefined }), inject: [REGISTRATION_TOKENS.Repository, SecurityQrPassService] },
  ],
})
export class ResidentRegistrationModule {}
