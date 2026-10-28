import { randomUUID } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { DocumentRepository, DocumentSnapshot, DocumentVersionSnapshot, FolderSnapshot, AccessPolicySnapshot, CreateDocumentInput } from '../../application/ports';

type Tx = Prisma.TransactionClient;

function jsonRecord(value: Prisma.JsonValue | null | undefined): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function mapVersion(row: any): DocumentVersionSnapshot {
  return {
    id: row.id,
    documentId: row.documentId,
    versionNumber: row.versionNumber,
    objectKey: row.objectKey,
    uploadMode: row.uploadMode,
    status: row.status,
    mimeType: row.mimeType,
    sizeBytes: String(row.sizeBytes),
    sha256: row.sha256,
    checksumSha256: row.checksumSha256 ?? undefined,
    multipartUploadId: row.multipartUpload?.id,
    providerUploadId: row.multipartUpload?.providerUploadId,
    partSizeBytes: row.multipartUpload?.partSizeBytes,
    createdBy: row.createdBy,
  };
}

function mapDocument(row: any): DocumentSnapshot {
  return {
    id: row.id,
    projectId: row.projectId ?? undefined,
    buildingId: row.buildingId ?? undefined,
    apartmentId: row.apartmentId ?? undefined,
    folderId: row.folderId ?? undefined,
    scopeType: row.scopeType,
    title: row.title,
    originalFileName: row.originalFileName,
    status: row.status,
    currentVersionNumber: row.currentVersionNumber,
    accessVersion: row.accessVersion,
    createdBy: row.createdBy,
    versions: (row.versions ?? []).map(mapVersion),
  };
}

function mapFolder(row: any): FolderSnapshot {
  return { id: row.id, projectId: row.projectId ?? undefined, buildingId: row.buildingId ?? undefined, apartmentId: row.apartmentId ?? undefined, parentId: row.parentId ?? undefined, scopeType: row.scopeType, name: row.name, path: row.path };
}

function mapPolicy(row: any): AccessPolicySnapshot {
  return { id: row.id, documentId: row.documentId ?? undefined, folderId: row.folderId ?? undefined, principalType: row.principalType, principalId: row.principalId ?? undefined, permission: row.permission, effect: row.effect };
}

const documentInclude = {
  versions: { orderBy: { versionNumber: 'desc' }, include: { multipartUpload: true } },
} as const;

function outbox(projectId: string | undefined, eventType: string, aggregateType: string, aggregateId: string, payload: Record<string, unknown>) {
  return { eventId: randomUUID(), projectId, topic: 'qhome.document.events.v1', eventType, aggregateType, aggregateId, payload: payload as Prisma.InputJsonValue, headers: {} };
}

export class DocumentPrismaClient extends PrismaClient {
  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}

