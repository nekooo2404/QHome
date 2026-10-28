import { Body, Controller, Get, HttpCode, Param, Post, Query, Req } from '@nestjs/common';
import { ContextRequest, getRequestContext } from '../../../../../libs/common/src/base-microservice';
import { DocumentService } from '../../application/document.service';
import { DocumentContext } from '../../application/ports';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SCOPES = new Set(['COMPANY', 'PROJECT', 'BUILDING', 'RESIDENT']);
const UPLOAD_MODES = new Set(['SINGLE', 'MULTIPART']);
const PERMISSIONS = new Set(['READ', 'DOWNLOAD', 'WRITE', 'SHARE']);

type CreateFolderBody = { scopeType: 'COMPANY' | 'PROJECT' | 'BUILDING' | 'RESIDENT'; name: string; buildingId?: string; apartmentId?: string; parentId?: string };
type CreateDocumentBody = { scopeType: 'COMPANY' | 'PROJECT' | 'BUILDING' | 'RESIDENT'; title: string; originalFileName: string; mimeType: string; sizeBytes: number; sha256: string; uploadMode: 'SINGLE' | 'MULTIPART'; buildingId?: string; apartmentId?: string; folderId?: string };
type CompleteBody = { checksumSha256: string; sizeBytes: number; parts?: Array<{ partNumber: number; etag: string; checksumSha256?: string; sizeBytes: number }> };
type PolicyBody = { principalType: 'USER' | 'ROLE' | 'RESIDENT'; principalId?: string; permission: 'READ' | 'DOWNLOAD' | 'WRITE' | 'SHARE'; effect: 'ALLOW' | 'DENY'; buildingId?: string; apartmentId?: string };

@Controller('/v1/documents')
export class DocumentHttpController {
  constructor(private readonly service: DocumentService) {}

  @Post('/folders')
  createFolder(@Req() request: ContextRequest, @Body() body: CreateFolderBody) {
    this.validateScope(body?.scopeType);
    this.required(body?.name, 'name', 200);
    return this.service.createFolder(this.context(request), body);
  }

  @Get('/folders')
  listFolders(@Req() request: ContextRequest, @Query('parentId') parentId?: string) {
    if (parentId && !UUID.test(parentId)) throw new Error('parentId is invalid');
    return this.service.listFolders(this.context(request), parentId);
  }

  @Post()
  createDocument(@Req() request: ContextRequest, @Body() body: CreateDocumentBody) {
    this.validateScope(body?.scopeType);
    if (!UPLOAD_MODES.has(body?.uploadMode)) throw new Error('uploadMode is invalid');
    this.required(body?.title, 'title', 300);
    this.required(body?.originalFileName, 'originalFileName', 512);
    this.required(body?.mimeType, 'mimeType', 160);
    if (!Number.isSafeInteger(body?.sizeBytes) || body.sizeBytes <= 0) throw new Error('sizeBytes is invalid');
    this.required(body?.sha256, 'sha256', 64);
    return this.service.createDocument(this.context(request), body);
  }

  @Get()
  listDocuments(@Req() request: ContextRequest, @Query('folderId') folderId?: string, @Query('status') status?: 'DRAFT' | 'UPLOADING' | 'AVAILABLE' | 'ARCHIVED' | 'DELETED' | 'QUARANTINED', @Query('cursor') cursor?: string, @Query('take') take?: string) {
    if (folderId && !UUID.test(folderId)) throw new Error('folderId is invalid');
    return this.service.listDocuments(this.context(request), { folderId, status, cursor, take: take ? Number(take) : undefined });
  }

  @Get('/:documentId')
  getDocument(@Req() request: ContextRequest, @Param('documentId') documentId: string) {
    this.requireUuid(documentId, 'documentId');
    return this.service.getDocument(this.context(request), documentId);
  }

