import { NotFoundException, PayloadTooLargeException } from '@nestjs/common';
import { type Kysely, sql } from 'kysely';
import type { DB } from 'src/schema/index.js';
import { MediaOperationKind } from 'src/enum.js';
import { STUDIO_BUNDLE_MAX_BYTES, STUDIO_BUNDLE_MAX_JSON_BYTES } from 'src/utils/studio-bundle.js';

export const STUDIO_BUNDLE_MAX_UPLOADS = 8;
export const STUDIO_BUNDLE_MAX_EXPORTS = 4;
export const STUDIO_BUNDLE_OWNER_BYTES = 16 * 1024 ** 3;
export const STUDIO_REVISION_MAX_COUNT = 1000;
export const STUDIO_REVISION_MAX_BYTES = 256 * 1024 ** 2;
// Reserve the ZIP plus its document staging until the worker publishes or removes its output.
export const STUDIO_BUNDLE_DOCUMENT_RESERVATION = 2 * STUDIO_BUNDLE_MAX_JSON_BYTES;
export const STUDIO_BUNDLE_EXPORT_RESERVATION = STUDIO_BUNDLE_MAX_BYTES + STUDIO_BUNDLE_DOCUMENT_RESERVATION;

/** Serialize all Studio storage admissions on the owner, including imports and document history. */
export async function assertStudioStorageAdmission(
  db: Kysely<DB>,
  ownerId: string,
  bytes: number,
  kind?: 'upload' | 'export',
): Promise<void> {
  if (!db.isTransaction) throw new Error('studio_storage_transaction_required');
  if (!Number.isSafeInteger(bytes) || bytes < 0) throw new PayloadTooLargeException('Invalid Studio storage size');
  const owner = await db
    .selectFrom('user')
    .select(['quotaSizeInBytes', 'quotaUsageInBytes'])
    .where('id', '=', ownerId)
    .where('deletedAt', 'is', null)
    .forUpdate()
    .executeTakeFirst();
  if (!owner) throw new NotFoundException('Studio owner not found');
  if (bytes === 0 && !kind) return;
  const {
    rows: [used],
  } = await sql<{ uploads: number; exports: number; bundles: number; imports: number; revisions: number }>`
    WITH uploads AS (SELECT count(*)::int AS count, coalesce(sum("sizeBytes"),0)::float8 AS bytes
      FROM studio_bundle_upload WHERE "ownerId"=${ownerId}::uuid),
    exports AS (SELECT count(*)::int AS count,
      coalesce(sum(CASE WHEN status='completed' AND result->>'sizeBytes' ~ '^[0-9]+$' THEN (result->>'sizeBytes')::bigint
        ELSE coalesce((settings->>'storageReservationBytes')::bigint, ${STUDIO_BUNDLE_EXPORT_RESERVATION}) END),0)::float8 AS bytes
      FROM media_operation WHERE "ownerId"=${ownerId}::uuid AND kind=${MediaOperationKind.StudioBundleExport}
        AND result->>'storageReleased' IS DISTINCT FROM 'true' AND result->>'expiredAt' IS NULL),
    imports AS (SELECT coalesce(sum("sizeBytes"),0)::float8 AS bytes FROM studio_project_import WHERE "ownerId"=${ownerId}::uuid),
    revisions AS (SELECT coalesce(sum(r."graphBytes"),0)::float8 AS bytes FROM studio_project_revision r
      JOIN studio_project p ON p.id=r."projectId" WHERE p."ownerId"=${ownerId}::uuid)
    SELECT uploads.count AS uploads, exports.count AS exports, uploads.bytes+exports.bytes AS bundles,
      imports.bytes AS imports, revisions.bytes AS revisions FROM uploads,exports,imports,revisions`.execute(db);
  if (
    (kind === 'upload' && used.uploads >= STUDIO_BUNDLE_MAX_UPLOADS) ||
    (kind === 'export' && used.exports >= STUDIO_BUNDLE_MAX_EXPORTS) ||
    (kind && used.bundles + bytes > STUDIO_BUNDLE_OWNER_BYTES)
  ) {
    throw new PayloadTooLargeException(
      'Studio bundle storage limit reached; discard uploads or wait for exports to expire',
    );
  }
  if (
    owner.quotaSizeInBytes !== null &&
    Number(owner.quotaUsageInBytes) + used.bundles + used.imports + used.revisions + bytes >
      Number(owner.quotaSizeInBytes)
  ) {
    throw new PayloadTooLargeException('This file would take you over your storage quota');
  }
}
