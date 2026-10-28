import { randomUUID } from 'node:crypto';
import type { DocumentPermission, DocumentScopeType, DocumentStatus, UploadMode } from '@prisma/client';
import { DocumentAccessService } from './document-access.service';
import { DocumentContext, DocumentRepository, ObjectStorage } from './ports';
import { assertFileSize, assertMagicBytes, normalizeFileName, normalizeMimeType, normalizeSha256, verifySha256 } from '../domain/file-validation';

const UPLOAD_TTL_SECONDS = 300;
const DOWNLOAD_TTL_SECONDS = 120;
const MULTIPART_PART_SIZE = 16 * 1024 * 1024;

export class DocumentService {
  constructor(
    private readonly repository: DocumentRepository,
    private readonly storage: ObjectStorage,
    private readonly access: DocumentAccessService,
  ) {}

  createFolder(context: DocumentContext, input: { scopeType: DocumentScopeType; name: string; buildingId?: string; apartmentId?: string; parentId?: string }) {
    return this.access.assertScopeAccess(context, input.scopeType, input.buildingId, input.apartmentId).then(() => this.repository.createFolder({ ...input, projectId: context.projectId, actorUserId: context.userId, correlationId: context.correlationId }));
  }

  listFolders(context: DocumentContext, parentId?: string) {
    return this.access.assertScopeAccess(context, context.apartmentId ? 'RESIDENT' : context.buildingId ? 'BUILDING' : 'PROJECT', context.buildingId, context.apartmentId, 'READ').then(() => this.repository.listFolders({ projectId: context.projectId, buildingId: context.buildingId, apartmentId: context.apartmentId, parentId }));
  }

  async createVersion(context: DocumentContext, documentId: string, input: { mimeType: string; sizeBytes: number; sha256: string; uploadMode: UploadMode }) {
    const document = await this.requiredDocument(documentId);
    await this.access.assertDocumentAccess(context, document, 'WRITE');
    const mimeType = normalizeMimeType(input.mimeType);
    assertFileSize(input.sizeBytes);
    const sha256 = normalizeSha256(input.sha256);
    const created = await this.repository.createVersion({ projectId: context.projectId, documentId, scopeType: document.scopeType, title: document.title, originalFileName: document.originalFileName, mimeType, sizeBytes: input.sizeBytes, sha256, uploadMode: input.uploadMode, buildingId: document.buildingId, apartmentId: document.apartmentId, actorUserId: context.userId, correlationId: context.correlationId, objectKey: this.objectKey(context.projectId, document.scopeType, document.originalFileName) });
    if (input.uploadMode === 'SINGLE') {
      const upload = await this.storage.createUploadUrl({ objectKey: created.version.objectKey, mimeType, sizeBytes: input.sizeBytes, sha256, expiresInSeconds: UPLOAD_TTL_SECONDS });
      await this.repository.setSingleUploadVersion({ documentId, versionId: created.version.id });
      return { document: created.document, version: created.version, uploadMode: 'SINGLE', uploadUrl: upload.url, uploadHeaders: upload.headers, expiresInSeconds: UPLOAD_TTL_SECONDS };
    }
    const multipart = await this.storage.createMultipart({ objectKey: created.version.objectKey, mimeType, sha256, expiresInSeconds: 3600 });
    await this.repository.setMultipartUpload({ documentId, versionId: created.version.id, providerUploadId: multipart.providerUploadId, partSizeBytes: MULTIPART_PART_SIZE, expiresAt: multipart.expiresAt });
    return { document: created.document, version: { ...created.version, providerUploadId: multipart.providerUploadId, partSizeBytes: MULTIPART_PART_SIZE }, uploadMode: 'MULTIPART', expiresAt: multipart.expiresAt };
  }

