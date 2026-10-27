import {
  ArgumentsHost,
  CallHandler,
  Catch,
  ExceptionFilter,
  ExecutionContext,
  HttpException,
  Injectable,
  INestApplication,
  Logger,
  NestInterceptor,
  Type,
  ValidationPipe,
} from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { MicroserviceOptions, RpcException, Transport } from '@nestjs/microservices';
import { status, Metadata } from '@grpc/grpc-js';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';

export interface ReadinessCheck {
  name: string;
  timeoutMs?: number;
  check: () => Promise<void>;
}

export interface GrpcTransportOptions {
  package: string | string[];
  protoPath: string | string[];
  url: string;
}

export interface BaseMicroserviceOptions {
  module: Type<unknown>;
  serviceName: string;
  serviceVersion?: string;
  environment?: string;
  httpPort: number;
  grpc?: GrpcTransportOptions;
  readinessChecks?: ReadinessCheck[];
  otlpEndpoint?: string;
  shutdownTimeoutMs?: number;
}

export interface RequestContextValue {
  correlationId: string;
  tenantId: string;
  apartmentId?: string;
  actorId?: string;
  subject?: string;
  clientType?: string;
}

type ContextRequest = {
  headers: Record<string, string | string[] | undefined>;
  qhomeContext?: RequestContextValue;
  originalUrl?: string;
  url?: string;
};

type GrpcCall = {
  metadata?: Metadata;
};

type NormalizedError = {
  statusCode: number;
  code: string;
  message: string;
  details?: unknown;
};

function headerValue(request: ContextRequest, name: string): string | undefined {
  const raw = request.headers[name.toLowerCase()];
  if (Array.isArray(raw)) {
    return raw.length === 1 ? raw[0] : undefined;
  }
  return raw;
}

function validHeader(value: string | undefined): value is string {
  return Boolean(value && value.length <= 256 && !/[\r\n]/u.test(value));
}

function optionalHeader(request: ContextRequest, name: string): string | undefined {
  const value = headerValue(request, name);
  if (value !== undefined && !validHeader(value)) {
    throw new HttpException(`invalid ${name} header`, 400);
  }
  return value;
}

function metadataValue(metadata: Metadata, name: string): string | undefined {
  const values = metadata.get(name);
  if (values.length !== 1) {
    return undefined;
  }
  const value = values[0];
  return Buffer.isBuffer(value) ? value.toString('utf8') : String(value);
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('readiness check timed out')), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function grpcStatus(httpStatus: number): status {
  switch (httpStatus) {
    case 400:
      return status.INVALID_ARGUMENT;
    case 401:
      return status.UNAUTHENTICATED;
    case 403:
      return status.PERMISSION_DENIED;
    case 404:
      return status.NOT_FOUND;
    case 409:
      return status.ALREADY_EXISTS;
    case 429:
      return status.RESOURCE_EXHAUSTED;
    case 503:
      return status.UNAVAILABLE;
    default:
      return status.INTERNAL;
  }
}

function normalizeException(exception: unknown): NormalizedError {
  if (exception instanceof HttpException) {
    const response = exception.getResponse();
    const responseObject = typeof response === 'object' && response !== null ? response as Record<string, unknown> : undefined;
    const rawMessage = responseObject?.message ?? response;
    const statusCode = exception.getStatus();
    return {
      statusCode,
      code: statusCode >= 500 ? 'INTERNAL_ERROR' : typeof responseObject?.code === 'string' ? responseObject.code : 'HTTP_ERROR',
      message: statusCode >= 500 ? 'Internal server error' : Array.isArray(rawMessage) ? rawMessage.join('; ') : String(rawMessage),
      details: statusCode < 500 ? responseObject?.details : undefined,
    };
  }

  if (typeof exception === 'object' && exception !== null) {
    const value = exception as Record<string, unknown>;
    const statusCode = typeof value.statusCode === 'number' ? value.statusCode : 500;
    const code = typeof value.code === 'string' ? value.code : 'INTERNAL_ERROR';
    return {
      statusCode,
      code,
      message: statusCode >= 500 ? 'Internal server error' : String(value.message ?? 'Request failed'),
      details: statusCode < 500 ? value.details : undefined,
    };
  }

  return {
    statusCode: 500,
    code: 'INTERNAL_ERROR',
    message: 'Internal server error',
  };
}

