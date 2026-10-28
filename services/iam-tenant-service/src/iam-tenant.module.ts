import { Module } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { AuthenticationService } from './application/authentication.service';
import { AuthorizationService } from './application/authorization.service';
import { IamTenantGrpcController } from './interfaces/grpc/iam-tenant.grpc.controller';
import { IamTenantHttpController } from './interfaces/http/iam-tenant.http.controller';
import { IAM_TOKENS } from './iam-tenant.tokens';
import { PrismaIamRepository } from './infrastructure/prisma/prisma-iam.repository';
import { Argon2idPasswordHasher } from './infrastructure/security/argon2-password.hasher';
import { HmacSha256TokenHasher, RandomOpaqueTokenGenerator, SystemClock, UuidGenerator } from './infrastructure/security/token-primitives';
import { RedisAuthorizationVersionStore, RedisPermissionCache, RedisSlidingWindowRateLimiter } from './infrastructure/security/redis-security';
import { createRedisClusterClient } from './infrastructure/messaging/redis-cluster.client';
import { createKafkaProducer } from './infrastructure/messaging/kafka.client';
import { KafkaOutboxRelay } from './infrastructure/messaging/outbox-relay';
import { Rs256JwtSigner } from './infrastructure/security/rs256-jwt.signer';

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function pemEnv(name: string): string {
  return requiredEnv(name).replace(/\\n/gu, '\n');
}

@Module({
  controllers: [IamTenantHttpController, IamTenantGrpcController],
  providers: [
    {
      provide: IAM_TOKENS.Prisma,
      useFactory: () => new PrismaClient({ datasources: { db: { url: requiredEnv('IAM_DATABASE_URL') } } }),
    },
    { provide: IAM_TOKENS.Redis, useFactory: createRedisClusterClient },
    { provide: IAM_TOKENS.AuthRepository, useFactory: (prisma: PrismaClient) => new PrismaIamRepository(prisma), inject: [IAM_TOKENS.Prisma] },
    { provide: IAM_TOKENS.PasswordHasher, useClass: Argon2idPasswordHasher },
    { provide: IAM_TOKENS.TokenHasher, useFactory: () => new HmacSha256TokenHasher(requiredEnv('IAM_TOKEN_PEPPER')) },
    {
      provide: IAM_TOKENS.AccessTokenSigner,
      useFactory: () => new Rs256JwtSigner({
        privateKeyPem: pemEnv('IAM_JWT_PRIVATE_KEY_PEM'),
        publicKeyPem: pemEnv('IAM_JWT_PUBLIC_KEY_PEM'),
        keyId: requiredEnv('IAM_JWT_KEY_ID'),
        issuer: requiredEnv('IAM_JWT_ISSUER'),
        audience: requiredEnv('IAM_JWT_AUDIENCE'),
        accessTokenExpiresInSeconds: Number(process.env.IAM_ACCESS_TOKEN_TTL_SECONDS ?? 600),
      }),
    },
    { provide: IAM_TOKENS.JwksProvider, useExisting: IAM_TOKENS.AccessTokenSigner },
    { provide: IAM_TOKENS.RefreshTokenGenerator, useClass: RandomOpaqueTokenGenerator },
    {
      provide: IAM_TOKENS.RateLimiter,
      useFactory: (redis: ReturnType<typeof createRedisClusterClient>) => new RedisSlidingWindowRateLimiter(redis, requiredEnv('IAM_RATE_LIMIT_PEPPER')),
      inject: [IAM_TOKENS.Redis],
    },
    { provide: IAM_TOKENS.PermissionCache, useFactory: (redis: ReturnType<typeof createRedisClusterClient>) => new RedisPermissionCache(redis), inject: [IAM_TOKENS.Redis] },
    { provide: IAM_TOKENS.IdGenerator, useClass: UuidGenerator },
    { provide: IAM_TOKENS.Clock, useClass: SystemClock },
    { provide: IAM_TOKENS.KafkaProducer, useFactory: createKafkaProducer },
    { provide: IAM_TOKENS.OutboxRelay, useFactory: (prisma: PrismaClient, producer: Awaited<ReturnType<typeof createKafkaProducer>>) => new KafkaOutboxRelay(prisma, producer), inject: [IAM_TOKENS.Prisma, IAM_TOKENS.KafkaProducer] },
    {
      provide: AuthenticationService,
      useFactory: (repository, passwordHasher, tokenHasher, signer, refreshGenerator, rateLimiter, clock, ids) => new AuthenticationService(
        repository,
        passwordHasher,
        tokenHasher,
        signer,
        refreshGenerator,
        rateLimiter,
        clock,
        ids,
        {
          accessTokenExpiresInSeconds: Number(process.env.IAM_ACCESS_TOKEN_TTL_SECONDS ?? 600),
          refreshTokenTtlMs: Number(process.env.IAM_REFRESH_TOKEN_TTL_MS ?? 30 * 24 * 60 * 60 * 1000),
          lockThreshold: Number(process.env.IAM_LOGIN_LOCK_THRESHOLD ?? 8),
          lockDurationMs: Number(process.env.IAM_LOGIN_LOCK_DURATION_MS ?? 15 * 60 * 1000),
          dummyPasswordHash: requiredEnv('IAM_DUMMY_PASSWORD_HASH'),
        },
      ),
      inject: [IAM_TOKENS.AuthRepository, IAM_TOKENS.PasswordHasher, IAM_TOKENS.TokenHasher, IAM_TOKENS.AccessTokenSigner, IAM_TOKENS.RefreshTokenGenerator, IAM_TOKENS.RateLimiter, IAM_TOKENS.Clock, IAM_TOKENS.IdGenerator],
    },
    {
      provide: AuthorizationService,
      useFactory: (repository, cache, ids) => new AuthorizationService(repository, cache, ids, Number(process.env.IAM_PERMISSION_CACHE_TTL_SECONDS ?? 60)),
      inject: [IAM_TOKENS.AuthRepository, IAM_TOKENS.PermissionCache, IAM_TOKENS.IdGenerator],
    },
  ],
})
export class IamTenantModule {}
