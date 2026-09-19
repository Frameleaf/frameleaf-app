import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import path from 'node:path';
import { ChecksumAlgorithm } from 'src/enum.js';

export function encryptICloudSession(key: Buffer, connectionId: string, value: unknown): string {
  if (key.length !== 32) {
    throw new Error('icloud_key_invalid');
  }
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(`icloud:v1:${connectionId}`));
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
  return Buffer.concat([nonce, cipher.getAuthTag(), encrypted]).toString('base64');
}

export function decryptICloudSession(key: Buffer, connectionId: string, value: string): unknown {
  if (key.length !== 32) {
    throw new Error('icloud_key_invalid');
  }
  try {
    const bytes = Buffer.from(value, 'base64');
    if (bytes.length < 29) {
      throw new Error('icloud_session_invalid');
    }
    const cipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
    cipher.setAAD(Buffer.from(`icloud:v1:${connectionId}`));
    cipher.setAuthTag(bytes.subarray(12, 28));
    return JSON.parse(Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString());
  } catch {
    throw new Error('icloud_session_invalid');
  }
}

export function isWithinDirectory(candidate: string, root: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

export function matchesContentHash(
  target: { checksum: Buffer; checksumAlgorithm: ChecksumAlgorithm; sha1?: Buffer | null; sha256?: Buffer | null },
  staged: { sha1: Buffer; sha256: Buffer },
): boolean {
  return (
    (target.checksumAlgorithm === ChecksumAlgorithm.sha1File && target.checksum.equals(staged.sha1)) ||
    (target.checksumAlgorithm === ChecksumAlgorithm.sha256File && target.checksum.equals(staged.sha256)) ||
    !!target.sha1?.equals(staged.sha1) ||
    !!target.sha256?.equals(staged.sha256)
  );
}
