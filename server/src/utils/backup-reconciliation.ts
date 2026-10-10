import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import {
  MAX_BUCKET_HASHES,
  ReconciliationBucketSchema,
  ReconciliationStartSchema,
  Sha256Schema,
} from 'src/dtos/backup-device.dto.js';
import { hasHiddenContentFilter } from 'src/utils/hidden-content.js';

export type BucketDigest = { count: number; digest: string };
export type ReconciliationProgress = {
  client: BucketDigest[];
  server: BucketDigest[];
  completed: number[];
  differing: number[];
};
export function requireReconciliationScope(auth: AuthDto) {
  if (
    auth.sharedLink ||
    !auth.session?.hasElevatedPermission ||
    auth.hideNsfwAssets ||
    hasHiddenContentFilter(auth.hiddenContent)
  ) {
    throw new ForbiddenException('Reconciliation requires an elevated session without hidden-content filters');
  }
}
export function hashBucket(hashes: string[]): BucketDigest {
  if (hashes.some((hash) => !Sha256Schema.safeParse(hash).success))
    throw new BadRequestException('Invalid SHA256 original identity');
  const sorted = [...new Set(hashes.map((hash) => hash.toLowerCase()))].sort();
  // ponytail: Complete buckets keep the protocol bounded. Upgrade to durable staged pagination when a real device exceeds2000; distribution is not a guarantee.
  if (sorted.length > MAX_BUCKET_HASHES) throw new BadRequestException('Bucket exceeds2000 unique hashes');
  const hash = createHash('sha256');
  for (const value of sorted) hash.update(Buffer.from(value, 'hex'));
  return { count: sorted.length, digest: hash.digest('hex') };
}
export function bucketInventory(hashes: string[]): BucketDigest[] {
  const buckets: string[][] = Array.from({ length: 256 }, () => []);
  for (const hash of hashes) buckets[Number.parseInt(hash.slice(0, 2), 16)].push(hash);
  return buckets.map((hashes) => hashBucket(hashes));
}
export function startProgress(input: unknown, server: BucketDigest[]): ReconciliationProgress {
  const parsed = ReconciliationStartSchema.safeParse(input);
  if (!parsed.success) throw new BadRequestException('Invalid256 bucket digest/count inventory');
  const client = parsed.data.buckets;
  const differing: number[] = [];
  for (let i = 0; i < 256; i++) {
    if (client[i].digest === server[i].digest && client[i].count !== server[i].count)
      throw new BadRequestException('Digest/count mismatch');
    if (client[i].digest !== server[i].digest) differing.push(i);
  }
  return { client, server, differing, completed: [] };
}
export function validateBucket(input: unknown, progress: ReconciliationProgress) {
  const parsed = ReconciliationBucketSchema.safeParse(input);
  if (!parsed.success) throw new BadRequestException('Invalid bucket hashes');
  const { bucket, hashes } = parsed.data;
  if (
    !progress.differing.includes(bucket) ||
    new Set(hashes).size !== hashes.length ||
    hashes.some((hash) => Number.parseInt(hash.slice(0, 2), 16) !== bucket)
  )
    throw new BadRequestException('Invalid or duplicate bucket membership');
  const measured = hashBucket(hashes);
  if (measured.count !== progress.client[bucket].count || measured.digest !== progress.client[bucket].digest)
    throw new BadRequestException('Bucket digest/count mismatch');
  return { bucket, hashes };
}
export function assertInventoryUnchanged(progress: ReconciliationProgress, current: BucketDigest[]) {
  if (JSON.stringify(current) !== JSON.stringify(progress.server))
    throw new BadRequestException('Server inventory changed; start a new reconciliation');
}