  @Post('/:documentId/versions')
  createVersion(@Req() request: ContextRequest, @Param('documentId') documentId: string, @Body() body: { mimeType: string; sizeBytes: number; sha256: string; uploadMode: 'SINGLE' | 'MULTIPART' }) {
    this.requireUuid(documentId, 'documentId');
    if (!UPLOAD_MODES.has(body?.uploadMode)) throw new Error('uploadMode is invalid');
    this.required(body?.mimeType, 'mimeType', 160);
    this.required(body?.sha256, 'sha256', 64);
    if (!Number.isSafeInteger(body?.sizeBytes) || body.sizeBytes <= 0) throw new Error('sizeBytes is invalid');
    return this.service.createVersion(this.context(request), documentId, body);
  }

  @Post('/:documentId/versions/:versionId/multipart/parts')
  createMultipartPartUrls(@Req() request: ContextRequest, @Param('documentId') documentId: string, @Param('versionId') versionId: string, @Body() body: { partNumbers: number[]; checksums?: Record<string, string> }) {
    this.requireUuid(documentId, 'documentId');
    this.requireUuid(versionId, 'versionId');
    if (!Array.isArray(body?.partNumbers)) throw new Error('partNumbers is required');
    return this.service.createMultipartPartUrls(this.context(request), documentId, versionId, body);
  }

  @Post('/:documentId/versions/:versionId/complete')
  completeVersion(@Req() request: ContextRequest, @Param('documentId') documentId: string, @Param('versionId') versionId: string, @Body() body: CompleteBody) {
    this.requireUuid(documentId, 'documentId');
    this.requireUuid(versionId, 'versionId');
    if (!Number.isSafeInteger(body?.sizeBytes) || body.sizeBytes <= 0) throw new Error('sizeBytes is invalid');
    this.required(body?.checksumSha256, 'checksumSha256', 64);
    return this.service.completeVersion(this.context(request), documentId, versionId, body);
  }

  @Post('/:documentId/versions/:versionId/abort')
  @HttpCode(204)
  async abortVersion(@Req() request: ContextRequest, @Param('documentId') documentId: string, @Param('versionId') versionId: string): Promise<void> {
    this.requireUuid(documentId, 'documentId');
    this.requireUuid(versionId, 'versionId');
    await this.service.abortVersion(this.context(request), documentId, versionId);
  }

  @Post('/:documentId/download-url')
  downloadUrl(@Req() request: ContextRequest, @Param('documentId') documentId: string) {
    this.requireUuid(documentId, 'documentId');
    return this.service.downloadUrl(this.context(request), documentId);
  }

  @Post('/:documentId/policies')
  createPolicy(@Req() request: ContextRequest, @Param('documentId') documentId: string, @Body() body: PolicyBody) {
    this.requireUuid(documentId, 'documentId');
    if (!['USER', 'ROLE', 'RESIDENT'].includes(body?.principalType)) throw new Error('principalType is invalid');
    if (!PERMISSIONS.has(body?.permission) || !['ALLOW', 'DENY'].includes(body?.effect)) throw new Error('policy permission or effect is invalid');
    return this.service.createPolicy(this.context(request), documentId, body);
  }

  private context(request: ContextRequest): DocumentContext {
    const transport = getRequestContext(request);
    const userId = transport.subject ?? transport.actorId;
    if (!userId) throw new Error('authenticated user context is required');
    return { userId, projectId: transport.tenantId, buildingId: transport.buildingId, apartmentId: transport.apartmentId, sessionId: transport.sessionId, roles: (transport.rolesHeader ?? '').split(/[ ,]+/u).filter(Boolean), correlationId: transport.correlationId };
  }

  private validateScope(scope: string | undefined): void {
    if (!scope || !SCOPES.has(scope)) throw new Error('scopeType is invalid');
  }

  private required(value: unknown, name: string, maxLength: number): asserts value is string {
    if (typeof value !== 'string' || value.trim().length === 0 || value.length > maxLength) throw new Error(`${name} is invalid`);
  }

  private requireUuid(value: string, name: string): void {
    if (!UUID.test(value)) throw new Error(`${name} is invalid`);
  }
}
