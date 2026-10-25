import { join } from 'node:path';
import type { RestoreJob } from 'src/services/buddy-backup-restore.service.js';
import type { BuddyReferenceAdoption } from 'src/utils/buddy-reference-adoption.js';
import { BUDDY_UUID } from 'src/utils/buddy-backup-crypto.js';
import { readBuddyFile, writeBuddyFile } from 'src/utils/buddy-backup-vault.js';
import { canonicalJson } from 'src/utils/object.js';

export type BuddyReferenceRestoreIntent = {
  version: 1;
  operationId: string;
  snapshotId: string;
  vaultId: string;
  keyFingerprint: string;
  manifestHash: string;
  mode: 'keep' | 'replace';
  adoption: BuddyReferenceAdoption;
};

export function buddyReferenceIntent(
  operationId: string,
  job: RestoreJob,
  assetId: string,
): BuddyReferenceRestoreIntent | undefined {
  const adoption = job.referenceAdoptions?.[assetId];
  if (!adoption) return;
  return {
    version: 1,
    operationId,
    snapshotId: job.request.snapshotId,
    vaultId: job.vaultId,
    keyFingerprint: job.fingerprint,
    manifestHash: job.manifestHash,
    mode: job.request.mode,
    adoption,
  };
}

/** Mirror the immutable submitted plan; a retained journal is never a reason to replace it. */
export async function loadBuddyReferenceIntent(root: string, expected: BuddyReferenceRestoreIntent) {
  if (!BUDDY_UUID.test(expected.operationId) || !BUDDY_UUID.test(expected.adoption.assetId))
    throw new Error('Invalid reference restore intent identity');
  const path = join(root, 'restores', expected.operationId, 'adoptions', `${expected.adoption.assetId}.json`);
  let bytes: Buffer;
  try {
    bytes = await readBuddyFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    await writeBuddyFile(path, canonicalJson(expected), true);
    bytes = await readBuddyFile(path);
  }
  if (canonicalJson(JSON.parse(bytes.toString('utf8'))) !== canonicalJson(expected))
    throw new Error('Buddy reference restore intent changed');
  return expected;
}
