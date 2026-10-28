import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { OnModuleDestroy } from '@nestjs/common';
import { ObjectStorage } from '../../application/ports';

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function contentDisposition(fileName: string): string {
  const safe = fileName.replace(/["\\\r\n]/gu, '_');
  return `attachment; filename="${safe}"`;
}

export class S3ObjectStorage implements ObjectStorage, OnModuleDestroy {
  private readonly bucket = requiredEnv('DOCUMENT_DMS_S3_BUCKET');
  private readonly client: S3Client;

  constructor() {
    this.client = new S3Client({
      region: process.env.DOCUMENT_DMS_S3_REGION ?? 'us-east-1',
      endpoint: process.env.DOCUMENT_DMS_S3_ENDPOINT,
      forcePathStyle: process.env.DOCUMENT_DMS_S3_FORCE_PATH_STYLE === 'true',
      credentials: process.env.DOCUMENT_DMS_S3_ACCESS_KEY_ID && process.env.DOCUMENT_DMS_S3_SECRET_ACCESS_KEY
        ? { accessKeyId: process.env.DOCUMENT_DMS_S3_ACCESS_KEY_ID, secretAccessKey: process.env.DOCUMENT_DMS_S3_SECRET_ACCESS_KEY }
        : undefined,
    });
  }

  async createUploadUrl(input: { objectKey: string; mimeType: string; sizeBytes: number; sha256: string; expiresInSeconds: number }) {
    const command = new PutObjectCommand({ Bucket: this.bucket, Key: input.objectKey, ContentType: input.mimeType, ContentLength: input.sizeBytes, ChecksumSHA256: Buffer.from(input.sha256, 'hex').toString('base64'), Metadata: { 'document-sha256': input.sha256 } });
    return { url: await getSignedUrl(this.client, command, { expiresIn: input.expiresInSeconds }), headers: { 'content-type': input.mimeType, 'content-length': String(input.sizeBytes), 'x-amz-checksum-sha256': Buffer.from(input.sha256, 'hex').toString('base64') } };
  }

  async createMultipart(input: { objectKey: string; mimeType: string; sha256: string; expiresInSeconds: number }) {
    const result = await this.client.send(new CreateMultipartUploadCommand({ Bucket: this.bucket, Key: input.objectKey, ContentType: input.mimeType, ChecksumAlgorithm: 'SHA256', Metadata: { 'document-sha256': input.sha256 } }));
    if (!result.UploadId) throw new Error('Object storage did not return a multipart upload ID');
    return { providerUploadId: result.UploadId, expiresAt: new Date(Date.now() + input.expiresInSeconds * 1000) };
  }

  async createPartUploadUrl(input: { objectKey: string; providerUploadId: string; partNumber: number; checksumSha256?: string; expiresInSeconds: number }) {
    if (!Number.isInteger(input.partNumber) || input.partNumber < 1 || input.partNumber > 10_000) throw new Error('Multipart part number is invalid');
    const command = new UploadPartCommand({ Bucket: this.bucket, Key: input.objectKey, UploadId: input.providerUploadId, PartNumber: input.partNumber, ChecksumSHA256: input.checksumSha256 ? Buffer.from(input.checksumSha256, 'hex').toString('base64') : undefined });
    return { url: await getSignedUrl(this.client, command, { expiresIn: input.expiresInSeconds }), headers: input.checksumSha256 ? { 'x-amz-checksum-sha256': Buffer.from(input.checksumSha256, 'hex').toString('base64') } : {} };
  }

  async completeMultipart(input: { objectKey: string; providerUploadId: string; parts: Array<{ partNumber: number; etag: string; checksumSha256?: string }>; sha256: string }) {
    const result = await this.client.send(new CompleteMultipartUploadCommand({ Bucket: this.bucket, Key: input.objectKey, UploadId: input.providerUploadId, ChecksumSHA256: Buffer.from(input.sha256, 'hex').toString('base64'), MultipartUpload: { Parts: input.parts.sort((left, right) => left.partNumber - right.partNumber).map((part) => ({ PartNumber: part.partNumber, ETag: part.etag, ChecksumSHA256: part.checksumSha256 ? Buffer.from(part.checksumSha256, 'hex').toString('base64') : undefined })) } }));
    return { etag: result.ETag, checksumSha256: result.ChecksumSHA256 };
  }

  async abortMultipart(input: { objectKey: string; providerUploadId: string }): Promise<void> {
    await this.client.send(new AbortMultipartUploadCommand({ Bucket: this.bucket, Key: input.objectKey, UploadId: input.providerUploadId }));
  }

  async head(input: { objectKey: string }) {
    const result = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: input.objectKey, ChecksumMode: 'ENABLED' }));
    return { sizeBytes: Number(result.ContentLength ?? 0), mimeType: result.ContentType, etag: result.ETag, checksumSha256: result.ChecksumSHA256 ? Buffer.from(result.ChecksumSHA256, 'base64').toString('hex') : undefined };
  }

  async readMagicBytes(objectKey: string): Promise<Uint8Array> {
    const result = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: objectKey, Range: 'bytes=0-63' }));
    if (!result.Body) throw new Error('Object storage returned an empty object body');
    return result.Body.transformToByteArray();
  }

  async createDownloadUrl(input: { objectKey: string; fileName: string; expiresInSeconds: number }): Promise<string> {
    return getSignedUrl(this.client, new GetObjectCommand({ Bucket: this.bucket, Key: input.objectKey, ResponseContentDisposition: contentDisposition(input.fileName) }), { expiresIn: input.expiresInSeconds });
  }

  onModuleDestroy(): void {
    this.client.destroy();
  }
}