function correlationIdFromHost(host: ArgumentsHost): string | undefined {
  if (host.getType() === 'http') {
    return (host.switchToHttp().getRequest<ContextRequest>().qhomeContext?.correlationId);
  }

  if (host.getType() === 'rpc') {
    const call = host.switchToRpc().getContext<GrpcCall>();
    return call?.metadata ? metadataValue(call.metadata, 'x-correlation-id') : undefined;
  }

  return undefined;
}

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter<unknown> {
  private readonly logger = new Logger(GlobalExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    if (host.getType() === 'rpc') {
      if (exception instanceof RpcException) {
        throw exception;
      }

      const normalized = normalizeException(exception);
      const correlationId = correlationIdFromHost(host);
      if (normalized.statusCode >= 500) {
        this.logger.error(`${normalized.code} correlationId=${correlationId ?? 'unknown'}`, exception instanceof Error ? exception.stack : undefined);
      }
      throw new RpcException({
        code: grpcStatus(normalized.statusCode),
        message: normalized.message,
        details: JSON.stringify({
          code: normalized.code,
          correlationId,
          details: normalized.details,
        }),
      });
    }

    if (host.getType() !== 'http') {
      this.logger.error(exception);
      return;
    }

    const response = host.switchToHttp().getResponse<{ header: (name: string, value: string) => void; status: (code: number) => { json: (body: unknown) => void } }>();
    const normalized = normalizeException(exception);
    const correlationId = correlationIdFromHost(host);
    if (normalized.statusCode >= 500) {
      this.logger.error(`${normalized.code} correlationId=${correlationId ?? 'unknown'}`, exception instanceof Error ? exception.stack : undefined);
    }
    if (correlationId) {
      response.header('x-correlation-id', correlationId);
    }
    response.status(normalized.statusCode).json({
      error: {
        code: normalized.code,
        message: normalized.message,
        correlationId,
        details: normalized.details,
      },
    });
  }
}

@Injectable()
export class GrpcContextInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler) {
    if (context.getType() !== 'rpc') {
      return next.handle();
    }

    const call = context.switchToRpc().getContext<GrpcCall>();
    const metadata = call?.metadata;
    const correlationId = metadata ? metadataValue(metadata, 'x-correlation-id') : undefined;
    const tenantId = metadata ? metadataValue(metadata, 'x-tenant-id') : undefined;
    if (!validHeader(correlationId) || !validHeader(tenantId)) {
      throw new RpcException({
        code: status.INVALID_ARGUMENT,
        message: 'x-correlation-id and x-tenant-id metadata are required',
      });
    }

    return next.handle();
  }
}

export function getRequestContext(request: ContextRequest): RequestContextValue {
  if (!request.qhomeContext) {
    throw new Error('request context is not initialized');
  }
  return request.qhomeContext;
}

export function requireApartmentId(request: ContextRequest): string {
  const apartmentId = getRequestContext(request).apartmentId;
  if (!apartmentId) {
    throw new HttpException('x-apartment-id is required for resident operations', 400);
  }
  return apartmentId;
}

export class BaseMicroservice {
  static async bootstrap(options: BaseMicroserviceOptions): Promise<INestApplication> {
    const logger = new Logger(options.serviceName);
    const telemetry = new NodeSDK({
      resource: resourceFromAttributes({
        'service.name': options.serviceName,
        'service.version': options.serviceVersion ?? '0.0.0',
        'deployment.environment': options.environment ?? process.env.NODE_ENV ?? 'production',
      }),
      traceExporter: options.otlpEndpoint
        ? new OTLPTraceExporter({ url: options.otlpEndpoint })
        : new OTLPTraceExporter(),
      instrumentations: [getNodeAutoInstrumentations()],
    });

    await telemetry.start();

    let app: INestApplication | undefined;
    try {
      app = await NestFactory.create(options.module, { bufferLogs: true });
      app.useLogger(logger);
      app.useGlobalPipes(new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
        transformOptions: { enableImplicitConversion: false },
      }));
      app.useGlobalFilters(new GlobalExceptionFilter());
      app.useGlobalInterceptors(new GrpcContextInterceptor());

