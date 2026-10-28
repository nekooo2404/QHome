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
import type { MicroserviceOptions } from '@nestjs/microservices';
import type { Metadata } from '@grpc/grpc-js';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';

type RpcExceptionConstructor = new (error: string | Record<string, unknown>) => Error;
type GrpcStatusCodes = typeof import('@grpc/grpc-js').status;

let rpcExceptionConstructor: RpcExceptionConstructor | undefined;
let grpcStatusCodes: GrpcStatusCodes | undefined;

function throwRpcException(error: string | Record<string, unknown>): never {
  const Constructor = rpcExceptionConstructor;
  if (!Constructor) {
    throw new Error('NestJS microservice runtime is not initialized');
  }
  throw new Constructor(error);
}

function getGrpcStatusCodes(): GrpcStatusCodes {
  if (!grpcStatusCodes) {
    throw new Error('gRPC runtime is not initialized');
  }
  return grpcStatusCodes;
}

export interface ReadinessCheck {
  name: string;
  timeoutMs?: number;
  check: (signal: AbortSignal) => Promise<void>;
}

export interface GrpcTransportOptions {
  package: string | string[];
  protoPath: string | string[];
  url: string;
  includeDirs?: string[];
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
  verifyRequestContext?: RequestContextVerifier;
  publicPaths?: string[];
  rawBody?: boolean;
}

export interface RequestContextValue {
  correlationId: string;
  tenantId: string;
  apartmentId?: string;
  actorId?: string;
  subject?: string;
  clientType?: string;
  traceparent?: string;
  tracestate?: string;
  scopes?: string[];
  contextProof?: string;
}

export type RequestTransport = 'http' | 'grpc';
export type RequestContextVerifier = (
  context: RequestContextValue,
  transport: RequestTransport,
  proof?: string,
) => void;

export type ContextRequest = {
  headers: Record<string, string | string[] | undefined>;
  qhomeContext?: RequestContextValue;
  originalUrl?: string;
  url?: string;
};

export type GrpcCall = {
  metadata?: Metadata;
  qhomeContext?: RequestContextValue;
};

type NormalizedError = {
  statusCode: number;
  code: string;
  message: string;
  details?: unknown;
};

type HttpResponse = {
  header: (name: string, value: string) => void;
  type?: (value: string) => void;
  status: (code: number) => { json: (body: unknown) => void };
};

type HeaderMap = Record<string, string>;
type ContextLike = Partial<Pick<RequestContextValue, 'correlationId' | 'tenantId' | 'apartmentId' | 'actorId' | 'subject' | 'clientType' | 'traceparent' | 'tracestate' | 'contextProof'>> & {
  scopes?: string[];
};

type CommandContextCarrier = {
  context?: ContextLike;
  metadata?: { context?: ContextLike };
};

function problemBody(normalized: NormalizedError, correlationId?: string): Record<string, unknown> {
  return {
    type: `https://qhome.example.com/problems/${normalized.code.toLowerCase()}`,
    title: normalized.code,
    status: normalized.statusCode,
    instance: correlationId ? `urn:qhome:correlation:${correlationId}` : undefined,
    error: {
      code: normalized.code,
      message: normalized.message,
      correlationId,
      details: normalized.details,
    },
  };
}

function rawHeaderValue(request: ContextRequest, name: string): string | string[] | undefined {
  const normalizedName = name.toLowerCase();
  const matchingEntries = Object.entries(request.headers)
    .filter(([key]) => key.toLowerCase() === normalizedName)
    .map(([, value]) => value)
    .filter((value): value is string | string[] => value !== undefined);
  if (matchingEntries.length === 0) {
    return undefined;
  }
  if (matchingEntries.length > 1) {
    return matchingEntries.flatMap((value) => Array.isArray(value) ? value : [value]);
  }
  return matchingEntries[0];
}

function headerValue(request: ContextRequest, name: string): string | undefined {
  const raw = rawHeaderValue(request, name);
  return Array.isArray(raw) ? (raw.length === 1 ? raw[0] : undefined) : raw;
}

function validHeader(value: string | undefined, maxLength = 256): value is string {
  return Boolean(value && value.length <= maxLength && value.trim() === value && !/[\u0000-\u001F\u007F]/u.test(value));
}

