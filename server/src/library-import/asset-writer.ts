import { createHash, randomUUID } from 'node:crypto';
import { posix } from 'node:path';
import { z } from 'zod';
import { AssetLockReason } from 'src/enum.js';
import { ImportDatabase } from 'src/immich-import/types.js';
import { DestinationImportPlan, bindDestinationImportPlan } from 'src/library-import/destination-plan.js';
import { BundleVerificationError, verifyImportFiles } from 'src/library-import/files.js';
import {
  ImportManifest,
  importOriginalFileNameSchema,
  importTimestampSchema as timestamp,
  parseImportManifest,
  storedVisibility,
} from 'src/library-import/manifest.js';
import { LibraryImportBinding, LibraryImportJournal, LibraryImportRefused } from 'src/library-import/state.js';
import { writeImportedTags } from 'src/library-import/tags.js';
import { BUDDY_CAPTURE_LOCK, filePathLockKey } from 'src/repositories/physical-file.repository.js';
import { normalizeTagValue } from 'src/utils/tag.js';

const itemSchema = z.strictObject({
  sourceAssetId: z.string().min(1).max(1024),
  type: z.enum(['IMAGE', 'VIDEO']),
  fileModifiedAt: timestamp,
  originalFileNames: z.record(z.string(), importOriginalFileNameSchema),
});
const refuse = (code: string): never => {
  throw new LibraryImportRefused(code);
};

/** Internal atomic writer; the controller must separately fence services, qualify sources and reconcile activation. */
export class CanonicalAssetWriter {
  private readonly binding: LibraryImportBinding;
  private readonly assets: Map<string, ImportManifest['assets'][number]>;
  private readonly sourceFiles: Map<string, ImportManifest['files'][number]>;
  private readonly plannedFiles: Map<string, DestinationImportPlan['files'][number]>;
  private readonly plan: DestinationImportPlan;
  private readonly livePhotos: Map<string, string>;
  constructor(
    private readonly db: ImportDatabase,
    context: {
      binding: LibraryImportBinding;
      manifest: unknown;
      plan: unknown;
      destinationId: string;
    },
  ) {
    this.binding = structuredClone(context.binding);
    this.plan = bindDestinationImportPlan(context.plan, this.binding, context.manifest, context.destinationId);
    const manifest = parseImportManifest(context.manifest);
    this.livePhotos = new Map(
      (manifest.version === 5 ? manifest.livePhotos : []).map((pair) => [pair.photoAssetId, pair.videoAssetId]),
    );
    this.assets = new Map(manifest.assets.map((asset) => [asset.id, asset]));
    this.sourceFiles = new Map(manifest.files.map((file) => [file.id, file]));
    this.plannedFiles = new Map(
      this.plan.files.map((file) => [
        'sourceAssetId' in file ? JSON.stringify([file.sourceAssetId, file.sourceFileId]) : file.id,
        file,
      ]),
    );
  }

