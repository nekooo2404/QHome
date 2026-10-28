import { createHash } from 'node:crypto';

const MIME_ALIASES: Record<string, string> = {
  'application/x-pdf': 'application/pdf',
  'image/jpg': 'image/jpeg',
};

const SUPPORTED_MIME = new Set([
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/webp',
  'application/zip',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/msword',
  'text/plain',
]);

export function normalizeMimeType(value: string): string {
  const normalized = value.trim().toLowerCase();
  const canonical = MIME_ALIASES[normalized] ?? normalized;
  if (!SUPPORTED_MIME.has(canonical)) throw new Error('Unsupported document MIME type');
  return canonical;
}

export function normalizeSha256(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/u.test(normalized)) throw new Error('SHA-256 checksum must be 64 hexadecimal characters');
  return normalized;
}

export function normalizeFileName(value: string): string {
  const normalized = value.normalize('NFKC').trim();
  if (!normalized || normalized.length > 512 || normalized.includes('\u0000') || /[\\/]/u.test(normalized) || normalized === '.' || normalized === '..') throw new Error('Invalid document file name');
  return normalized;
}

export function assertFileSize(sizeBytes: number): void {
  const maxBytes = Number(process.env.DOCUMENT_DMS_MAX_FILE_SIZE_BYTES ?? 5 * 1024 * 1024 * 1024);
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes <= 0 || sizeBytes > maxBytes) throw new Error('Document size is outside the allowed range');
}

function startsWithBytes(bytes: Uint8Array, signature: number[]): boolean {
  return signature.every((value, index) => bytes[index] === value);
}

export function assertMagicBytes(mimeType: string, bytes: Uint8Array): void {
  const mime = normalizeMimeType(mimeType);
  if (mime === 'text/plain') {
    const sample = Buffer.from(bytes).toString('utf8');
    if (/\u0000/u.test(sample)) throw new Error('Text document contains binary content');
    return;
  }
  if (mime === 'application/pdf' && startsWithBytes(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) return;
  if (mime === 'image/png' && startsWithBytes(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return;
  if (mime === 'image/jpeg' && startsWithBytes(bytes, [0xff, 0xd8, 0xff])) return;
  if (mime === 'image/webp' && startsWithBytes(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWithBytes(bytes.slice(8), [0x57, 0x45, 0x42, 0x50])) return;
  if (['application/zip', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'].includes(mime) && startsWithBytes(bytes, [0x50, 0x4b, 0x03, 0x04])) return;
  if (mime === 'application/msword' && startsWithBytes(bytes, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) return;
  throw new Error('File magic bytes do not match the declared MIME type');
}

export function verifySha256(expected: string, actual: string | undefined): void {
  const normalizedExpected = normalizeSha256(expected);
  if (!actual || normalizeSha256(actual) !== normalizedExpected) throw new Error('Object SHA-256 checksum does not match the declared checksum');
}

export function contentHash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