function optionalHeader(request: ContextRequest, name: string, maxLength = 256): string | undefined {
  const raw = rawHeaderValue(request, name);
  if (Array.isArray(raw) && raw.length !== 1) {
    throw new HttpException(`invalid ${name} header`, 400);
  }
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value !== undefined && !validHeader(value, maxLength)) {
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

function optionalMetadata(metadata: Metadata, name: string, maxLength = 256): string | undefined {
  const values = metadata.get(name);
  if (values.length > 1) {
    throwRpcException({ code: getGrpcStatusCodes().INVALID_ARGUMENT, message: `invalid ${name} metadata` });
  }
  if (values.length === 0) {
    return undefined;
  }
  const value = Buffer.isBuffer(values[0]) ? values[0].toString('utf8') : String(values[0]);
  if (!validHeader(value, maxLength)) {
    throwRpcException({ code: getGrpcStatusCodes().INVALID_ARGUMENT, message: `invalid ${name} metadata` });
  }
  return value;
}

function parseScopes(value: string | undefined): string[] | undefined {
  if (!value) {
    return undefined;
  }
  const scopes = value.split(/[ ,]+/u).filter(Boolean);
  return scopes.length > 0 ? scopes : undefined;
}

export function injectHttpContext(headers: HeaderMap, context: RequestContextValue): HeaderMap {
  const next = { ...headers };
  next['x-correlation-id'] = context.correlationId;
  next['x-tenant-id'] = context.tenantId;
  if (context.apartmentId) next['x-apartment-id'] = context.apartmentId;
  if (context.actorId) next['x-actor-id'] = context.actorId;
  if (context.subject) next['x-subject'] = context.subject;
  if (context.clientType) next['x-client-type'] = context.clientType;
  if (context.traceparent) next.traceparent = context.traceparent;
  if (context.tracestate) next.tracestate = context.tracestate;
  if (context.scopes?.length) next['x-scopes'] = context.scopes.join(' ');
  if (context.contextProof) next['x-qhome-context-proof'] = context.contextProof;
  return next;
}

export function injectKafkaHeaders(headers: Record<string, string | Buffer>, context: RequestContextValue): Record<string, string | Buffer> {
  return injectHttpContext(headers as HeaderMap, context);
}

export function injectGrpcMetadata(metadata: Metadata, context: RequestContextValue): void {
  for (const [key, value] of Object.entries(injectHttpContext({}, context))) {
    metadata.set(key, value);
  }
}

export function assertCommandContextMatches(commandContext: ContextLike | undefined, transportContext: RequestContextValue): void {
  if (!commandContext) {
    return;
  }
  const pairs: Array<[keyof ContextLike, string | undefined]> = [
    ['correlationId', transportContext.correlationId],
    ['tenantId', transportContext.tenantId],
    ['apartmentId', transportContext.apartmentId],
    ['actorId', transportContext.actorId],
    ['subject', transportContext.subject],
  ];
  for (const [key, expected] of pairs) {
    const provided = commandContext[key];
    if (provided !== undefined && provided !== expected) {
      throw new HttpException(`command context ${String(key)} does not match transport context`, 400);
    }
  }
}

interface TimedOperation<T> {
  result: Promise<T>;
  settled: Promise<void>;
}

function withTimeout<T>(operation: (signal: AbortSignal) => Promise<T>, timeoutMs: number): TimedOperation<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error('timeoutMs must be a positive finite number');
  }

  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const operationPromise = Promise.resolve().then(() => operation(controller.signal));
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort(new Error('readiness check timed out'));
      reject(new Error('readiness check timed out'));
    }, timeoutMs);
  });

  const settled = operationPromise.then(
    () => undefined,
    () => undefined,
  ).finally(() => {
    if (timer) {
      clearTimeout(timer);
    }
    controller.abort();
  });

  return {
    result: Promise.race([operationPromise, timeout]),
    settled,
  };
}

function grpcStatus(httpStatus: number): GrpcStatusCodes[keyof GrpcStatusCodes] {
  const codes = getGrpcStatusCodes();
  switch (httpStatus) {
    case 400:
      return codes.INVALID_ARGUMENT;
    case 408:
      return codes.DEADLINE_EXCEEDED;
    case 401:
      return codes.UNAUTHENTICATED;
    case 403:
      return codes.PERMISSION_DENIED;
    case 404:
      return codes.NOT_FOUND;
    case 409:
      return codes.ALREADY_EXISTS;
    case 412:
      return codes.FAILED_PRECONDITION;
    case 429:
      return codes.RESOURCE_EXHAUSTED;
    case 501:
      return codes.UNIMPLEMENTED;
    case 502:
    case 504:
    case 503:
      return codes.UNAVAILABLE;
    default:
      return codes.INTERNAL;
  }
}

