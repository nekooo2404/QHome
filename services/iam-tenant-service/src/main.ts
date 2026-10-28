import { BaseMicroservice } from '../../../libs/common/src/base-microservice';
import { IamTenantModule } from './iam-tenant.module';

void BaseMicroservice.bootstrap({
  module: IamTenantModule,
  serviceName: 'iam-tenant-service',
  serviceVersion: process.env.SERVICE_VERSION ?? '0.1.0',
  environment: process.env.NODE_ENV ?? 'production',
  httpPort: Number(process.env.IAM_HTTP_PORT ?? 3001),
  grpc: {
    package: 'qhome.iam.tenant.v1',
    protoPath: '../../../proto/iam_tenant.proto',
    url: process.env.IAM_GRPC_URL ?? '0.0.0.0:50051',
    includeDirs: ['../../../proto'],
  },
  publicPaths: ['/.well-known/jwks.json'],
  otlpEndpoint: process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT,
  verifyRequestContext: (context, transport, proof) => {
    if (!proof || proof.length < 32) throw new Error(`authenticated context proof is required for ${transport}`);
    if (!context.tenantId || !context.correlationId) throw new Error('authenticated tenant and correlation context are required');
  },
}).catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