  async createDocument(context: DocumentContext, input: { scopeType: DocumentScopeType; title: string; originalFileName: string; mimeType: string; sizeBytes: number; sha256: string; uploadMode: UploadMode; buildingId?: string; apartmentId?: string; folderId?: string }) {
    await this.access.assertScopeAccess(context, input.scopeType, input.buildingId, input.apartmentId);
    const fileName = normalizeFileName(input.originalFileName);
    const mimeType = normalizeMimeType(input.mimeType);
    assertFileSize(input.sizeBytes);
    const sha256 = normalizeSha256(input.sha256);
    if (!input.title?.trim() || input.title.length > 300) throw new Error('Document title is invalid');
    const created = await this.repository.createDocument({ ...input, projectId: context.projectId, title: input.title.trim(), originalFileName: fileName, mimeType, sizeBytes: input.sizeBytes, sha256, actorUserId: context.userId, correlationId: context.correlationId, objectKey: this.objectKey(context.projectId, input.scopeType, fileName) });
    if (input.uploadMode === 'SINGLE') {
      const upload = await this.storage.createUploadUrl({ objectKey: created.version.objectKey, mimeType, sizeBytes: input.sizeBytes, sha256, expiresInSeconds: UPLOAD_TTL_SECONDS });
      await this.repository.setSingleUploadVersion({ documentId: created.document.id, versionId: created.version.id });
      return { document: created.document, version: created.version, uploadMode: 'SINGLE', uploadUrl: upload.url, uploadHeaders: upload.headers, expiresInSeconds: UPLOAD_TTL_SECONDS };
    }
    const multipart = await this.storage.createMultipart({ objectKey: created.version.objectKey, mimeType, sha256, expiresInSeconds: 3600 });
    await this.repository.setMultipartUpload({ documentId: created.document.id, versionId: created.version.id, providerUploadId: multipart.providerUploadId, partSizeBytes: MULTIPART_PART_SIZE, expiresAt: multipart.expiresAt });
    return { document: created.document, version: { ...created.version, providerUploadId: multipart.providerUploadId, partSizeBytes: MULTIPART_PART_SIZE }, uploadMode: 'MULTIPART', expiresAt: multipart.expiresAt };
  }

  async createMultipartPartUrls(context: DocumentContext, documentId: string, versionId: string, input: { partNumbers: number[]; checksums?: Record<string, string> }) {
    const document = await this.requiredDocument(documentId);
    await this.access.assertDocumentAccess(context, document, 'WRITE');
    const version = await this.requiredVersion(documentId, versionId);
    if (!version.providerUploadId || !version.partSizeBytes) throw new Error('Multipart upload is not initialized');
    const partNumbers = Array.from(new Set(input.partNumbers));
    if (!partNumbers.length || partNumbers.some((partNumber) => !Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10_000)) throw new Error('Invalid multipart part numbers');
    return Promise.all(partNumbers.map(async (partNumber) => ({ partNumber, ...(await this.storage.createPartUploadUrl({ objectKey: version.objectKey, providerUploadId: version.providerUploadId!, partNumber, checksumSha256: input.checksums?.[String(partNumber)], expiresInSeconds: UPLOAD_TTL_SECONDS })) })));
  }

  async completeVersion(context: DocumentContext, documentId: string, versionId: string, input: { checksumSha256: string; sizeBytes: number; parts?: Array<{ partNumber: number; etag: string; checksumSha256?: string; sizeBytes: number }> }) {
    const document = await this.requiredDocument(documentId);
    await this.access.assertDocumentAccess(context, document, 'WRITE');
    const version = await this.requiredVersion(documentId, versionId);
    const checksumSha256 = normalizeSha256(input.checksumSha256);
    assertFileSize(input.sizeBytes);
    try {
      if (version.providerUploadId) {
        const parts = input.parts ?? await this.repository.getMultipartParts(documentId, versionId);
        if (!parts.length) throw new Error('Multipart completion requires at least one part');
        await this.repository.saveMultipartParts({ documentId, versionId, parts });
        await this.storage.completeMultipart({ objectKey: version.objectKey, providerUploadId: version.providerUploadId, parts, sha256: checksumSha256 });
      }
      const head = await this.storage.head({ objectKey: version.objectKey });
      if (head.sizeBytes !== input.sizeBytes) throw new Error('Object size does not match the declared size');
      if (head.mimeType && normalizeMimeType(head.mimeType) !== version.mimeType) throw new Error('Object MIME type does not match the declared MIME type');
      verifySha256(checksumSha256, head.checksumSha256);
      assertMagicBytes(version.mimeType, await this.storage.readMagicBytes(version.objectKey));
      return this.repository.markVersionAvailable({ documentId, versionId, sizeBytes: head.sizeBytes, checksumSha256, etag: head.etag, correlationId: context.correlationId, actorUserId: context.userId });
    } catch (error: unknown) {
      await this.repository.markVersionFailed({ documentId, versionId, reason: error instanceof Error ? error.message : 'Document verification failed', actorUserId: context.userId, correlationId: context.correlationId });
      throw error;
    }
  }