  /** Validated intent shared with independent destination readback; performs no database or filesystem writes. */
  prepare(input: unknown) {
    const parsed = itemSchema.safeParse(input);
    if (!parsed.success) return refuse('ASSET_INPUT_INVALID');
    const item = parsed.data;
    const asset = this.assets.get(item.sourceAssetId);
    if (!asset) return refuse('ASSET_SOURCE_MISSING');
    if (
      'type' in asset &&
      (asset.type !== item.type ||
        asset.fileModifiedAt !== item.fileModifiedAt ||
        asset.fileIds.some((id) => asset.originalFileNames[id] !== item.originalFileNames[id]))
    )
      return refuse('ASSET_PREPARED_INTENT_CHANGED');
    const metadata = asset.metadata;
    const sourceFiles = asset.fileIds.map((id) => this.sourceFiles.get(id)!);
    const originals = sourceFiles.filter((file) => file.role === 'original');
    // shortcut: richer relationships require dedicated writers before this internal path can accept them.
    if (
      metadata.title !== undefined ||
      sourceFiles.some((file) => file.role === 'companion') ||
      sourceFiles.filter((file) => file.role === 'sidecar').length > 1
    )
      return refuse('ASSET_UNSUPPORTED_FIELDS');
    if (
      metadata.tags !== undefined &&
      (new Set(metadata.tags).size !== metadata.tags.length ||
        metadata.tags.some((tag) => !tag || tag.includes('\0') || normalizeTagValue(tag) !== tag))
    )
      return refuse('ASSET_TAGS_INVALID');
    if (
      !timestamp.safeParse(metadata.takenAt).success ||
      (!metadata.timeZone && !('localDateTime' in asset && asset.localDateTime))
    )
      return refuse('ASSET_CAPTURE_CLOCK_REQUIRED');
    if (
      (asset.visibility === 'trash') !== (metadata.deletedAt !== undefined) ||
      (metadata.deletedAt !== undefined && !timestamp.safeParse(metadata.deletedAt).success)
    )
      return refuse('ASSET_TRASH_STATE_INVALID');
    if (
      Object.keys(item.originalFileNames).length !== originals.length ||
      originals.some((file) => !Object.hasOwn(item.originalFileNames, file.id))
    )
      return refuse('ASSET_ORIGINAL_NAMES_REQUIRED');
    const ownerId = this.plan.owners.find((owner) => owner.sourceId === asset.ownerId)!.destinationId.toLowerCase();
    const files = sourceFiles.map((file) => {
      const planned = this.plannedFiles.get(this.plan.version === 2 ? JSON.stringify([asset.id, file.id]) : file.id)!;
      const root = this.plan.roots.find((root) => root.id === planned.destinationRoot)!;
      return {
        ...file,
        ...('sourceAssetId' in planned
          ? {
              transferId: planned.id,
              transferSha256: createHash('sha256').update(JSON.stringify(planned)).digest('hex'),
            }
          : {}),
        path: planned.destinationPath,
        root,
        absolutePath: posix.join(root.path, planned.destinationPath),
        name: file.role === 'original' ? item.originalFileNames[file.id] : posix.basename(file.path),
      };
    });
    const primaryId = 'primaryFileId' in asset ? asset.primaryFileId : originals[0].id;
    const primary = files.find((file) => file.id === primaryId)!;
    const bytes = files
      .filter((file) => file.role === 'original')
      .reduce((total, file) => total + BigInt(file.bytes), 0n);
    if (bytes > 9_223_372_036_854_775_807n) return refuse('ASSET_SIZE_UNREPRESENTABLE');
    const livePhotoVideoSourceId = this.livePhotos.get(asset.id);
    const recordSha256 = createHash('sha256')
      .update(
        JSON.stringify({
          type: item.type,
          fileModifiedAt: item.fileModifiedAt,
          asset,
          files,
          ownerId,
          ...(livePhotoVideoSourceId === undefined ? {} : { livePhotoVideoSourceId }),
        }),
      )
      .digest('hex');
    return structuredClone({
      item,
      asset,
      metadata,
      ownerId,
      files,
      primary,
      bytes,
      recordSha256,
      livePhotoVideoSourceId,
    });
  }

