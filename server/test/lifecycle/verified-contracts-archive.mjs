import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

export function extractVerifiedContractsArchive(archivePath, receipt, staging) {
  const bytes = readFileSync(archivePath);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
  if (bytes.length !== receipt.bytes || sha256 !== receipt.sha256 || integrity !== receipt.integrity) {
    throw new Error('Cloud contracts archive does not match the pinned receipt');
  }
  // Tar consumes the exact verified buffer; it never reopens the mutable source path.
  const extracted = spawnSync('tar', ['-xzf', '-', '-C', staging], { input: bytes, stdio: 'pipe' });
  if (extracted.status !== 0) throw new Error('Verified Cloud contracts archive could not be extracted');
}