  async abortVersion(context: DocumentContext, documentId: string, versionId: string): Promise<void> {
    const document = await this.requiredDocument(documentId);
    await this.access.assertDocumentAccess(context, document, 'WRITE');
    const version = await this.requiredVersion(documentId, versionId);
    if (version.providerUploadId) await this.storage.abortMultipart({ objectKey: version.objectKey, providerUploadId: version.providerUploadId });
    await this.repository.abortMultipart(documentId, versionId);
  }

  async downloadUrl(context: DocumentContext, documentId: string) {
    const document = await this.requiredDocument(documentId);
    await this.access.assertDocumentAccess(context, document, 'DOWNLOAD');
    if (document.status !== 'AVAILABLE' || !document.versions[0]) throw new Error('Document is not available');
    const version = document.versions.find((candidate) => candidate.versionNumber === document.currentVersionNumber) ?? document.versions[0];
    return { url: await this.storage.createDownloadUrl({ objectKey: version.objectKey, fileName: document.originalFileName, expiresInSeconds: DOWNLOAD_TTL_SECONDS }), expiresInSeconds: DOWNLOAD_TTL_SECONDS, versionId: version.id };
  }

  async getDocument(context: DocumentContext, documentId: string) {
    const document = await this.requiredDocument(documentId);
    await this.access.assertDocumentAccess(context, document, 'READ');
    return document;
  }

  async listDocuments(context: DocumentContext, input: { folderId?: string; status?: DocumentStatus; cursor?: string; take?: number }) {
    await this.access.assertScopeAccess(context, context.apartmentId ? 'RESIDENT' : context.buildingId ? 'BUILDING' : 'PROJECT', context.buildingId, context.apartmentId, 'READ');
    return this.repository.listDocuments({ projectId: context.projectId, buildingId: context.buildingId, apartmentId: context.apartmentId, folderId: input.folderId, status: input.status, cursor: input.cursor, take: Math.min(Math.max(input.take ?? 20, 1), 100) });
  }

  async createPolicy(context: DocumentContext, documentId: string, input: { principalType: 'USER' | 'ROLE' | 'RESIDENT'; principalId?: string; permission: DocumentPermission; effect: 'ALLOW' | 'DENY'; buildingId?: string; apartmentId?: string }) {
    const document = await this.requiredDocument(documentId);
    await this.access.assertDocumentAccess(context, document, 'SHARE');
    return this.repository.createPolicy({ ...input, documentId, projectId: context.projectId, actorUserId: context.userId, correlationId: context.correlationId });
  }

  private async requiredDocument(documentId: string) {
    const document = await this.repository.getDocument(documentId);
    if (!document) throw new Error('Document not found');
    return document;
  }

  private async requiredVersion(documentId: string, versionId: string) {
    const version = await this.repository.getVersion(documentId, versionId);
    if (!version) throw new Error('Document version not found');
    return version;
  }

  private objectKey(projectId: string, scopeType: DocumentScopeType, fileName: string): string {
    const extension = fileName.includes('.') ? fileName.slice(fileName.lastIndexOf('.')).toLowerCase().replace(/[^a-z0-9.]/gu, '') : '';
    return `documents/${projectId}/${scopeType.toLowerCase()}/${randomUUID()}${extension}`;
  }
}
