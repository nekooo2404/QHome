import type { DocumentPermission, DocumentScopeType, DocumentStatus, DocumentVersionStatus, UploadMode } from '@prisma/client';

export interface DocumentContext {
  userId: string;
  projectId: string;
  buildingId?: string;
  apartmentId?: string;
  sessionId?: string;
  roles: string[];
  correlationId: string;
}

export interface DocumentSnapshot {
  id: string;
  projectId?: string;
  buildingId?: string;
  apartmentId?: string;
  folderId?: string;
  scopeType: DocumentScopeType;
  title: string;
  originalFileName: string;
  status: DocumentStatus;
  currentVersionNumber: number;
  accessVersion: number;
  createdBy: string;
  versions: DocumentVersionSnapshot[];
}

export interface DocumentVersionSnapshot {
  id: string;
  documentId: string;
  versionNumber: number;
  objectKey: string;
  uploadMode: UploadMode;
  status: DocumentVersionStatus;
  mimeType: string;
  sizeBytes: string;
  sha256: string;
  checksumSha256?: string;
  multipartUploadId?: string;
  providerUploadId?: string;
  partSizeBytes?: number;
  createdBy: string;
}

export interface FolderSnapshot {
  id: string;
  projectId?: string;
  buildingId?: string;
  apartmentId?: string;
  parentId?: string;
  scopeType: DocumentScopeType;
  name: string;
  path: string;
}

export interface AccessPolicySnapshot {
  id: string;
  documentId?: string;
  folderId?: string;
  principalType: string;
  principalId?: string;
  permission: DocumentPermission;
  effect: 'ALLOW' | 'DENY';
}

export interface CreateDocumentInput {
  projectId: string;
  buildingId?: string;
  apartmentId?: string;
  folderId?: string;
  scopeType: DocumentScopeType;
  title: string;
  originalFileName: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  uploadMode: UploadMode;
  actorUserId: string;
  correlationId: string;
}

export interface DocumentRepository {
  createFolder(input: { projectId?: string; buildingId?: string; apartmentId?: string; parentId?: string; scopeType: DocumentScopeType; name: string; actorUserId: string; correlationId: string }): Promise<FolderSnapshot>;
  listFolders(input: { projectId: string; buildingId?: string; apartmentId?: string; parentId?: string }): Promise<FolderSnapshot[]>;
  createDocument(input: CreateDocumentInput & { objectKey: string }): Promise<{ document: DocumentSnapshot; version: DocumentVersionSnapshot }>;
  createVersion(input: CreateDocumentInput & { documentId: string; objectKey: string }): Promise<{ document: DocumentSnapshot; version: DocumentVersionSnapshot }>;
  getDocument(documentId: string): Promise<DocumentSnapshot | null>;
  listDocuments(input: { projectId: string; buildingId?: string; apartmentId?: string; folderId?: string; status?: DocumentStatus; cursor?: string; take: number }): Promise<{ items: DocumentSnapshot[]; nextCursor?: string }>;
  setSingleUploadVersion(input: { documentId: string; versionId: string; providerUploadId?: string }): Promise<DocumentVersionSnapshot>;
  setMultipartUpload(input: { documentId: string; versionId: string; providerUploadId: string; partSizeBytes: number; expiresAt: Date }): Promise<DocumentVersionSnapshot>;
  getVersion(documentId: string, versionId: string): Promise<DocumentVersionSnapshot | null>;
  saveMultipartParts(input: { documentId: string; versionId: string; parts: Array<{ partNumber: number; etag: string; checksumSha256?: string; sizeBytes: number }> }): Promise<void>;
  getMultipartParts(documentId: string, versionId: string): Promise<Array<{ partNumber: number; etag: string; checksumSha256?: string; sizeBytes: number }>>;
  markVersionAvailable(input: { documentId: string; versionId: string; sizeBytes: number; checksumSha256: string; etag?: string; correlationId: string; actorUserId: string }): Promise<DocumentVersionSnapshot>;
  markVersionFailed(input: { documentId: string; versionId: string; reason: string; actorUserId: string; correlationId: string }): Promise<void>;
  markMultipartCompleted(documentId: string, versionId: string): Promise<void>;
  abortMultipart(documentId: string, versionId: string): Promise<void>;
  getPolicies(documentId: string, folderId?: string): Promise<AccessPolicySnapshot[]>;
  createPolicy(input: { documentId?: string; folderId?: string; projectId: string; buildingId?: string; apartmentId?: string; principalType: 'USER' | 'ROLE' | 'RESIDENT'; principalId?: string; permission: DocumentPermission; effect: 'ALLOW' | 'DENY'; actorUserId: string; correlationId: string }): Promise<AccessPolicySnapshot>;
}

export interface IamAuthorizationClient {
  verifyPermission(input: { context: DocumentContext; permission: string; buildingId?: string; apartmentId?: string }): Promise<{ allowed: boolean; reason: string; authorizationVersion: string }>;
}

export interface ObjectStorage {
  createUploadUrl(input: { objectKey: string; mimeType: string; sizeBytes: number; sha256: string; expiresInSeconds: number }): Promise<{ url: string; headers: Record<string, string> }>;
  createMultipart(input: { objectKey: string; mimeType: string; sha256: string; expiresInSeconds: number }): Promise<{ providerUploadId: string; expiresAt: Date }>;
  createPartUploadUrl(input: { objectKey: string; providerUploadId: string; partNumber: number; checksumSha256?: string; expiresInSeconds: number }): Promise<{ url: string; headers: Record<string, string> }>;
  completeMultipart(input: { objectKey: string; providerUploadId: string; parts: Array<{ partNumber: number; etag: string; checksumSha256?: string }>; sha256: string }): Promise<{ etag?: string; checksumSha256?: string }>;
  abortMultipart(input: { objectKey: string; providerUploadId: string }): Promise<void>;
  head(input: { objectKey: string }): Promise<{ sizeBytes: number; mimeType?: string; etag?: string; checksumSha256?: string }>;
  readMagicBytes(objectKey: string): Promise<Uint8Array>;
  createDownloadUrl(input: { objectKey: string; fileName: string; expiresInSeconds: number }): Promise<string>;
}

export interface DocumentAccessCache {
  get(key: string): Promise<boolean | undefined>;
  set(key: string, value: boolean, ttlSeconds: number): Promise<void>;
}