      const httpAdapter = app.getHttpAdapter();
      httpAdapter.use((request: ContextRequest, response: unknown, next: () => void) => {
        const path = (request.originalUrl ?? request.url ?? '').split('?')[0];
        if (path === '/health/live' || path === '/health/ready') {
          next();
          return;
        }

        const correlationId = headerValue(request, 'x-correlation-id');
        const tenantId = headerValue(request, 'x-tenant-id');
        if (!validHeader(correlationId) || !validHeader(tenantId)) {
          httpAdapter.reply(response, {
            error: {
              code: 'REQUEST_CONTEXT_REQUIRED',
              message: 'x-correlation-id and x-tenant-id are required',
            },
          }, 400);
          return;
        }

        try {
          request.qhomeContext = {
            correlationId,
            tenantId,
            apartmentId: optionalHeader(request, 'x-apartment-id'),
            actorId: optionalHeader(request, 'x-actor-id'),
            subject: optionalHeader(request, 'x-subject'),
            clientType: optionalHeader(request, 'x-client-type'),
          };
          next();
        } catch (exception: unknown) {
          const normalized = normalizeException(exception);
          httpAdapter.reply(response, {
            error: {
              code: normalized.code,
              message: normalized.message,
            },
          }, normalized.statusCode);
        }
      });

      httpAdapter.get('/health/live', (_request: unknown, response: unknown) => {
        httpAdapter.reply(response, {
          status: 'alive',
          service: options.serviceName,
          timestamp: new Date().toISOString(),
        }, 200);
      });

      httpAdapter.get('/health/ready', async (_request: unknown, response: unknown) => {
        const checks = await Promise.all((options.readinessChecks ?? []).map(async (readinessCheck) => {
          try {
            await withTimeout(readinessCheck.check(), readinessCheck.timeoutMs ?? 2000);
            return { name: readinessCheck.name, status: 'up' };
          } catch (error: unknown) {
            logger.error(`readiness check failed: ${readinessCheck.name}`, error instanceof Error ? error.stack : undefined);
            return { name: readinessCheck.name, status: 'down' };
          }
        }));
        const ready = checks.every((check) => check.status === 'up');
        httpAdapter.reply(response, {
          status: ready ? 'ready' : 'not_ready',
          service: options.serviceName,
          checks,
          timestamp: new Date().toISOString(),
        }, ready ? 200 : 503);
      });

      if (options.grpc) {
        app.connectMicroservice<MicroserviceOptions>({
          transport: Transport.GRPC,
          options: {
            package: options.grpc.package,
            protoPath: options.grpc.protoPath,
            url: options.grpc.url,
            loader: {
              keepCase: false,
              longs: String,
              enums: String,
              defaults: true,
              oneofs: true,
            },
          },
        }, { inheritAppConfig: true });
        await app.startAllMicroservices();
      }

      await app.listen(options.httpPort, '0.0.0.0');

      let shuttingDown = false;
      const shutdown = async (signal: string) => {
        if (shuttingDown) {
          return;
        }
        shuttingDown = true;
        logger.log(`received ${signal}; starting graceful shutdown`);
        try {
          await withTimeout(app!.close(), options.shutdownTimeoutMs ?? 10000);
        } finally {
          await withTimeout(telemetry.shutdown(), options.shutdownTimeoutMs ?? 10000);
        }
      };
      process.once('SIGTERM', () => void shutdown('SIGTERM'));
      process.once('SIGINT', () => void shutdown('SIGINT'));

      logger.log(`listening on HTTP ${options.httpPort}${options.grpc ? ` and gRPC ${options.grpc.url}` : ''}`);
      return app;
    } catch (error: unknown) {
      if (app) {
        await app.close().catch(() => undefined);
      }
      await telemetry.shutdown().catch(() => undefined);
      throw error;
    }
  }
}