export class PrismaDocumentRepository implements DocumentRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async createFolder(input: { projectId?: string; buildingId?: string; apartmentId?: string; parentId?: string; scopeType: any; name: string; actorUserId: string; correlationId: string }): Promise<FolderSnapshot> {
    return this.prisma.$transaction(async (tx) => {
      let path = input.name.trim();
      if (input.parentId) {
        const parent = await tx.folder.findUnique({ where: { id: input.parentId } });
        if (!parent || (parent.projectId !== input.projectId && !(input.scopeType === 'COMPANY' && parent.projectId === null)) || parent.scopeType !== input.scopeType) throw new Error('Folder parent is outside the document scope');
        path = `${parent.path}/${input.name.trim()}`;
      }
      const folder = await tx.folder.create({ data: { projectId: input.scopeType === 'COMPANY' ? undefined : input.projectId, buildingId: input.scopeType === 'COMPANY' ? undefined : input.buildingId, apartmentId: input.scopeType === 'COMPANY' ? undefined : input.apartmentId, parentId: input.parentId, scopeType: input.scopeType, name: input.name.trim(), path, createdBy: input.actorUserId } });
      await tx.outboxEvent.create({ data: outbox(input.projectId, 'document.folder.created.v1', 'folder', folder.id, { folderId: folder.id, scopeType: folder.scopeType, actorUserId: input.actorUserId }) });
      return mapFolder(folder);
    });
  }

  async listFolders(input: { projectId: string; buildingId?: string; apartmentId?: string; parentId?: string }): Promise<FolderSnapshot[]> {
    const rows = await this.prisma.folder.findMany({ where: { OR: [{ projectId: null, scopeType: 'COMPANY' }, { projectId: input.projectId }], buildingId: input.buildingId ?? null, apartmentId: input.apartmentId ?? null, parentId: input.parentId ?? null }, orderBy: [{ name: 'asc' }, { id: 'asc' }] });
    return rows.map(mapFolder);
  }

  async createDocument(input: CreateDocumentInput & { objectKey: string }): Promise<{ document: DocumentSnapshot; version: DocumentVersionSnapshot }> {
    return this.prisma.$transaction(async (tx) => {
      if (input.folderId) {
        const folder = await tx.folder.findFirst({ where: { id: input.folderId, OR: [{ projectId: input.projectId }, { projectId: null, scopeType: 'COMPANY' }] } });
        if (!folder) throw new Error('Folder is not available in the project scope');
      }
      const document = await tx.document.create({ data: { projectId: input.scopeType === 'COMPANY' ? undefined : input.projectId, buildingId: input.scopeType === 'COMPANY' ? undefined : input.buildingId, apartmentId: input.scopeType === 'COMPANY' ? undefined : input.apartmentId, folderId: input.folderId, scopeType: input.scopeType, title: input.title.trim(), originalFileName: input.originalFileName, status: 'UPLOADING', currentVersionNumber: 0, createdBy: input.actorUserId, versions: { create: { versionNumber: 1, objectKey: input.objectKey, uploadMode: input.uploadMode, status: 'INITIATED', mimeType: input.mimeType, sizeBytes: BigInt(input.sizeBytes), sha256: input.sha256, createdBy: input.actorUserId } } }, include: documentInclude });
      await tx.outboxEvent.create({ data: outbox(input.projectId, 'document.created.v1', 'document', document.id, { documentId: document.id, versionId: document.versions[0].id, scopeType: input.scopeType, actorUserId: input.actorUserId }) });
      await tx.documentAuditEvent.create({ data: { documentId: document.id, projectId: input.projectId, actorUserId: input.actorUserId, action: 'DOCUMENT_CREATED', versionId: document.versions[0].id, correlationId: input.correlationId, metadata: { scopeType: input.scopeType, uploadMode: input.uploadMode } } });
      return { document: mapDocument(document), version: mapVersion(document.versions[0]) };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, maxWait: 5000, timeout: 10000 });
  }

  async createVersion(input: CreateDocumentInput & { documentId: string; objectKey: string }): Promise<{ document: DocumentSnapshot; version: DocumentVersionSnapshot }> {
    return this.prisma.$transaction(async (tx) => {
      const document = await tx.document.findFirst({ where: { id: input.documentId, OR: [{ projectId: input.projectId }, { projectId: null, scopeType: 'COMPANY' }] }, include: documentInclude });
      if (!document || ['DELETED', 'ARCHIVED'].includes(document.status)) throw new Error('Document cannot receive a new version');
      const latest = await tx.documentVersion.aggregate({ where: { documentId: input.documentId }, _max: { versionNumber: true } });
      const version = await tx.documentVersion.create({ data: { documentId: input.documentId, versionNumber: (latest._max.versionNumber ?? 0) + 1, objectKey: input.objectKey, uploadMode: input.uploadMode, status: 'INITIATED', mimeType: input.mimeType, sizeBytes: BigInt(input.sizeBytes), sha256: input.sha256, createdBy: input.actorUserId } });
      const updatedDocument = await tx.document.update({ where: { id: input.documentId }, data: { status: 'UPLOADING' }, include: documentInclude });
      await tx.outboxEvent.create({ data: outbox(input.projectId, 'document.version.created.v1', 'document', input.documentId, { documentId: input.documentId, versionId: version.id, versionNumber: version.versionNumber, actorUserId: input.actorUserId }) });
      await tx.documentAuditEvent.create({ data: { documentId: input.documentId, projectId: input.projectId, actorUserId: input.actorUserId, action: 'DOCUMENT_VERSION_CREATED', versionId: version.id, correlationId: input.correlationId, metadata: { versionNumber: version.versionNumber } } });
      return { document: mapDocument(updatedDocument), version: mapVersion({ ...version, multipartUpload: null }) };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, maxWait: 5000, timeout: 10000 });
  }

  async getDocument(documentId: string): Promise<DocumentSnapshot | null> {
    const row = await this.prisma.document.findUnique({ where: { id: documentId }, include: documentInclude });
    return row ? mapDocument(row) : null;
  }

  async listDocuments(input: { projectId: string; buildingId?: string; apartmentId?: string; folderId?: string; status?: any; cursor?: string; take: number }): Promise<{ items: DocumentSnapshot[]; nextCursor?: string }> {
    const scopeFilters = [{ OR: [{ scopeType: 'COMPANY' }, { projectId: input.projectId }] }];
    if (input.buildingId) scopeFilters.push({ OR: [{ scopeType: { in: ['COMPANY', 'PROJECT'] } }, { buildingId: input.buildingId }] } as never);
    if (input.apartmentId) scopeFilters.push({ OR: [{ scopeType: { in: ['COMPANY', 'PROJECT', 'BUILDING'] } }, { apartmentId: input.apartmentId }] } as never);
    const rows = await this.prisma.document.findMany({ where: { AND: scopeFilters, ...(input.folderId ? { folderId: input.folderId } : {}), ...(input.status ? { status: input.status } : {}) }, include: documentInclude, orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }], take: input.take + 1, ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}) });
    const visible = rows.length > input.take ? rows.slice(0, input.take) : rows;
    return { items: visible.map(mapDocument), nextCursor: rows.length > input.take ? visible.at(-1)?.id : undefined };
  }

  async setSingleUploadVersion(input: { documentId: string; versionId: string; providerUploadId?: string }): Promise<DocumentVersionSnapshot> {
    const version = await this.prisma.documentVersion.update({ where: { id: input.versionId, documentId: input.documentId }, data: { status: 'UPLOADING', objectVersionId: input.providerUploadId }, include: { multipartUpload: true } });
    return mapVersion(version);
  }

  async setMultipartUpload(input: { documentId: string; versionId: string; providerUploadId: string; partSizeBytes: number; expiresAt: Date }): Promise<DocumentVersionSnapshot> {
    const version = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.documentVersion.update({ where: { id: input.versionId, documentId: input.documentId }, data: { status: 'UPLOADING', uploadMode: 'MULTIPART' } });
      await tx.multipartUpload.upsert({ where: { documentVersionId: input.versionId }, create: { documentVersionId: input.versionId, providerUploadId: input.providerUploadId, partSizeBytes: input.partSizeBytes, expiresAt: input.expiresAt }, update: { providerUploadId: input.providerUploadId, partSizeBytes: input.partSizeBytes, expiresAt: input.expiresAt, status: 'INITIATED', abortedAt: null } });
      return tx.documentVersion.findUniqueOrThrow({ where: { id: updated.id }, include: { multipartUpload: true } });
    });
    return mapVersion(version);
  }

  async getVersion(documentId: string, versionId: string): Promise<DocumentVersionSnapshot | null> {
    const row = await this.prisma.documentVersion.findFirst({ where: { id: versionId, documentId }, include: { multipartUpload: true } });
    return row ? mapVersion(row) : null;
  }

  async saveMultipartParts(input: { documentId: string; versionId: string; parts: Array<{ partNumber: number; etag: string; checksumSha256?: string; sizeBytes: number }> }): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const upload = await tx.multipartUpload.findFirst({ where: { documentVersionId: input.versionId, documentVersion: { documentId: input.documentId }, status: 'INITIATED' } });
      if (!upload) throw new Error('Multipart upload is not active');
      for (const part of input.parts) {
        await tx.multipartUploadPart.upsert({ where: { multipartUploadId_partNumber: { multipartUploadId: upload.id, partNumber: part.partNumber } }, create: { multipartUploadId: upload.id, partNumber: part.partNumber, etag: part.etag, checksumSha256: part.checksumSha256, sizeBytes: part.sizeBytes }, update: { etag: part.etag, checksumSha256: part.checksumSha256, sizeBytes: part.sizeBytes } });
      }
    });
  }

  async getMultipartParts(documentId: string, versionId: string) {
    const upload = await this.prisma.multipartUpload.findFirst({ where: { documentVersionId: versionId, documentVersion: { documentId } }, include: { parts: { orderBy: { partNumber: 'asc' } } } });
    if (!upload) throw new Error('Multipart upload is not active');
    return upload.parts.map((part) => ({ partNumber: part.partNumber, etag: part.etag, checksumSha256: part.checksumSha256 ?? undefined, sizeBytes: part.sizeBytes }));
  }

  async markVersionAvailable(input: { documentId: string; versionId: string; sizeBytes: number; checksumSha256: string; etag?: string; correlationId: string; actorUserId: string }): Promise<DocumentVersionSnapshot> {
    return this.prisma.$transaction(async (tx) => {
      const version = await tx.documentVersion.findFirst({ where: { id: input.versionId, documentId: input.documentId }, include: { multipartUpload: true, document: { select: { projectId: true } } } });
      if (!version || !['INITIATED', 'UPLOADING', 'VERIFYING'].includes(version.status)) throw new Error('Document version is not available for completion');
      const updated = await tx.documentVersion.update({ where: { id: version.id }, data: { status: 'AVAILABLE', sizeBytes: BigInt(input.sizeBytes), checksumSha256: input.checksumSha256, sha256: input.checksumSha256, etag: input.etag, magicBytesVerified: true, mimeTypeVerified: true, checksumVerified: true, uploadedAt: new Date(), publishedAt: new Date() }, include: { multipartUpload: true } });
      await tx.document.update({ where: { id: input.documentId }, data: { status: 'AVAILABLE', currentVersionNumber: version.versionNumber } });
      if (version.multipartUpload) await tx.multipartUpload.update({ where: { id: version.multipartUpload.id }, data: { status: 'COMPLETED', completedAt: new Date() } });
      await tx.outboxEvent.create({ data: outbox(version.document.projectId ?? undefined, 'document.version.available.v1', 'document', input.documentId, { documentId: input.documentId, versionId: input.versionId, versionNumber: version.versionNumber, checksumSha256: input.checksumSha256, sizeBytes: input.sizeBytes }) });
      await tx.documentAuditEvent.create({ data: { documentId: input.documentId, actorUserId: input.actorUserId, action: 'DOCUMENT_VERSION_AVAILABLE', versionId: input.versionId, correlationId: input.correlationId, metadata: { checksumSha256: input.checksumSha256, sizeBytes: input.sizeBytes } } });
      return mapVersion(updated);
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, maxWait: 5000, timeout: 15000 });
  }

  async markVersionFailed(input: { documentId: string; versionId: string; reason: string; actorUserId: string; correlationId: string }): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.documentVersion.updateMany({ where: { id: input.versionId, documentId: input.documentId }, data: { status: 'FAILED', failedAt: new Date(), failureReason: input.reason.slice(0, 1000) } });
      await tx.document.update({ where: { id: input.documentId }, data: { status: 'QUARANTINED' } });
      await tx.documentAuditEvent.create({ data: { documentId: input.documentId, actorUserId: input.actorUserId, action: 'DOCUMENT_VERSION_FAILED', versionId: input.versionId, correlationId: input.correlationId, metadata: { reason: input.reason } } });
    });
  }

  async markMultipartCompleted(documentId: string, versionId: string): Promise<void> {
    await this.prisma.multipartUpload.updateMany({ where: { documentVersionId: versionId, documentVersion: { documentId } }, data: { status: 'COMPLETED', completedAt: new Date() } });
  }

  async abortMultipart(documentId: string, versionId: string): Promise<void> {
    await this.prisma.multipartUpload.updateMany({ where: { documentVersionId: versionId, documentVersion: { documentId } }, data: { status: 'ABORTED', abortedAt: new Date() } });
  }

  async getPolicies(documentId: string, folderId?: string): Promise<AccessPolicySnapshot[]> {
    const rows = await this.prisma.accessPolicy.findMany({ where: { OR: [{ documentId }, ...(folderId ? [{ folderId }] : [])] }, orderBy: { createdAt: 'asc' } });
    return rows.map(mapPolicy);
  }

  async createPolicy(input: { documentId?: string; folderId?: string; projectId: string; buildingId?: string; apartmentId?: string; principalType: 'USER' | 'ROLE' | 'RESIDENT'; principalId?: string; permission: any; effect: 'ALLOW' | 'DENY'; actorUserId: string; correlationId: string }): Promise<AccessPolicySnapshot> {
    const documentId = input.documentId;
    if (!documentId) throw new Error('Document policies must target a document');
    return this.prisma.$transaction(async (tx) => {
      const document = await tx.document.findFirst({ where: { id: documentId, OR: [{ projectId: input.projectId }, { scopeType: 'COMPANY' }] } });
      if (!document) throw new Error('Document is outside the project scope');
      const policy = await tx.accessPolicy.create({ data: { documentId, projectId: input.projectId, buildingId: input.buildingId, apartmentId: input.apartmentId, principalType: input.principalType, principalId: input.principalId, permission: input.permission, effect: input.effect, createdBy: input.actorUserId } });
      await tx.document.update({ where: { id: documentId }, data: { accessVersion: { increment: 1 } } });
      await tx.outboxEvent.create({ data: outbox(input.projectId, 'document.access_policy.changed.v1', 'document', documentId, { documentId, policyId: policy.id, principalType: input.principalType, permission: input.permission, effect: input.effect }) });
      await tx.documentAuditEvent.create({ data: { documentId, projectId: input.projectId, actorUserId: input.actorUserId, action: 'ACCESS_POLICY_CREATED', correlationId: input.correlationId, metadata: { policyId: policy.id } } });
      return mapPolicy(policy);
    });
  }
}