function httpStatusFromGrpc(code: unknown): number {
  if (typeof code !== 'number') {
    return 500;
  }
  switch (code) {
    case 3: return 400;
    case 4: return 408;
    case 5: return 404;
    case 6: return 409;
    case 7: return 403;
    case 8: return 429;
    case 9: return 412;
    case 12: return 501;
    case 14: return 503;
    case 16: return 401;
    default: return 500;
  }
}

function normalizeException(exception: unknown): NormalizedError {
  if (exception instanceof HttpException) {
    const httpException = exception as HttpException;
    const response = httpException.getResponse();
    const responseObject = typeof response === 'object' && response !== null ? response as Record<string, unknown> : undefined;
    const rawMessage = responseObject?.message ?? response;
    const statusCode = httpException.getStatus();
    return {
      statusCode,
      code: statusCode >= 500 ? 'INTERNAL_ERROR' : typeof responseObject?.code === 'string' ? responseObject.code : 'HTTP_ERROR',
      message: statusCode >= 500 ? 'Internal server error' : Array.isArray(rawMessage) ? rawMessage.join('; ') : String(rawMessage),
      details: statusCode < 500 ? responseObject?.details : undefined,
    };
  }

  if (typeof exception === 'object' && exception !== null) {
    const value = exception as Record<string, unknown>;
    const rpcError = typeof value.getError === 'function'
      ? (value.getError as (this: object) => unknown).call(exception)
      : undefined;
    const rpcErrorObject = typeof rpcError === 'object' && rpcError !== null
      ? rpcError as Record<string, unknown>
      : undefined;
    if (rpcError !== undefined) {
      let rpcDetails: Record<string, unknown> | undefined;
      if (typeof rpcErrorObject?.details === 'string') {
        try {
          const parsed = JSON.parse(rpcErrorObject.details) as unknown;
          if (typeof parsed === 'object' && parsed !== null) {
            rpcDetails = parsed as Record<string, unknown>;
          }
        } catch {
          rpcDetails = undefined;
        }
      }
      return {
        statusCode: typeof rpcErrorObject?.statusCode === 'number'
          ? rpcErrorObject.statusCode
          : httpStatusFromGrpc(rpcErrorObject?.code),
        code: typeof rpcDetails?.code === 'string'
          ? rpcDetails.code
          : typeof rpcErrorObject?.code === 'string' ? rpcErrorObject.code : 'RPC_ERROR',
        message: typeof rpcDetails?.message === 'string'
          ? rpcDetails.message
          : typeof rpcErrorObject?.message === 'string'
          ? rpcErrorObject.message
          : typeof rpcError === 'string' ? rpcError : 'Request failed',
        details: rpcDetails?.details ?? rpcErrorObject?.details,
      };
    }
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
      const normalized = normalizeException(exception);
      const correlationId = correlationIdFromHost(host);
      if (normalized.statusCode >= 500) {
        this.logger.error(`${normalized.code} correlationId=${correlationId ?? 'unknown'}`, exception instanceof Error ? exception.stack : undefined);
      }
      throwRpcException({
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

    const response = host.switchToHttp().getResponse<HttpResponse>();
    const normalized = normalizeException(exception);
    const correlationId = correlationIdFromHost(host);
    if (normalized.statusCode >= 500) {
      this.logger.error(`${normalized.code} correlationId=${correlationId ?? 'unknown'}`, exception instanceof Error ? exception.stack : undefined);
    }
    if (correlationId) {
      response.header('x-correlation-id', correlationId);
    }
    response.type?.('application/problem+json');
    response.status(normalized.statusCode).json(problemBody(normalized, correlationId));
  }
}

@Injectable()
export class GrpcContextInterceptor implements NestInterceptor {
  constructor(private readonly verifyRequestContext?: RequestContextVerifier) {}

  intercept(context: ExecutionContext, next: CallHandler) {
    if (context.getType() !== 'rpc') {
      return next.handle();
    }

    const call = context.switchToRpc().getContext<GrpcCall>();
    const metadata = call?.metadata;
    const correlationId = metadata ? optionalMetadata(metadata, 'x-correlation-id') : undefined;
    const tenantId = metadata ? optionalMetadata(metadata, 'x-tenant-id') : undefined;
    if (!validHeader(correlationId) || !validHeader(tenantId)) {
      throwRpcException({
        code: getGrpcStatusCodes().INVALID_ARGUMENT,
        message: 'x-correlation-id and x-tenant-id metadata are required',
      });
    }

    const requestContext: RequestContextValue = {
      correlationId,
      tenantId,
      apartmentId: metadata ? optionalMetadata(metadata, 'x-apartment-id') : undefined,
      actorId: metadata ? optionalMetadata(metadata, 'x-actor-id') : undefined,
      subject: metadata ? optionalMetadata(metadata, 'x-subject') : undefined,
      clientType: metadata ? optionalMetadata(metadata, 'x-client-type') : undefined,
      traceparent: metadata ? optionalMetadata(metadata, 'traceparent') : undefined,
      tracestate: metadata ? optionalMetadata(metadata, 'tracestate') : undefined,
      scopes: metadata ? parseScopes(optionalMetadata(metadata, 'x-scopes')) : undefined,
      contextProof: metadata ? optionalMetadata(metadata, 'x-qhome-context-proof', 4096) : undefined,
    };
    this.verifyRequestContext?.(requestContext, 'grpc', requestContext.contextProof);
    const data = context.switchToRpc().getData<CommandContextCarrier | undefined>();
    const commandContext = data?.context ?? data?.metadata?.context;
    assertCommandContextMatches(commandContext, requestContext);
    call.qhomeContext = requestContext;

    return next.handle();
  }
}

export function getRequestContext(request: ContextRequest): RequestContextValue {
  if (!request.qhomeContext) {
    throw new Error('request context is not initialized');
  }
  return request.qhomeContext;
}

export function getGrpcRequestContext(call: GrpcCall): RequestContextValue {
  if (!call.qhomeContext) {
    throwRpcException({
      code: getGrpcStatusCodes().INTERNAL,
      message: 'request context is not initialized',
    });
  }
  return call.qhomeContext;
}

export function requireApartmentId(request: ContextRequest): string {
  const apartmentId = getRequestContext(request).apartmentId;
  if (!apartmentId) {
    throw new HttpException('x-apartment-id is required for resident operations', 400);
  }
  return apartmentId;
}

export function requireGrpcApartmentId(call: GrpcCall): string {
  const apartmentId = getGrpcRequestContext(call).apartmentId;
  if (!apartmentId) {
    throwRpcException({
      code: getGrpcStatusCodes().INVALID_ARGUMENT,
      message: 'x-apartment-id is required for resident operations',
    });
  }
  return apartmentId;
}

export class BaseMicroservice {
  static async bootstrap(options: BaseMicroserviceOptions): Promise<INestApplication> {
    const logger = new Logger(options.serviceName);
    if (!options.serviceName || !Number.isInteger(options.httpPort) || options.httpPort <= 0 || options.httpPort > 65535) {
      throw new Error('serviceName and a valid httpPort are required');
    }
    const environment = options.environment ?? process.env.NODE_ENV ?? 'development';
    if (environment === 'production' && !options.verifyRequestContext) {
      throw new Error('verifyRequestContext is required in production');
    }

    const { getNodeAutoInstrumentations } = await import('@opentelemetry/auto-instrumentations-node');
    const otlpEndpoint = options.otlpEndpoint ?? process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
    const telemetry = new NodeSDK({
      resource: resourceFromAttributes({
        'service.name': options.serviceName,
        'service.version': options.serviceVersion ?? '0.0.0',
        'deployment.environment': environment,
        'service.instance.id': process.env.HOSTNAME ?? `${options.serviceName}-${process.pid}`,
      }),
      ...(otlpEndpoint ? { traceExporter: new OTLPTraceExporter({ url: otlpEndpoint }) } : {}),
      instrumentations: [getNodeAutoInstrumentations()],
    });

    await telemetry.start();

    let app: INestApplication | undefined;
    try {
      const [{ NestFactory }, microserviceRuntime, grpcRuntime] = await Promise.all([
        import('@nestjs/core'),
        import('@nestjs/microservices'),
        import('@grpc/grpc-js'),
      ]);
      rpcExceptionConstructor = microserviceRuntime.RpcException as RpcExceptionConstructor;
      grpcStatusCodes = grpcRuntime.status;

      app = await NestFactory.create(options.module, { bufferLogs: true, rawBody: options.rawBody ?? false });
      app.useLogger(logger);
      app.useGlobalPipes(new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
        transformOptions: { enableImplicitConversion: false },
      }));
      app.useGlobalFilters(new GlobalExceptionFilter());
      app.useGlobalInterceptors(new GrpcContextInterceptor(options.verifyRequestContext));

      const httpAdapter = app.getHttpAdapter();
      httpAdapter.use((request: ContextRequest, response: unknown, next: () => void) => {
        const path = (request.originalUrl ?? request.url ?? '').split('?')[0];
        if (path === '/health/live' || path === '/health/ready' || options.publicPaths?.includes(path)) {
          next();
          return;
        }

        const correlationId = headerValue(request, 'x-correlation-id');
        const tenantId = headerValue(request, 'x-tenant-id');
        if (validHeader(correlationId)) {
          httpAdapter.setHeader(response, 'x-correlation-id', correlationId);
        }
        if (!validHeader(correlationId) || !validHeader(tenantId)) {
          const responseObject = response as HttpResponse;
          responseObject.type?.('application/problem+json');
          httpAdapter.reply(response, problemBody({
            statusCode: 400,
            code: 'REQUEST_CONTEXT_REQUIRED',
            message: 'x-correlation-id and x-tenant-id are required',
          }, undefined), 400);
          return;
        }

        try {
          const requestContext: RequestContextValue = {
            correlationId,
            tenantId,
            apartmentId: optionalHeader(request, 'x-apartment-id'),
            actorId: optionalHeader(request, 'x-actor-id'),
            subject: optionalHeader(request, 'x-subject'),
            clientType: optionalHeader(request, 'x-client-type'),
            traceparent: optionalHeader(request, 'traceparent'),
            tracestate: optionalHeader(request, 'tracestate'),
            scopes: parseScopes(optionalHeader(request, 'x-scopes')),
            contextProof: optionalHeader(request, 'x-qhome-context-proof', 4096),
          };
          options.verifyRequestContext?.(requestContext, 'http', requestContext.contextProof);
          request.qhomeContext = requestContext;
          next();
        } catch (exception: unknown) {
          const normalized = normalizeException(exception);
          const responseObject = response as HttpResponse;
          responseObject.type?.('application/problem+json');
          httpAdapter.reply(response, problemBody(normalized, validHeader(correlationId) ? correlationId : undefined), normalized.statusCode);
        }
      });

      httpAdapter.get('/health/live', (_request: unknown, response: unknown) => {
        httpAdapter.reply(response, {
          status: 'alive',
          service: options.serviceName,
          timestamp: new Date().toISOString(),
        }, 200);
      });

      let readinessInFlight: Promise<Array<{ name: string; status: 'up' | 'down' }>> | undefined;
      const runReadinessChecks = (): Promise<Array<{ name: string; status: 'up' | 'down' }>> => {
        if (readinessInFlight) {
          return readinessInFlight;
        }

        const operations: TimedOperation<void>[] = [];
        const checks = (options.readinessChecks ?? []).map(async (readinessCheck) => {
          try {
            const operation = withTimeout((signal) => readinessCheck.check(signal), readinessCheck.timeoutMs ?? 2000);
            operations.push(operation);
            await operation.result;
            return { name: readinessCheck.name, status: 'up' as const };
          } catch (error: unknown) {
            logger.warn(`readiness check failed: ${readinessCheck.name}: ${error instanceof Error ? error.message : 'unknown error'}`);
            return { name: readinessCheck.name, status: 'down' as const };
          }
        });

        const result = Promise.all(checks);
        readinessInFlight = result;
        void Promise.all(operations.map((operation) => operation.settled)).finally(() => {
          if (readinessInFlight === result) {
            readinessInFlight = undefined;
          }
        });
        return result;
      };

      let shuttingDown = false;
      httpAdapter.get('/health/ready', async (_request: unknown, response: unknown) => {
        if (shuttingDown) {
          httpAdapter.reply(response, {
            status: 'not_ready',
            service: options.serviceName,
            checks: [{ name: 'shutdown', status: 'down' }],
            timestamp: new Date().toISOString(),
          }, 503);
          return;
        }
        const checks = await runReadinessChecks();
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
          transport: microserviceRuntime.Transport.GRPC,
          options: {
            package: options.grpc.package,
            protoPath: options.grpc.protoPath,
            url: options.grpc.url,
            ...(options.grpc.includeDirs ? { includeDirs: options.grpc.includeDirs } : {}),
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

      const shutdown = async (signal: string) => {
        if (shuttingDown) {
          return;
        }
        shuttingDown = true;
        logger.log(`received ${signal}; starting graceful shutdown`);
        const timeoutMs = options.shutdownTimeoutMs ?? 10000;
        let shutdownTimedOut = false;
        try {
          await withTimeout(() => app!.close(), timeoutMs).result;
        } catch (error: unknown) {
          shutdownTimedOut = true;
          logger.error(`application shutdown failed: ${error instanceof Error ? error.message : 'unknown error'}`);
        }
        try {
          await withTimeout(() => telemetry.shutdown(), timeoutMs).result;
        } catch (error: unknown) {
          shutdownTimedOut = true;
          logger.error(`telemetry shutdown failed: ${error instanceof Error ? error.message : 'unknown error'}`);
        }
        if (shutdownTimedOut) {
          process.exitCode = 1;
          setTimeout(() => process.exit(1), 1000);
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