  async write(input: unknown): Promise<string> {
    const { item, asset, metadata, ownerId, files, primary, bytes, recordSha256, livePhotoVideoSourceId } =
      this.prepare(input);
    try {
      return await new LibraryImportJournal(this.db).create(
        this.binding,
        {
          kind: 'asset',
          sourceId: asset.id,
          recordSha256,
        },
        async (tx, destinationId) => {
          const [owner] = await tx.query(
            `SELECT u.id FROM public."user" u
          JOIN public.frameleaf_library_import_mapping m ON m.destination_id=u.id
          WHERE m.operation_id=$1::uuid AND m.entity_kind='owner' AND m.source_id=$2 AND u.id=$3::uuid
          AND u.status='active' AND u."deletedAt" IS NULL FOR UPDATE OF u`,
            [this.binding.operationId, asset.ownerId, ownerId],
          );
          if (!owner) return refuse('ASSET_OWNER_MAPPING_REQUIRED');
          let livePhotoVideoId: string | null = null;
          if (livePhotoVideoSourceId !== undefined) {
            const video = this.assets.get(livePhotoVideoSourceId)!;
            if (!('type' in video)) return refuse('ASSET_LIVE_PHOTO_MOTION_INVALID');
            const expected = this.prepare({
              sourceAssetId: video.id,
              type: video.type,
              fileModifiedAt: video.fileModifiedAt,
              originalFileNames: video.originalFileNames,
            });
            const rows = await tx.query(
              `SELECT a.id::text,m.record_sha256 FROM public.frameleaf_library_import_mapping m
              JOIN public.asset a ON a.id=m.destination_id WHERE m.operation_id=$1::uuid
              AND m.entity_kind='asset' AND m.source_id=$2 AND a."ownerId"=$3::uuid
              AND a.type='VIDEO' AND a.visibility='hidden' AND a.status='active' AND a."deletedAt" IS NULL
              AND a."livePhotoVideoId" IS NULL AND a."stackId" IS NULL
              AND NOT EXISTS(SELECT 1 FROM public.asset_lock l WHERE l."assetId"=a.id)
              AND NOT EXISTS(SELECT 1 FROM public.album_asset aa WHERE aa."assetId"=a.id)
              AND NOT EXISTS(SELECT 1 FROM public.asset p WHERE p."livePhotoVideoId"=a.id)
              FOR UPDATE OF a`,
              [this.binding.operationId, livePhotoVideoSourceId, ownerId],
            );
            if (rows.length !== 1 || rows[0].record_sha256 !== expected.recordSha256 || typeof rows[0].id !== 'string')
              return refuse('ASSET_LIVE_PHOTO_MOTION_INVALID');
            livePhotoVideoId = rows[0].id;
          }
          if (
            metadata.timeZone !== undefined &&
            (await tx.query('SELECT 1 FROM pg_timezone_names WHERE name=$1', [metadata.timeZone])).length !== 1
          )
            return refuse('ASSET_TIME_ZONE_UNSUPPORTED');
          await tx.query('SELECT pg_advisory_xact_lock_shared($1::bigint)', [BUDDY_CAPTURE_LOCK]);
          for (const path of files.map((file) => file.absolutePath).sort())
            await tx.query('SELECT pg_advisory_xact_lock($1::bigint)', [filePathLockKey(path)]);
          const destinationIdentities = new Set<string>();
          for (const rootId of new Set(files.map((file) => file.root.id))) {
            const selected = files.filter((file) => file.root.id === rootId);
            await verifyImportFiles(
              selected[0].root.path,
              selected.map(({ id, transferId, path, bytes, sha256, role }) => ({
                id: transferId ?? id,
                path,
                bytes,
                sha256,
                role,
              })),
              { device: selected[0].root.device, inode: selected[0].root.inode },
              destinationIdentities,
            );
          }
          // Never upsert a path: a collision must not change another asset's bytes or ownership.
          const physical = new Map<string, string>();
          for (const file of files) {
            if (file.role !== 'original') continue;
            const id = randomUUID();
            await tx.query(
              `INSERT INTO public.physical_file(id,type,checksum,"sizeInBytes",path)
            VALUES($1::uuid,'original',decode($2,'hex'),$3::bigint,$4)`,
              [id, file.sha256, file.bytes, file.absolutePath],
            );
            physical.set(file.id, id);
            if (file.transferId !== undefined)
              await tx.query(
                `INSERT INTO public.frameleaf_library_import_mapping(operation_id,entity_kind,source_id,destination_id,record_sha256)
                VALUES($1::uuid,'file',$2,$3::uuid,$4)`,
                [this.binding.operationId, file.transferId, id, file.transferSha256],
              );
          }
          await tx.query(
            `INSERT INTO public.asset(id,"ownerId",type,"originalPath","physicalOriginalFileId",checksum,"checksumAlgorithm",
          "fileCreatedAt","localDateTime","fileModifiedAt","originalFileName","isFavorite",visibility,status,"deletedAt","livePhotoVideoId")
          VALUES($1::uuid,$2::uuid,$3,$4,$5::uuid,decode($6,'hex'),'sha256',$7::timestamptz,
          COALESCE($16::timestamp AT TIME ZONE 'UTC',($7::timestamptz AT TIME ZONE $8) AT TIME ZONE 'UTC'),$9::timestamptz,$10,$11,$12::asset_visibility_enum,$13::assets_status_enum,$14::timestamptz,$15::uuid)`,
            [
              destinationId,
              ownerId,
              item.type,
              primary.absolutePath,
              physical.get(primary.id),
              primary.sha256,
              metadata.takenAt,
              metadata.timeZone ?? null,
              item.fileModifiedAt,
              primary.name,
              metadata.favorite ?? false,
              storedVisibility(asset),
              asset.visibility === 'trash' ? 'trashed' : 'active',
              metadata.deletedAt ?? null,
              livePhotoVideoId,
              'localDateTime' in asset ? (asset.localDateTime ?? null) : null,
            ],
          );
          for (const file of files) {
            if (file.role === 'sidecar') {
              const id = randomUUID();
              await tx.query(
                `INSERT INTO public.asset_file(id,"assetId",type,path) VALUES($1::uuid,$2::uuid,'sidecar',$3)`,
                [id, destinationId, file.absolutePath],
              );
              if (file.transferId !== undefined)
                await tx.query(
                  `INSERT INTO public.frameleaf_library_import_mapping(operation_id,entity_kind,source_id,destination_id,record_sha256)
                  VALUES($1::uuid,'file',$2,$3::uuid,$4)`,
                  [this.binding.operationId, file.transferId, id, file.transferSha256],
                );
              continue;
            }
            await tx.query('UPDATE public.physical_file SET "canonicalAssetId"=$1::uuid WHERE id=$2::uuid', [
              destinationId,
              physical.get(file.id),
            ]);
            if (file.id !== primary.id)
              await tx.query(
                `INSERT INTO public.asset_original("assetId","physicalFileId","originalFileName")
            VALUES($1::uuid,$2::uuid,$3)`,
                [destinationId, physical.get(file.id), file.name],
              );
          }
          // Imported source values are authoritative; regeneration must not replace them with stale EXIF.
          const locks = [
            'dateTimeOriginal',
            'timeZone',
            ...(['description', 'rating', 'latitude', 'longitude', 'tags'] as const).filter(
              (key) => metadata[key] !== undefined,
            ),
          ];
          await tx.query(
            `INSERT INTO public.asset_exif("assetId","fileSizeInByte","dateTimeOriginal","timeZone",description,rating,latitude,longitude,tags,"lockedProperties")
          VALUES($1::uuid,$2::bigint,$3::timestamptz,$4,$5,$6,$7,$8,$9::text[],$10::text[])`,
            [
              destinationId,
              primary.bytes,
              metadata.takenAt,
              metadata.timeZone ?? null,
              metadata.description ?? '',
              metadata.rating ?? null,
              metadata.latitude ?? null,
              metadata.longitude ?? null,
              metadata.tags ?? null,
              locks,
            ],
          );
          if (metadata.tags !== undefined) await writeImportedTags(tx, ownerId, destinationId, metadata.tags);
          // Owner 2026-11-04: a source's private item is Locked, a Live Photo as a whole (FL-34).
          if (asset.visibility === 'locked')
            await tx.query(`INSERT INTO public.asset_lock("assetId",reason) SELECT unnest($1::uuid[]),$2`, [
              [destinationId, ...(livePhotoVideoId === null ? [] : [livePhotoVideoId])],
              AssetLockReason.Marked,
            ]);
          const charged = await tx.query(
            `UPDATE public."user" SET "quotaUsageInBytes"="quotaUsageInBytes"+$2::bigint WHERE id=$1::uuid
          AND ("quotaSizeInBytes" IS NULL OR "quotaUsageInBytes"+$2::bigint<="quotaSizeInBytes") RETURNING id`,
            [ownerId, String(bytes)],
          );
          if (charged.length !== 1) return refuse('ASSET_QUOTA_EXCEEDED');
        },
      );
    } catch (error) {
      if (error instanceof LibraryImportRefused) throw error;
      if (error instanceof BundleVerificationError) throw new LibraryImportRefused(error.code);
      // Database diagnostics may contain media names and host paths.
      throw new LibraryImportRefused('ASSET_WRITE_FAILED');
    }
  }
}
