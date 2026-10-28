import { Module } from '@nestjs/common';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { PrismaClient } from '@prisma/client';
import { DocumentAccessService } from './application/document-access.service';
import { DocumentService } from './application/document.service';
import { DocumentHttpController } from './interfaces/http/document.http.controller';
import { DOCUMENT_DMS_TOKENS } from './document-dms.tokens';
import { DocumentPrismaClient, PrismaDocumentRepository } from './infrastructure/prisma/prisma.document.repository';
import { createDocumentRedis, RedisDocumentAccessCache } from './infrastructure/redis/redis.document-cache';
import { S3ObjectStorage } from './infrastructure/storage/s3.storage';
import { GrpcIamAuthorizationClient } from './infrastructure/iam/grpc-iam.authorization.client';
import { createDocumentKafkaProducer, DocumentOutboxRelay, DocumentOutboxScheduler } from './infrastructure/messaging/document.kafka';

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

@Module({
  imports: [ClientsModule.register([{
    name: DOCUMENT_DMS_TOKENS.IamGrpcClient,
    transport: Transport.GRPC,
    options: {
      package: 'qhome.iam.tenant.v1',
      protoPath: '../../../proto/iam_tenant.proto',
      url: process.env.IAM_GRPC_URL ?? 'iam-tenant-service:50051',
      includeDirs: ['../../../proto'],
      loader: { keepCase: false, longs: String, enums: String, defaults: true, oneofs: true },
    },
  }])],
  controllers: [DocumentHttpController],
  providers: [
    { provide: DOCUMENT_DMS_TOKENS.Prisma, useFactory: () => new DocumentPrismaClient({ datasources: { db: { url: requiredEnv('DOCUMENT_DMS_DATABASE_URL') } } }) },
    { provide: DOCUMENT_DMS_TOKENS.Redis, useFactory: createDocumentRedis },
    { provide: DOCUMENT_DMS_TOKENS.AccessCache, useFactory: (redis) => new RedisDocumentAccessCache(redis), inject: [DOCUMENT_DMS_TOKENS.Redis] },
    { provide: DOCUMENT_DMS_TOKENS.Repository, useFactory: (prisma: PrismaClient) => new PrismaDocumentRepository(prisma), inject: [DOCUMENT_DMS_TOKENS.Prisma] },
    { provide: DOCUMENT_DMS_TOKENS.Storage, useClass: S3ObjectStorage },
    { provide: DOCUMENT_DMS_TOKENS.IamAuthorization, useFactory: (client) => new GrpcIamAuthorizationClient(client), inject: [DOCUMENT_DMS_TOKENS.IamGrpcClient] },
    { provide: DocumentAccessService, useFactory: (repository, iam, cache) => new DocumentAccessService(repository, iam, cache), inject: [DOCUMENT_DMS_TOKENS.Repository, DOCUMENT_DMS_TOKENS.IamAuthorization, DOCUMENT_DMS_TOKENS.AccessCache] },
    { provide: DocumentService, useFactory: (repository, storage, access) => new DocumentService(repository, storage, access), inject: [DOCUMENT_DMS_TOKENS.Repository, DOCUMENT_DMS_TOKENS.Storage, DocumentAccessService] },
    { provide: DOCUMENT_DMS_TOKENS.KafkaProducer, useFactory: createDocumentKafkaProducer },
    { provide: DOCUMENT_DMS_TOKENS.OutboxRelay, useFactory: (prisma: PrismaClient, producer) => new DocumentOutboxRelay(prisma, producer), inject: [DOCUMENT_DMS_TOKENS.Prisma, DOCUMENT_DMS_TOKENS.KafkaProducer] },
    { provide: DocumentOutboxRelay, useExisting: DOCUMENT_DMS_TOKENS.OutboxRelay },
    DocumentOutboxScheduler,
  ],
})
export class DocumentDmsModule {}
