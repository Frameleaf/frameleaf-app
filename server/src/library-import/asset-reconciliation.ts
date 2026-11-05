import { createHash } from 'node:crypto';
import { AssetLockReason } from 'src/enum.js';
import { ImportDatabase } from 'src/immich-import/types.js';
import { CanonicalAssetWriter } from 'src/library-import/asset-writer.js';
import { parseDestinationImportPlan } from 'src/library-import/destination-plan.js';
import { BundleVerificationError, verifyImportFiles } from 'src/library-import/files.js';
import { importsLocked, parseImportManifest, storedVisibility } from 'src/library-import/manifest.js';
import {
  LibraryImportBinding,
  LibraryImportJournal,
  LibraryImportRefused,
  parseLibraryImportBinding,
} from 'src/library-import/state.js';
import { reconcileImportedTags } from 'src/library-import/tags.js';
import { beginLibraryImportReadback } from 'src/library-import/verification.js';

const fingerprint = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const mismatch = (): never => {
  throw new LibraryImportRefused('ASSET_RECONCILIATION_MISMATCH');
};
const format = `'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'`;
const same = (expected: unknown, actual: unknown) => {
  if (JSON.stringify(expected) !== JSON.stringify(actual)) mismatch();
};

/** Photo/original evidence only; owner credentials, source qualification and activation need separate reconciliation. */
export async function reconcileImportedAssets(
  db: ImportDatabase,
  context: { binding: LibraryImportBinding; manifest: unknown; plan: unknown; destinationId: string },
  inputs: unknown,
) {
  const binding = parseLibraryImportBinding(context.binding);
  const writer = new CanonicalAssetWriter(db, context);
  const manifest = parseImportManifest(context.manifest);
  const plan = parseDestinationImportPlan(context.plan);
  if (!Array.isArray(inputs) || inputs.length !== manifest.assets.length) return mismatch();
  const prepared = inputs.map((input) => writer.prepare(input));
  if (new Set(prepared.map((photo) => photo.asset.id)).size !== manifest.assets.length) mismatch();
  try {
    return await db.transaction(async (tx) => {
      await beginLibraryImportReadback(tx);
      const { run } = await new LibraryImportJournal(tx).status();
      if (!run || JSON.stringify(run.binding) !== JSON.stringify(binding))
        throw new LibraryImportRefused('IMPORT_BINDING_CHANGED');
      if (run.status !== 'verifying') throw new LibraryImportRefused('IMPORT_NOT_VERIFYING');
      const mappings = await tx.query(
        `SELECT source_id,destination_id::text,record_sha256 FROM public.frameleaf_library_import_mapping
        WHERE operation_id=$1::uuid AND entity_kind='asset'`,
        [binding.operationId],
      );
      const mapped = new Map(mappings.map((row) => [row.source_id, row]));
      if (mapped.size !== prepared.length) mismatch();
      const expected = prepared
        .map((photo) => {
          const mapping = mapped.get(photo.asset.id);
          if (!mapping || mapping.record_sha256 !== photo.recordSha256) return mismatch();
          return { ...photo, id: mapping.destination_id };
        })
        .sort((a, b) => String(a.id).localeCompare(String(b.id)));
      const stackIds = new Map<unknown, string>();
      if ('stacks' in manifest) {
        const rows = await tx.query(
          `SELECT source_id,destination_id::text,record_sha256 FROM public.frameleaf_library_import_mapping
          WHERE operation_id=$1::uuid AND entity_kind='stack'`,
          [binding.operationId],
        );
        const stacks = new Map(rows.map((row) => [row.source_id, row]));
        if (rows.length !== manifest.stacks.length || stacks.size !== rows.length) mismatch();
        for (const stack of manifest.stacks) {
          const row = stacks.get(stack.id);
          if (!row || typeof row.destination_id !== 'string' || row.record_sha256 !== fingerprint(stack))
            return mismatch();
          for (const assetId of stack.assetIds) stackIds.set(mapped.get(assetId)!.destination_id, row.destination_id);
        }
      }
      const clocks = await tx.query(
        `SELECT p.id,to_char(p.taken::timestamptz AT TIME ZONE 'UTC',${format}) AS taken,
        to_char(p.modified::timestamptz AT TIME ZONE 'UTC',${format}) AS modified,
        to_char(COALESCE(p.local_clock::timestamp,p.taken::timestamptz AT TIME ZONE p.zone),${format}) AS local,
        to_char(p.deleted::timestamptz AT TIME ZONE 'UTC',${format}) AS deleted
        FROM jsonb_to_recordset($1::text::jsonb) AS p(id text,taken text,modified text,zone text,deleted text,local_clock text)`,
        [
          JSON.stringify(
            expected.map((photo) => ({
              id: photo.id,
              taken: photo.metadata.takenAt,
              modified: photo.item.fileModifiedAt,
              zone: photo.metadata.timeZone,
              local_clock: 'localDateTime' in photo.asset ? photo.asset.localDateTime : undefined,
              deleted: photo.metadata.deletedAt ?? null,
            })),
          ),
        ],
      );
      const byId = new Map(clocks.map((clock) => [clock.id, clock]));
      const livePhotos = new Map(
        (manifest.version === 5 ? manifest.livePhotos : []).map((pair) => [
          pair.photoAssetId,
          mapped.get(pair.videoAssetId)!.destination_id,
        ]),
      );
      const expectedPhotos = expected.map(({ id, item, asset, metadata, ownerId, primary }) => ({
        id,
        ownerId,
        type: item.type,
        originalPath: primary.absolutePath,
        physicalPath: primary.absolutePath,
        checksum: primary.sha256,
        checksumAlgorithm: 'sha256',
        fileCreatedAt: byId.get(id)!.taken,
        localDateTime: byId.get(id)!.local,
        fileModifiedAt: byId.get(id)!.modified,
        originalFileName: primary.name,
        isFavorite: metadata.favorite ?? false,
        visibility: storedVisibility(asset),
        status: asset.visibility === 'trash' ? 'trashed' : 'active',
        deletedAt: byId.get(id)!.deleted,
        libraryScope: 'personal',
        libraryId: null,
        libraryPath: null,
        isExternal: false,
        isOffline: false,
        livePhotoVideoId: livePhotos.get(asset.id) ?? null,
        stackId: stackIds.get(id) ?? null,
        duplicateId: null,
        isEdited: false,
        ownerEligible: true,
        exif: {
          fileSizeInByte: primary.bytes,
          dateTimeOriginal: byId.get(id)!.taken,
          timeZone: metadata.timeZone ?? null,
          description: metadata.description ?? '',
          rating: metadata.rating ?? null,
          latitude: metadata.latitude ?? null,
          longitude: metadata.longitude ?? null,
          tags: metadata.tags ?? null,
          lockedProperties: [
            'dateTimeOriginal',
            'timeZone',
            ...(['description', 'rating', 'latitude', 'longitude', 'tags'] as const).filter(
              (key) => metadata[key] !== undefined,
            ),
          ].sort(),
        },
      }));
      const actualPhotos = await tx.query(
        `SELECT a.id::text,a."ownerId"::text,a.type,a."originalPath",p.path AS "physicalPath",
        encode(a.checksum,'hex') AS checksum,a."checksumAlgorithm",
        to_char(a."fileCreatedAt" AT TIME ZONE 'UTC',${format}) AS "fileCreatedAt",
        to_char(a."localDateTime" AT TIME ZONE 'UTC',${format}) AS "localDateTime",
        to_char(a."fileModifiedAt" AT TIME ZONE 'UTC',${format}) AS "fileModifiedAt",
        a."originalFileName",a."isFavorite",a.visibility,a.status,
        to_char(a."deletedAt" AT TIME ZONE 'UTC',${format}) AS "deletedAt",
        a."libraryScope",a."libraryId"::text,a."libraryPath",a."isExternal",a."isOffline",
        a."livePhotoVideoId"::text,a."stackId"::text,a."duplicateId"::text,a."isEdited",
        (u.status='active' AND u."deletedAt" IS NULL AND NOT u."isAdmin") AS "ownerEligible",
        CASE WHEN e."assetId" IS NULL THEN NULL ELSE jsonb_build_object(
          'fileSizeInByte',e."fileSizeInByte"::text,'dateTimeOriginal',to_char(e."dateTimeOriginal" AT TIME ZONE 'UTC',${format}),
          'timeZone',e."timeZone",'description',e.description,'rating',e.rating,'latitude',e.latitude,'longitude',e.longitude,'tags',e.tags,
          'lockedProperties',ARRAY(SELECT unnest(e."lockedProperties") ORDER BY 1)) END AS exif
        FROM public.asset a LEFT JOIN public.physical_file p ON p.id=a."physicalOriginalFileId"
        LEFT JOIN public.asset_exif e ON e."assetId"=a.id LEFT JOIN public."user" u ON u.id=a."ownerId" ORDER BY a.id`,
      );
      // JSONB key order differs from JavaScript objects, so compare EXIF by named fields.
      for (const photo of actualPhotos) {
        const exif = photo.exif as Record<string, unknown> | null;
        if (exif)
          photo.exif = Object.fromEntries(Object.keys(expectedPhotos[0]?.exif ?? {}).map((key) => [key, exif[key]]));
      }
      same(expectedPhotos, actualPhotos);
      const expectedFiles = expected
        .flatMap(({ id, files }) =>
          files
            .filter((file) => file.role === 'original')
            .map((file) => ({
              canonicalAssetId: id,
              type: 'original',
              checksum: file.sha256,
              sizeInBytes: file.bytes,
              path: file.absolutePath,
            })),
        )
        .sort((a, b) => a.path.localeCompare(b.path));
      const actualFiles = await tx.query(`SELECT "canonicalAssetId"::text,type,encode(checksum,'hex') AS checksum,
        "sizeInBytes"::text,path FROM public.physical_file ORDER BY path COLLATE "C"`);
      actualFiles.sort((a, b) => String(a.path).localeCompare(String(b.path)));
      same(expectedFiles, actualFiles);
      if (plan.version === 2) {
        const placements = await tx.query(
          `SELECT m.source_id,m.record_sha256,p.path,p."canonicalAssetId"::text AS asset_id,
          f.path AS sidecar_path,f."assetId"::text AS sidecar_asset_id,f.type AS sidecar_type
          FROM public.frameleaf_library_import_mapping m LEFT JOIN public.physical_file p ON p.id=m.destination_id
          LEFT JOIN public.asset_file f ON f.id=m.destination_id
          WHERE m.operation_id=$1::uuid AND m.entity_kind='file'`,
          [binding.operationId],
        );
        const byPlacement = new Map(placements.map((row) => [row.source_id, row]));
        if (placements.length !== plan.files.length || byPlacement.size !== placements.length) mismatch();
        for (const photo of expected)
          for (const file of photo.files) {
            const row = byPlacement.get(file.transferId);
            if (
              !row ||
              row.record_sha256 !== file.transferSha256 ||
              (file.role === 'original'
                ? row.path !== file.absolutePath || row.asset_id !== photo.id || row.sidecar_path !== null
                : row.sidecar_path !== file.absolutePath ||
                  row.sidecar_asset_id !== photo.id ||
                  row.sidecar_type !== 'sidecar' ||
                  row.path !== null)
            )
              mismatch();
          }
      }
      const expectedAdditional = expected
        .flatMap(({ id, primary, files }) =>
          files
            .filter((file) => file.role === 'original' && file.id !== primary.id)
            .map((file) => ({ assetId: id, path: file.absolutePath, originalFileName: file.name })),
        )
        .sort((a, b) => String(a.assetId).localeCompare(String(b.assetId)) || a.path.localeCompare(b.path));
      const actualAdditional = await tx.query(`SELECT o."assetId"::text,p.path,o."originalFileName"
        FROM public.asset_original o JOIN public.physical_file p ON p.id=o."physicalFileId"`);
      actualAdditional.sort(
        (a, b) => String(a.assetId).localeCompare(String(b.assetId)) || String(a.path).localeCompare(String(b.path)),
      );
      same(expectedAdditional, actualAdditional);
      const expectedSidecars = expected
        .flatMap(({ id, files }) =>
          files
            .filter((file) => file.role === 'sidecar')
            .map((file) => ({
              assetId: id,
              type: 'sidecar',
              path: file.absolutePath,
              physicalFileId: null,
              isEdited: false,
            })),
        )
        .sort((a, b) => String(a.assetId).localeCompare(String(b.assetId)));
      const actualSidecars = await tx.query(`SELECT "assetId"::text,type,path,"physicalFileId"::text,"isEdited"
        FROM public.asset_file ORDER BY "assetId"`);
      same(expectedSidecars, actualSidecars);
      // Owner 2026-11-04: exactly the source's private items are Locked, each Live Photo as a whole.
      const expectedLocks = expected
        .filter(({ asset }) => importsLocked(asset))
        .flatMap(({ id, asset }) => [id, livePhotos.get(asset.id)].filter((lock) => lock !== undefined))
        .map(String)
        .sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
        .map((assetId) => ({
          assetId,
          reason: AssetLockReason.Marked,
          lockedBy: null,
          previousVisibility: null,
          inherited: false,
          pendingUnlockAt: null,
        }));
      const actualLocks = await tx.query(`SELECT "assetId"::text,reason,"lockedBy"::text,"previousVisibility"::text,
        inherited,"pendingUnlockAt" FROM public.asset_lock ORDER BY "assetId"::text COLLATE "C"`);
      same(expectedLocks, actualLocks);
      const quota = new Map<string, bigint>();
      for (const photo of expected) quota.set(photo.ownerId, (quota.get(photo.ownerId) ?? 0n) + photo.bytes);
      const ownerMappings = await tx.query(
        `SELECT source_id,destination_id::text
        FROM public.frameleaf_library_import_mapping WHERE operation_id=$1::uuid AND entity_kind='owner'`,
        [binding.operationId],
      );
      const plannedOwners = new Map(plan.owners.map((owner) => [owner.sourceId, owner.destinationId.toLowerCase()]));
      if (
        ownerMappings.length !== plannedOwners.size ||
        ownerMappings.some((row) => plannedOwners.get(String(row.source_id)) !== row.destination_id)
      )
        mismatch();
      // Owners with no photos must also retain zero usage.
      for (const id of plannedOwners.values()) if (!quota.has(id)) quota.set(id, 0n);
      const owners = await tx.query(
        `SELECT id::text,"quotaUsageInBytes"::text AS bytes,
        (status='active' AND "deletedAt" IS NULL AND NOT "isAdmin") AS eligible
        FROM public."user" WHERE id=ANY($1::uuid[])`,
        [quota.keys().toArray()],
      );
      if (
        owners.length !== quota.size ||
        owners.some((owner) => owner.eligible !== true || owner.bytes !== String(quota.get(String(owner.id))))
      )
        mismatch();
      const tags = await reconcileImportedTags(
        tx,
        expected.map(({ id, ownerId, metadata }) => ({ id: String(id), ownerId, tags: metadata.tags })),
      );
      let bytes = 0n;
      const destinationIdentities = new Set<string>();
      for (const files of Map.groupBy(
        expected.flatMap((photo) => photo.files),
        (file) => file.root.id,
      ).values()) {
        const root = files[0].root;
        const result = await verifyImportFiles(
          root.path,
          files.map(({ id, transferId, path, bytes, sha256, role }) => ({
            id: transferId ?? id,
            path,
            bytes,
            sha256,
            role,
          })),
          { device: root.device, inode: root.inode },
          destinationIdentities,
        );
        const expectedBytes = files.reduce((total, file) => total + BigInt(file.bytes), 0n);
        if (result.files !== files.length || result.bytes !== String(expectedBytes)) mismatch();
        bytes += expectedBytes;
      }
      return {
        format: 'frameleaf-asset-reconciliation' as const,
        version: 2 as const,
        operationId: binding.operationId,
        manifestSha256: binding.manifestSha256,
        planSha256: binding.planSha256,
        assets: actualPhotos.length,
        originals: actualFiles.length,
        ...(actualSidecars.length > 0 ? { sidecars: actualSidecars.length } : {}),
        tagNodes: tags.nodes.length,
        tagAssignments: tags.memberships.length,
        bytes: String(bytes),
        sha256: fingerprint({
          photos: actualPhotos,
          files: actualFiles,
          additional: actualAdditional,
          ...(actualSidecars.length > 0 ? { sidecars: actualSidecars } : {}),
          tags,
          quotas: owners.sort((a, b) => String(a.id).localeCompare(String(b.id))),
        }),
      };
    });
  } catch (error) {
    if (error instanceof LibraryImportRefused) throw error;
    if (error instanceof BundleVerificationError) throw new LibraryImportRefused(error.code);
    // Driver diagnostics may contain private media metadata and host paths.
    throw new LibraryImportRefused('ASSET_RECONCILIATION_FAILED');
  }
}
