import { ConflictException, Injectable } from '@nestjs/common';
import { Kysely, Selectable, Transaction, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { createHash, randomUUID } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { join, parse } from 'node:path';
import type { PhysicalDeduplicationEvidenceRow } from 'src/utils/physical-deduplication-plan.js';
import { StorageCore } from 'src/cores/storage.core.js';
import {
  AssetFileType,
  AssetStatus,
  DatabaseLock,
  PhysicalFileType,
  StudioExportScope,
  StudioExportVersionState,
} from 'src/enum.js';
import { DB } from 'src/schema/index.js';
import { PhysicalFileTable } from 'src/schema/tables/physical-file.table.js';
import { sweepAttemptOutputs } from 'src/utils/attempt-sweep.js';
import { anyUuid, asUuid } from 'src/utils/database.js';

type PhysicalFile = Selectable<PhysicalFileTable>;
export const BUDDY_CAPTURE_LOCK = -311;
/**
 * Takes the transaction-scoped advisory lock that guards one file path against concurrent reference
 * changes (see `deleteUnreferencedPath`). Released on commit or rollback. The key is derived in JS
 * rather than via `hashtext` so every caller agrees on it without depending on an undocumented
 * Postgres builtin. A caller taking several paths takes them in sorted order.
 */
export const lockFilePath = async (db: Kysely<DB>, path: string): Promise<void> => {
  await sql`SELECT pg_advisory_xact_lock_shared(${BUDDY_CAPTURE_LOCK}::bigint)`.execute(db);
  const key = createHash('sha1').update(path).digest().readBigInt64BE(0);
  await sql`SELECT pg_advisory_xact_lock(${key.toString()}::bigint)`.execute(db);
};
/**
 * Serializes universal-storage linking per content hash (see `linkUploadedOriginal`). Taken before any
 * path lock, never after one.
 */
export const lockChecksum = async (db: Kysely<DB>, checksum: Buffer): Promise<void> => {
  const key = createHash('sha1').update(checksum).digest().readInt32BE(0);
  await sql`SELECT pg_advisory_xact_lock(${DatabaseLock.UniversalStorageChecksum}::int, ${key}::int)`.execute(db);
};
/**
 * Every row that keeps `path` on disk. The caller holds the path's lock (`lockFilePath`), so the count
 * stays true until its transaction ends.
 */
export const countPathReferences = async (
  trx: Transaction<DB>,
  path: string,
  physicalFileId?: string,
): Promise<number> => {
  // A path can be the live original of an asset that has no `physical_file`
  // link at all — both upload-time dedup and the dedup migration point
  // `asset.originalPath` at a file owned by another asset. Counting only
  // physical-file links misses those references entirely.
  const assetRefs = await trx
    .selectFrom('asset')
    .select((eb) => eb.fn.countAll<number>().as('count'))
    .where((eb) =>
      eb.or([
        eb('asset.originalPath', '=', path),
        ...(physicalFileId ? [eb('asset.physicalOriginalFileId', '=', asUuid(physicalFileId))] : []),
      ]),
    )
    .executeTakeFirstOrThrow();
  const fileRefs = await trx
    .selectFrom('asset_file')
    .select((eb) => eb.fn.countAll<number>().as('count'))
    .where((eb) =>
      eb.or([
        eb('asset_file.path', '=', path),
        ...(physicalFileId ? [eb('asset_file.physicalFileId', '=', asUuid(physicalFileId))] : []),
      ]),
    )
    .executeTakeFirstOrThrow();
  // Saved versions remain owners of their rendered files (and a master's lineage sidecar) even
  // after they leave the current asset projection. A version's source is its asset's original,
  // which the asset row already protects, so the recorded source path is not a reference.
  const historyRefs = await sql<{
    count: string;
  }>`SELECT count(*) FROM (
    SELECT 1 FROM public.video_edit_version v
    WHERE v."masterPath"=${path} OR v."proxyPath"=${path} OR v."masterPath" || '.lineage.json'=${path}
      OR EXISTS(SELECT 1 FROM jsonb_array_elements(v.files) f WHERE f->>'path'=${path})

    UNION ALL SELECT 1 FROM public.asset_develop_revision r
    WHERE r."masterPath"=${path} OR r."previewPath"=${path}
    UNION ALL SELECT 1 FROM public.asset_file f
    WHERE f."isEdited" AND f.type='encoded_video' AND f.path || '.lineage.json'=${path}
  ) retained`.execute(trx);
  // Outputs served by Frameleaf features and retained Buddy snapshots are live file owners.
  // Their references are released only when the owning rows are removed or cleared.
  const retainedRefs = await sql<{
    count: string;
  }>`SELECT count(*) FROM (
    SELECT 1 FROM public.buddy_backup_reference reference WHERE reference.path = ${path} AND NOT reference.released
    UNION ALL SELECT 1 FROM public.person person WHERE person."thumbnailPath"=${path}
    UNION ALL SELECT 1 FROM public."user" owner WHERE owner."profileImagePath"=${path}
    UNION ALL SELECT 1 FROM public.asset_video_duplicate_frame frame WHERE frame.path=${path}
    UNION ALL SELECT 1 FROM public.video_moment_frame frame WHERE frame.path=${path}
    UNION ALL SELECT 1 FROM public.photography_workflow workflow
    WHERE workflow.value->'published'->>'logoPath'=${path}
      OR workflow.value->'publication'->>'logoPath'=${path}
      OR EXISTS (SELECT 1 FROM jsonb_array_elements(
        COALESCE(workflow.value->'published'->'photos','[]'::jsonb) ||
        COALESCE(workflow.value->'publication'->'photos','[]'::jsonb)) photo
        WHERE photo->>'previewPath'=${path} OR photo->>'thumbnailPath'=${path})
      OR EXISTS (SELECT 1 FROM jsonb_array_elements(workflow.value->'orders') orders,
        jsonb_array_elements(orders->'items') item
        WHERE item->>'finalPath'=${path} OR EXISTS (
          SELECT 1 FROM jsonb_array_elements(COALESCE(item->'outputs','[]'::jsonb)) output
          WHERE output->>'approvalPreviewPath'=${path} OR output->>'finalPath'=${path}))
    UNION ALL SELECT 1 FROM public.studio_export_version version WHERE version."outputPath" = ${path}
    UNION ALL SELECT 1 FROM public.studio_project_import imported WHERE imported.path = ${path}
    UNION ALL SELECT 1 FROM public.studio_generated_resource generated WHERE generated.path = ${path}
    UNION ALL SELECT 1 FROM public.studio_hdr_intermediate intermediate WHERE intermediate.path = ${path}
    UNION ALL SELECT 1 FROM public.asset_develop_artifact artifact WHERE artifact.path = ${path}
    UNION ALL SELECT 1 FROM public.physical_file_trash trashed WHERE trashed.path = ${path}
    UNION ALL SELECT 1 FROM public.move_history move
    WHERE move."pathType" = 'file_trash' AND ${path} IN (move."oldPath", move."newPath")
    UNION ALL SELECT 1 FROM public.preservation_package package
    WHERE package.path = ${path} AND package."removedAt" IS NULL
    UNION ALL SELECT 1 FROM public.asset_restoration restoration
    WHERE ${path} IN (
      restoration."previewBeforePath", restoration."previewAfterPath",
      restoration."resultPath", restoration."resultPreviewPath"
    )
  ) retained`.execute(trx);
  return (
    Number(assetRefs.count) +
    Number(fileRefs.count) +
    Number(historyRefs.rows[0].count) +
    Number(retainedRefs.rows[0].count)
  );
};
/** Moves (or copies and removes) a file; rejects with ENOENT when the source is gone. */
export type PhysicalFileTrashMove = (from: string, to: string) => Promise<void>;
/** An original that is not (or no longer) registered as a physical file, described by the asset that held it. */
export type TrashedOriginal = {
  checksum: Buffer;
  sizeInBytes: number;
  ownerId: string | null;
  assetId: string | null;
  originalFileName: string;
};
/** ENOENT alone proves absence; an unreadable mount must retain the recovery intent. */
const trashPathExists = async (path: string): Promise<boolean> => {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return false;
    throw error;
  }
};

/** Compensates interrupted trash moves. Conflicting or missing copies stay recorded for review. */
export const recoverFileTrashMoves = async (
  db: Kysely<DB>,
  move: PhysicalFileTrashMove,
  sourcePath?: string,
): Promise<number> => {
  const { rows: pending } = await sql<{ id: string; oldPath: string; newPath: string }>`
    SELECT id, "oldPath", "newPath" FROM public.move_history
    WHERE "pathType" = 'file_trash' ${sourcePath ? sql`AND "oldPath" = ${sourcePath}` : sql``}
    ORDER BY id`.execute(db);
  let deferred = 0;
  for (const intent of pending) {
    const recovered = await db.transaction().execute(async (trx) => {
      for (const path of [intent.oldPath, intent.newPath].toSorted()) await lockFilePath(trx, path);
      const { rows } = await sql`SELECT id FROM public.move_history
        WHERE id = ${intent.id}::uuid AND "pathType" = 'file_trash'
          AND "oldPath" = ${intent.oldPath} AND "newPath" = ${intent.newPath} FOR UPDATE`.execute(trx);
      if (rows.length === 0) return true;
      // Discount only this exact journal. Every other owner and intent continues protecting the target.
      const registered = await trx
        .selectFrom('physical_file')
        .select('id')
        .where('path', '=', intent.newPath)
        .executeTakeFirst();
      if (registered || (await countPathReferences(trx, intent.newPath)) > 1) return false;
      const [sourceExists, targetExists] = await Promise.all([
        trashPathExists(intent.oldPath),
        trashPathExists(intent.newPath),
      ]);
      if (sourceExists === targetExists) return false;
      if (targetExists) await move(intent.newPath, intent.oldPath);
      await sql`DELETE FROM public.move_history WHERE id = ${intent.id}::uuid`.execute(trx);
      return true;
    });
    if (!recovered) deferred++;
  }
  return deferred;
};

/** The independent intent is committed before acquiring a transaction's pool connection. */
export const withFileTrashMove = async <T>(
  db: Kysely<DB>,
  path: string,
  originalFileName: string,
  move: PhysicalFileTrashMove,
  callback: (trx: Transaction<DB>, id: string) => Promise<T>,
): Promise<T> => {
  if (await recoverFileTrashMoves(db, move, path)) {
    throw new ConflictException('An interrupted file trash move needs recovery');
  }
  const id = randomUUID();
  const target = StorageCore.getFileTrashPath(id, originalFileName);
  await sql`INSERT INTO public.move_history (id, "entityId", "pathType", "oldPath", "newPath")
    VALUES (${id}::uuid, ${id}::uuid, 'file_trash', ${path}, ${target})`.execute(db);
  try {
    return await db.transaction().execute(async (trx) => {
      for (const lockedPath of [path, target].toSorted()) await lockFilePath(trx, lockedPath);
      const { rows } = await sql`SELECT id FROM public.move_history
        WHERE id = ${id}::uuid AND "pathType" = 'file_trash'
          AND "oldPath" = ${path} AND "newPath" = ${target} FOR UPDATE`.execute(trx);
      if (rows.length === 0) throw new ConflictException('File trash reservation changed; retry');
      const result = await callback(trx, id);
      // This includes returns without a move, and happens after every SQL operation in the caller.
      await sql`DELETE FROM public.move_history WHERE id = ${id}::uuid`.execute(trx);
      return result;
    });
  } catch (error) {
    await recoverFileTrashMoves(db, move, path).catch(() => void 0);
    throw error;
  }
};

/**
 * Records an original moved under withFileTrashMove; its intent survives any enclosing rollback.
 */
export const trashUnreferencedOriginal = async (
  trx: Transaction<DB>,
  path: string,
  move: PhysicalFileTrashMove,
  entry: {
    physicalFileId: string | null;
    checksum: Buffer;
    sizeInBytes: number;
    lastOwnerId: string | null;
    lastAssetId: string | null;
    originalFileName: string;
  },
  id: string,
): Promise<false | { id: string; path: string }> => {
  const target = StorageCore.getFileTrashPath(id, entry.originalFileName);
  const { rows: pending } = await sql`SELECT id FROM public.move_history
    WHERE "pathType" = 'file_trash' AND id <> ${id}::uuid AND ${path} IN ("oldPath", "newPath")`.execute(trx);
  if (pending.length > 0 || (await trashPathExists(target))) {
    throw new ConflictException('An interrupted file trash move needs recovery');
  }
  try {
    await move(path, target);
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException)?.code === 'ENOENT' &&
      !(await trashPathExists(target)) &&
      !(await trashPathExists(path))
    ) {
      return false;
    }
    throw error;
  }
  await sql`
    INSERT INTO public.physical_file_trash
      (id, "physicalFileId", path, checksum, "sizeInBytes", "lastOwnerId", "lastAssetId", "originalFileName")
    VALUES (${id}::uuid, ${entry.physicalFileId}::uuid, ${target}, ${entry.checksum}, ${entry.sizeInBytes}::bigint,
      ${entry.lastOwnerId}::uuid, ${entry.lastAssetId}::uuid, ${entry.originalFileName})`.execute(trx);
  return { id, path: target };
};
export interface PhysicalFileInput {
  canonicalAssetId: string | null;
  checksum: Buffer;
  path: string;
  sizeInBytes: number;
  type: PhysicalFileType;
}
@Injectable()
export class PhysicalFileRepository {
  constructor(
    @InjectKysely()
    private db: Kysely<DB>,
  ) {}
  /** Job -> Buddy barrier -> path is the same order as claim-fenced publication. */
  async sweepAttempts(roots: string[]) {
    return sweepAttemptOutputs(this.db, roots, async (trx, path, unlink) => {
      await lockFilePath(trx, path);
      const physical = await trx
        .selectFrom('physical_file')
        .select(['id', 'type'])
        .where('path', '=', path)
        .executeTakeFirst();
      // An unexpected registered original is never disposable generated output.
      if (physical?.type === PhysicalFileType.Original || (await countPathReferences(trx, path, physical?.id)) > 0)
        return false;
      if (!(await unlink())) return false;
      if (physical) await trx.deleteFrom('physical_file').where('id', '=', physical.id).execute();
      return true;
    });
  }
  /**
   * The ordering is load-bearing: when the master account holds several copies
   * of the same file, an unordered limit lets upload-time dedup and the dedup
   * migration pick different masters for the same duplicate — the migration
   * then treats the first master's file as the duplicate's own and queues it
   * for deletion. Both callers share this query, so a stable pick keeps them
   * agreeing on one canonical master.
   */
  async getMasterOriginalCandidate(masterUserId: string, checksum: Buffer, sizeInBytes: number) {
    return this.db
      .selectFrom('asset')
      .innerJoin('asset_exif', 'asset_exif.assetId', 'asset.id')
      .select([
        'asset.id',
        'asset.originalPath',
        'asset.originalFileName',
        'asset.type',
        'asset.physicalOriginalFileId',
        'asset.checksum',
        'asset.width',
        'asset.height',
        'asset.duration',
        'asset_exif.fileSizeInByte as sizeInBytes',
      ])
      .where('asset.ownerId', '=', asUuid(masterUserId))
      .where('asset.libraryId', 'is', null)
      .where('asset.isExternal', '=', false)
      .where('asset.isOffline', '=', false)
      .where('asset.deletedAt', 'is', null)
      .where('asset.status', '=', AssetStatus.Active)
      .where('asset.checksum', '=', checksum)
      .where('asset_exif.fileSizeInByte', '=', sizeInBytes)
      .orderBy('asset.id', 'asc')
      .limit(1)
      .executeTakeFirst();
  }
  /**
   * Universal storage: the asset whose original file the server keeps for this content. Any active,
   * non-external, online asset with the same SHA-256 and size qualifies, whoever owns it; the lowest id
   * wins, so upload linking and the storage migration always agree on one file. `excludeAssetId` leaves
   * out the asset being linked.
   */
  getServerOriginalCandidate(
    checksum: Buffer,
    sizeInBytes: number,
    options: {
      excludeAssetId?: string;
      kysely?: Kysely<DB>;
    } = {},
  ) {
    return (options.kysely ?? this.db)
      .selectFrom('asset')
      .innerJoin('asset_exif', 'asset_exif.assetId', 'asset.id')
      .select(['asset.id', 'asset.originalPath', 'asset.physicalOriginalFileId'])
      .where('asset.libraryId', 'is', null)
      .where('asset.isExternal', '=', false)
      .where('asset.isOffline', '=', false)
      .where('asset.deletedAt', 'is', null)
      .where('asset.status', '=', AssetStatus.Active)
      .where('asset.checksum', '=', checksum)
      .where('asset_exif.fileSizeInByte', '=', sizeInBytes)
      .$if(!!options.excludeAssetId, (qb) => qb.where('asset.id', '!=', asUuid(options.excludeAssetId!)))
      .orderBy('asset.id', 'asc')
      .limit(1)
      .executeTakeFirst();
  }
  /**
   * Universal storage upload linking (one file per content hash, server-wide). Under a per-checksum lock,
   * an uploaded asset is pointed at the file the server already keeps for its content when another
   * library holds it and that file is on disk (`linked: true`; the caller releases the temporary upload).
   * Otherwise the upload's own file is registered with the asset as its primary (`linked: false`).
   * Returns undefined for an asset that is not an eligible upload (external, offline, trashed).
   *
   * `ingestion` re-checks a resumable upload's durable claim before linking, as the claim may have expired.
   */
  async linkUploadedOriginal(
    assetId: string,
    file: {
      checksum: Buffer;
      sizeInBytes: number;
    },
    options: {
      exists: (path: string) => Promise<boolean>;
      /** Moves a file out of the file trash; given, content found there is restored and linked. */
      untrash?: (from: string, to: string) => Promise<void>;
      ingestion?: {
        resourceId: string;
        token: string;
        ownerId: string;
      };
    },
  ): Promise<
    | {
        physicalFile: PhysicalFile;
        linked: boolean;
      }
    | undefined
  > {
    return this.db.transaction().execute(async (trx) => {
      await lockChecksum(trx, file.checksum);
      const asset = await trx
        .selectFrom('asset')
        .select(['asset.id', 'asset.originalPath', 'asset.physicalOriginalFileId'])
        .where('asset.id', '=', asUuid(assetId))
        .where('asset.checksum', '=', file.checksum)
        .where('asset.libraryId', 'is', null)
        .where('asset.isExternal', '=', false)
        .where('asset.isOffline', '=', false)
        .where('asset.deletedAt', 'is', null)
        .forUpdate()
        .executeTakeFirst();
      if (!asset) {
        return;
      }
      if (asset.physicalOriginalFileId) {
        // already linked: a concurrent upload of the same content linked this one onto its file
        const physicalFile = await this.getPhysicalFile(asset.physicalOriginalFileId, trx);
        return physicalFile ? { physicalFile, linked: physicalFile.canonicalAssetId !== asset.id } : undefined;
      }
      const candidate = await this.getServerOriginalCandidate(file.checksum, file.sizeInBytes, {
        excludeAssetId: asset.id,
        kysely: trx,
      });
      if (candidate) {
        const target = candidate.physicalOriginalFileId
          ? await this.getPhysicalFile(candidate.physicalOriginalFileId, trx)
          : undefined;
        const path = target?.path ?? candidate.originalPath;
        // checked again under the path lock: a FileDelete that held it may have moved the file to the file
        // trash meanwhile, and then the upload keeps its own file (or takes the trashed one back, below)
        const existsUnderLock = async () => {
          await this.lockPath(trx, path);
          return options.exists(path);
        };
        if (path !== asset.originalPath && (await options.exists(path)) && (await existsUnderLock())) {
          if (options.ingestion) {
            await this.requireIngestionClaim(trx, asset.id, file.checksum, options.ingestion);
          }
          const physicalFile =
            target ??
            (await this.registerOriginal(trx, {
              canonicalAssetId: candidate.id,
              checksum: file.checksum,
              path,
              sizeInBytes: file.sizeInBytes,
            }));
          // the candidate may have had no physical file yet: it becomes the primary of the one just made
          await trx
            .updateTable('asset')
            .set({ physicalOriginalFileId: physicalFile.id, originalPath: physicalFile.path })
            .where('physicalOriginalFileId', 'is', null)
            .where((eb) => eb.or([eb('id', '=', asUuid(candidate.id)), eb('id', '=', asUuid(asset.id))]))
            .execute();
          return { physicalFile, linked: true };
        }
      }
      // the content is in the file trash: take that file back out and link to it, never keep two copies
      if (options.untrash) {
        const trashed = await sql<{
          id: string;
          path: string;
        }>`
          SELECT id, path FROM public.physical_file_trash
          WHERE checksum = ${file.checksum} AND "sizeInBytes" = ${file.sizeInBytes}::bigint
          ORDER BY "trashedAt" DESC, id
          LIMIT 1
          FOR UPDATE`.execute(trx);
        const entry = trashed.rows[0];
        if (entry) {
          const upload = parse(asset.originalPath);
          const target = join(upload.dir, `${upload.name}-restored${upload.ext}`);
          for (const path of [entry.path, target].toSorted()) {
            await this.lockPath(trx, path);
          }
          if (options.ingestion) {
            await this.requireIngestionClaim(trx, asset.id, file.checksum, options.ingestion);
          }
          await options.untrash(entry.path, target);
          await sql`DELETE FROM public.physical_file_trash WHERE id = ${entry.id}::uuid`.execute(trx);
          const physicalFile = await this.registerOriginal(trx, {
            canonicalAssetId: asset.id,
            checksum: file.checksum,
            path: target,
            sizeInBytes: file.sizeInBytes,
          });
          await trx
            .updateTable('asset')
            .set({ physicalOriginalFileId: physicalFile.id, originalPath: physicalFile.path })
            .where('id', '=', asUuid(asset.id))
            .execute();
          return { physicalFile, linked: true };
        }
      }
      await this.lockPath(trx, asset.originalPath);
      const physicalFile = await this.registerOriginal(trx, {
        canonicalAssetId: asset.id,
        checksum: file.checksum,
        path: asset.originalPath,
        sizeInBytes: file.sizeInBytes,
      });
      await trx
        .updateTable('asset')
        .set({ physicalOriginalFileId: physicalFile.id })
        .where('id', '=', asUuid(asset.id))
        .execute();
      return { physicalFile, linked: false };
    });
  }
  /**
   * For a generated file with no `physical_file` row (made before universal storage, and inherited by a
   * partner copy of such an asset): the asset that owns the file at `path`, chosen as a primary is
   * (`electNextCanonical`): the oldest live asset whose unedited generated file is there. Undefined when
   * no asset names the path.
   */
  async getGeneratedPathPrimaryAssetId(path: string): Promise<string | undefined> {
    const row = await this.db
      .selectFrom('asset_file')
      .innerJoin('asset', 'asset.id', 'asset_file.assetId')
      .select('asset.id')
      .where('asset_file.path', '=', path)
      .where('asset_file.isEdited', '=', false)
      .orderBy(sql`asset."deletedAt" IS NOT NULL`)
      .orderBy('asset.createdAt', 'asc')
      .orderBy('asset.id', 'asc')
      .limit(1)
      .executeTakeFirst();
    return row?.id;
  }
  /**
   * The stored originals whose primary asset is one of `ownerId`'s: read before that account's assets are
   * removed, so each can be handed to its next primary afterwards (`electNextCanonical`).
   */
  async getOriginalIdsWithPrimaryOwnedBy(ownerId: string): Promise<string[]> {
    const rows = await this.db
      .selectFrom('physical_file')
      .innerJoin('asset', 'asset.id', 'physical_file.canonicalAssetId')
      .select('physical_file.id')
      .where('asset.ownerId', '=', asUuid(ownerId))
      .where('physical_file.type', '=', PhysicalFileType.Original)
      .orderBy('physical_file.id')
      .execute();
    return rows.map(({ id }) => id);
  }
  /**
   * Universal storage primary handover: once a shared original's primary asset is gone (its
   * `canonicalAssetId` was set null by the asset's removal), the oldest remaining asset that references
   * the file becomes primary, live assets before trashed ones. The generated files the new primary
   * shares follow it. Returns undefined when the file still has a primary or nothing references it.
   * The caller queues the new primary's storage-template move, so the file follows its new owner.
   */
  async electNextCanonical(physicalFileId: string): Promise<
    | {
        assetId: string;
      }
    | undefined
  > {
    const physicalFile = await this.getPhysicalFile(physicalFileId);
    if (!physicalFile || physicalFile.canonicalAssetId) {
      return;
    }
    return this.withPathLock(physicalFile.path, async (trx) => {
      const current = await trx
        .selectFrom('physical_file')
        .select(['id', 'canonicalAssetId'])
        .where('id', '=', asUuid(physicalFileId))
        .forUpdate()
        .executeTakeFirst();
      if (!current || current.canonicalAssetId) {
        return;
      }
      const next = await trx
        .selectFrom('asset')
        .select('id')
        .where('physicalOriginalFileId', '=', asUuid(physicalFileId))
        .orderBy(sql`"deletedAt" IS NOT NULL`)
        .orderBy('createdAt', 'asc')
        .orderBy('id', 'asc')
        .limit(1)
        .executeTakeFirst();
      if (!next) {
        return;
      }
      await trx
        .updateTable('physical_file')
        .set({ canonicalAssetId: next.id })
        .where('id', '=', asUuid(physicalFileId))
        .execute();
      await trx
        .updateTable('physical_file')
        .set({ canonicalAssetId: next.id })
        .where('canonicalAssetId', 'is', null)
        .where('type', '!=', PhysicalFileType.Original)
        .where('id', 'in', (eb) =>
          eb
            .selectFrom('asset_file')
            .select('asset_file.physicalFileId')
            .where('asset_file.assetId', '=', asUuid(next.id))
            .where('asset_file.physicalFileId', 'is not', null),
        )
        .execute();
      return { assetId: next.id };
    });
  }
  private registerOriginal(
    trx: Transaction<DB>,
    values: {
      canonicalAssetId: string;
      checksum: Buffer;
      path: string;
      sizeInBytes: number;
    },
  ): Promise<PhysicalFile> {
    return trx
      .insertInto('physical_file')
      .values({ ...values, type: PhysicalFileType.Original })
      .onConflict((oc) =>
        oc.column('path').doUpdateSet((eb) => ({
          checksum: eb.ref('excluded.checksum'),
          sizeInBytes: eb.ref('excluded.sizeInBytes'),
          canonicalAssetId: eb.ref('excluded.canonicalAssetId'),
        })),
      )
      .returningAll()
      .executeTakeFirstOrThrow();
  }
  private async requireIngestionClaim(
    trx: Transaction<DB>,
    assetId: string,
    checksum: Buffer,
    ingestion: {
      resourceId: string;
      token: string;
      ownerId: string;
    },
  ) {
    const claim = await trx
      .selectFrom('asset_upload_resource')
      .innerJoin('user as uploadOwner', 'uploadOwner.id', 'asset_upload_resource.ownerId')
      .select('asset_upload_resource.id')
      .where('asset_upload_resource.id', '=', ingestion.resourceId)
      .where('asset_upload_resource.ownerId', '=', ingestion.ownerId)
      .where('resultAssetId', '=', assetId)
      .where('verifiedChecksum', '=', checksum)
      .where('ingestionToken', '=', ingestion.token)
      .where('ingestionLeaseExpiresAt', '>', sql<Date>`clock_timestamp()`)
      .where('state', '=', 'published')
      .where('ingested', '=', false)
      .where('uploadOwner.deletedAt', 'is', null)
      .forShare()
      .executeTakeFirst();
    if (!claim) {
      throw new ConflictException('Upload ingestion claim expired');
    }
  }
  /**
   * Active assets whose original is backed by this physical file, including the canonical
   * asset itself. Used by the deduplication preview for its reference counts.
   */
  async countOriginalReferences(physicalFileId: string): Promise<number> {
    const { count } = await this.db
      .selectFrom('asset')
      .select((eb) => eb.fn.countAll<number>().as('count'))
      .where('asset.physicalOriginalFileId', '=', asUuid(physicalFileId))
      .where('asset.deletedAt', 'is', null)
      .executeTakeFirstOrThrow();
    return Number(count);
  }
  /**
   * Physical files' reference counts, as `countOriginalReferences` counts one (FL-73). A file
   * nothing references is absent from the map.
   */
  async countOriginalReferencesFor(physicalFileIds: string[]): Promise<Map<string, number>> {
    const ids = [...new Set(physicalFileIds)];
    if (ids.length === 0) {
      return new Map();
    }
    const rows = await this.db
      .selectFrom('asset')
      .select(['asset.physicalOriginalFileId'])
      .select((eb) => eb.fn.countAll<number>().as('count'))
      .where('asset.physicalOriginalFileId', '=', anyUuid(ids))
      .where('asset.deletedAt', 'is', null)
      .groupBy('asset.physicalOriginalFileId')
      .execute();
    return new Map(rows.map((row) => [row.physicalOriginalFileId as string, Number(row.count)]));
  }
  /**
   * What a reviewed deduplication plan is checked against before review, before apply and before
   * each copy's file is touched (FL-73): owner, path, checksum, size, state and physical original
   * of every named asset, whatever its visibility. Background work reaches Locked assets.
   */
  async getPlanEvidence(assetIds: string[]): Promise<PhysicalDeduplicationEvidenceRow[]> {
    const ids = [...new Set(assetIds)];
    if (ids.length === 0) {
      return [];
    }
    const rows = await this.db
      .selectFrom('asset')
      .leftJoin('asset_exif', 'asset_exif.assetId', 'asset.id')
      .select([
        'asset.id',
        'asset.ownerId',
        'asset.originalPath',
        'asset.checksum',
        'asset.deletedAt',
        'asset.status',
        'asset.isExternal',
        'asset.isOffline',
        'asset.libraryId',
        'asset.physicalOriginalFileId',
        'asset.originalFileName',
        'asset.type',
        'asset_exif.fileSizeInByte as sizeInBytes',
      ])
      .where('asset.id', '=', anyUuid(ids))
      .execute();
    return rows as unknown as PhysicalDeduplicationEvidenceRow[];
  }
  getPhysicalFile(id: string, kysely: Kysely<DB> = this.db): Promise<PhysicalFile | undefined> {
    return kysely.selectFrom('physical_file').selectAll().where('id', '=', asUuid(id)).executeTakeFirst();
  }
  getOriginalPhysicalFile(assetId: string): Promise<PhysicalFile | undefined> {
    return this.db
      .selectFrom('asset')
      .innerJoin('physical_file', 'physical_file.id', 'asset.physicalOriginalFileId')
      .selectAll('physical_file')
      .where('asset.id', '=', asUuid(assetId))
      .executeTakeFirst();
  }
  async upsertPhysicalFile(input: PhysicalFileInput): Promise<PhysicalFile> {
    return this.db.transaction().execute((trx) =>
      trx
        .insertInto('physical_file')
        .values(input)
        .onConflict((oc) =>
          oc.column('path').doUpdateSet((eb) => ({
            checksum: eb.ref('excluded.checksum'),
            sizeInBytes: eb.ref('excluded.sizeInBytes'),
            type: eb.ref('excluded.type'),
            canonicalAssetId: eb.ref('excluded.canonicalAssetId'),
          })),
        )
        .returningAll()
        .executeTakeFirstOrThrow(),
    );
  }
  async ensureOriginalPhysicalFile(assetId: string): Promise<PhysicalFile | undefined> {
    const execute = async (trx: Transaction<DB>) => {
      const asset = await trx
        .selectFrom('asset')
        .innerJoin('asset_exif', 'asset_exif.assetId', 'asset.id')
        .leftJoin('physical_file', 'physical_file.id', 'asset.physicalOriginalFileId')
        .select([
          'asset.id',
          'asset.originalPath',
          'asset.checksum',
          'asset.physicalOriginalFileId',
          'asset_exif.fileSizeInByte as sizeInBytes',
          'physical_file.id as existingPhysicalFileId',
        ])
        .where('asset.id', '=', asUuid(assetId))
        .where('asset.libraryId', 'is', null)
        .where('asset.isExternal', '=', false)
        .where('asset.isOffline', '=', false)
        .where('asset.deletedAt', 'is', null)
        .executeTakeFirst();
      if (!asset || !asset.sizeInBytes) {
        return;
      }
      if (asset.existingPhysicalFileId) {
        return trx
          .selectFrom('physical_file')
          .selectAll()
          .where('id', '=', asUuid(asset.existingPhysicalFileId))
          .executeTakeFirst();
      }
      const physicalFile = await trx
        .insertInto('physical_file')
        .values({
          canonicalAssetId: asset.id,
          checksum: asset.checksum,
          path: asset.originalPath,
          sizeInBytes: Number(asset.sizeInBytes),
          type: PhysicalFileType.Original,
        })
        .onConflict((oc) =>
          oc.column('path').doUpdateSet((eb) => ({
            checksum: eb.ref('excluded.checksum'),
            sizeInBytes: eb.ref('excluded.sizeInBytes'),
            canonicalAssetId: eb.ref('excluded.canonicalAssetId'),
          })),
        )
        .returningAll()
        .executeTakeFirstOrThrow();
      await trx
        .updateTable('asset')
        .set({ physicalOriginalFileId: physicalFile.id, originalPath: physicalFile.path })
        .where('id', '=', asUuid(asset.id))
        .execute();
      return physicalFile;
    };
    return this.db.isTransaction ? execute(this.db as Transaction<DB>) : this.db.transaction().execute(execute);
  }
  // Aliases an asset onto a file another asset already owns, so it takes the
  // path lock: without it this can add a reference to a path a concurrent
  // FileDelete job has already counted as unreferenced.
  async linkAssetToOriginalPhysicalFile(
    assetId: string,
    physicalFile: Pick<PhysicalFile, 'id' | 'path'>,
    expected?: {
      masterOwnerId: string;
      checksum: Buffer;
      size: number;
      ingestion: {
        resourceId: string;
        token: string;
        ownerId: string;
      };
    },
  ) {
    await this.withPathLock(physicalFile.path, async (trx) => {
      if (expected) {
        const claim = await trx
          .selectFrom('asset_upload_resource')
          .innerJoin('user as uploadOwner', 'uploadOwner.id', 'asset_upload_resource.ownerId')
          .select('asset_upload_resource.id')
          .where('asset_upload_resource.id', '=', expected.ingestion.resourceId)
          .where('asset_upload_resource.ownerId', '=', expected.ingestion.ownerId)
          .where('resultAssetId', '=', assetId)
          .where('verifiedChecksum', '=', expected.checksum)
          .where('ingestionToken', '=', expected.ingestion.token)
          .where('ingestionLeaseExpiresAt', '>', sql<Date>`clock_timestamp()`)
          .where('state', '=', 'published')
          .where('ingested', '=', false)
          .where('uploadOwner.deletedAt', 'is', null)
          .forShare()
          .executeTakeFirst();
        if (!claim) {
          throw new ConflictException('Upload ingestion claim expired');
        }
        const current = await trx
          .selectFrom('physical_file')
          .innerJoin('asset', 'asset.id', 'physical_file.canonicalAssetId')
          .innerJoin('asset_exif', 'asset_exif.assetId', 'asset.id')
          .innerJoin('user as masterOwner', 'masterOwner.id', 'asset.ownerId')
          .select('physical_file.id')
          .where('physical_file.id', '=', physicalFile.id)
          .where('physical_file.path', '=', physicalFile.path)
          .where('physical_file.checksum', '=', expected.checksum)
          .where('physical_file.sizeInBytes', '=', expected.size)
          .where('asset.ownerId', '=', expected.masterOwnerId)
          .where('asset.libraryId', 'is', null)
          .where('asset.isExternal', '=', false)
          .where('asset.isOffline', '=', false)
          .where('asset.deletedAt', 'is', null)
          .where('asset.status', '=', AssetStatus.Active)
          .where('asset.checksum', '=', expected.checksum)
          .where('asset_exif.fileSizeInByte', '=', expected.size)
          .where('asset.originalPath', '=', physicalFile.path)
          .where('masterOwner.deletedAt', 'is', null)
          .forShare()
          .executeTakeFirst();
        if (!current) {
          throw new ConflictException('Physical upload target changed');
        }
      }
      const linked = await trx
        .updateTable('asset')
        .set({ physicalOriginalFileId: physicalFile.id, originalPath: physicalFile.path })
        .where('id', '=', asUuid(assetId))
        .$if(!!expected, (qb) =>
          qb
            .where('ownerId', '=', expected!.ingestion.ownerId)
            .where('checksum', '=', expected!.checksum)
            .where('deletedAt', 'is', null),
        )
        .executeTakeFirst();
      if (expected && linked.numUpdatedRows !== 1n) {
        throw new ConflictException('Upload destination changed');
      }
    });
  }
  async isOriginalCanonical(assetId: string, physicalFileId: string, kysely: Kysely<DB> = this.db): Promise<boolean> {
    const physicalFile = await this.getPhysicalFile(physicalFileId, kysely);
    return physicalFile?.canonicalAssetId === assetId;
  }
  /**
   * Point an asset back at its own original file (FL-73): the rollback a verified physical
   * deduplication offers for a copy whose own file is still on disk. The file gets (or keeps) its
   * own physical file row with the asset as canonical owner, under the path's lock so a concurrent
   * removal cannot count the path unreferenced in between. Nothing on disk is written.
   */
  async restoreOriginalPhysicalFile(
    assetId: string,
    file: {
      path: string;
      checksum: Buffer;
      sizeInBytes: number;
    },
  ): Promise<PhysicalFile> {
    return this.withPathLock(file.path, async (trx) => {
      const physicalFile = await trx
        .insertInto('physical_file')
        .values({
          canonicalAssetId: assetId,
          checksum: file.checksum,
          path: file.path,
          sizeInBytes: file.sizeInBytes,
          type: PhysicalFileType.Original,
        })
        .onConflict((oc) =>
          oc.column('path').doUpdateSet((eb) => ({
            checksum: eb.ref('excluded.checksum'),
            sizeInBytes: eb.ref('excluded.sizeInBytes'),
            canonicalAssetId: eb.ref('excluded.canonicalAssetId'),
          })),
        )
        .returningAll()
        .executeTakeFirstOrThrow();
      await trx
        .updateTable('asset')
        .set({ physicalOriginalFileId: physicalFile.id, originalPath: physicalFile.path })
        .where('id', '=', asUuid(assetId))
        .execute();
      return physicalFile;
    });
  }
  // Moves a physical file onto `path`, which makes that path referenced.
  async updateOriginalPhysicalPathForAsset(assetId: string, path: string) {
    await this.withPathLock(path, async (trx) => {
      const physicalFile = await trx
        .selectFrom('physical_file')
        .select(['id'])
        .where('canonicalAssetId', '=', asUuid(assetId))
        .where('type', '=', PhysicalFileType.Original)
        .executeTakeFirst();
      if (!physicalFile) {
        return;
      }
      await trx.updateTable('physical_file').set({ path }).where('id', '=', physicalFile.id).execute();
      await trx
        .updateTable('asset')
        .set({ originalPath: path })
        .where('physicalOriginalFileId', '=', physicalFile.id)
        .execute();
    });
  }
  async getCanonicalGeneratedFile(assetId: string, type: AssetFileType) {
    const physicalType = this.toPhysicalFileType(type);
    return this.db
      .selectFrom('asset as duplicateAsset')
      .innerJoin('physical_file as originalPhysical', 'originalPhysical.id', 'duplicateAsset.physicalOriginalFileId')
      .innerJoin('physical_file as generatedPhysical', (join) =>
        join
          .onRef('generatedPhysical.canonicalAssetId', '=', 'originalPhysical.canonicalAssetId')
          .on('generatedPhysical.type', '=', physicalType),
      )
      .select(['generatedPhysical.id', 'generatedPhysical.path'])
      .where('duplicateAsset.id', '=', asUuid(assetId))
      .whereRef('duplicateAsset.id', '!=', 'originalPhysical.canonicalAssetId')
      .executeTakeFirst();
  }
  // Same aliasing hazard as linkAssetToOriginalPhysicalFile, for derivatives.
  async linkGeneratedFile(assetId: string, type: AssetFileType, physicalFileId: string, path: string) {
    await this.withPathLock(path, (trx) =>
      trx
        .updateTable('asset_file')
        .set({ physicalFileId, path })
        .where('assetId', '=', asUuid(assetId))
        .where('type', '=', type)
        .where('isEdited', '=', false)
        .execute(),
    );
  }
  private countPathReferencesIn(trx: Transaction<DB>, path: string, physicalFileId?: string): Promise<number> {
    return countPathReferences(trx, path, physicalFileId);
  }
  /** Advisory lock guarding one path against concurrent reference changes (`lockFilePath`). */
  private async lockPath(trx: Transaction<DB>, path: string): Promise<void> {
    await lockFilePath(trx, path);
  }
  // Keep the path lock and reference-changing writes in the same transaction.
  private async withPathLock<T>(path: string, callback: (trx: Transaction<DB>) => Promise<T>): Promise<T> {
    return this.db.transaction().execute(async (trx) => {
      await this.lockPath(trx, path);
      return callback(trx);
    });
  }
  /** Owner restore runs after remote staging, under the existing reference-writer path lock. */
  async withOwnerRestorePath<T>(
    path: string,
    assetId: string,
    ownerId: string,
    callback: () => Promise<T>,
    derivative?: {
      type: AssetFileType;
      isEdited: boolean;
    },
  ): Promise<T> {
    const execute = async (trx: Transaction<DB>) => {
      const access = await this.ownerRestorePathAccess(trx, path, assetId, ownerId, derivative);
      if (!access.mutable) throw new Error('Owner restore destination unavailable');
      return callback();
    };
    return this.db.isTransaction ? execute(this.db as Transaction<DB>) : this.db.transaction().execute(execute);
  }
  /** Buddy's recomputed immutable project target, under its live administrator/project transaction. */
  async withStudioRestorePath<T>(
    path: string,
    projectId: string,
    ownerId: string,
    sha256: string,
    callback: () => Promise<T>,
  ): Promise<T> {
    if (!this.db.isTransaction || !/^[a-f0-9]{64}$/.test(sha256))
      throw new Error('Studio restore requires its authorization transaction');
    const trx = this.db as Transaction<DB>;
    await lockFilePath(trx, path);
    const physical = await trx.selectFrom('physical_file').select('id').where('path', '=', path).executeTakeFirst();
    const references = await this.countPathReferencesIn(trx, path, physical?.id);
    const { rows } = await sql<{
      count: string;
    }>`SELECT count(*) FROM (
      SELECT 1 FROM public.studio_project_import imported
      WHERE imported.path=${path} AND imported."projectId"=${projectId}::uuid
        AND imported."ownerId"=${ownerId}::uuid AND imported.checksum=${sha256}
      UNION ALL SELECT 1 FROM public.studio_generated_resource generated
      WHERE generated.path=${path} AND generated."projectId"=${projectId}::uuid
        AND generated."ownerId"=${ownerId}::uuid AND generated.checksum=${sha256}
      UNION ALL SELECT 1 FROM public.studio_export_version exported
      WHERE exported."outputPath"=${path} AND exported."projectId"=${projectId}::uuid
        AND exported."ownerId"=${ownerId}::uuid AND exported."outputChecksum"=${Buffer.from(sha256, 'hex')}
    ) owned`.execute(trx);
    if (physical || references !== Number(rows[0].count))
      throw new Error('Studio restore destination is shared or pinned');
    return callback();
  }
  /** Inspection has no mutation callback. A supplied transaction keeps the path lock for its metadata checks. */
  async inspectOwnerRestorePath(
    path: string,
    assetId: string,
    ownerId: string,
    derivative?: {
      type: AssetFileType;
      isEdited: boolean;
    },
  ): Promise<void> {
    const execute = async (trx: Transaction<DB>) => {
      const access = await this.ownerRestorePathAccess(trx, path, assetId, ownerId, derivative);
      if (!access.inspectable) throw new Error('Owner restore destination unavailable');
    };
    return this.db.isTransaction ? execute(this.db as Transaction<DB>) : this.db.transaction().execute(execute);
  }
  private async ownerRestorePathAccess(
    trx: Transaction<DB>,
    path: string,
    assetId: string,
    ownerId: string,
    derivative?: {
      type: AssetFileType;
      isEdited: boolean;
    },
  ) {
    const barrier = await sql<{
      locked: boolean;
    }>`SELECT pg_try_advisory_xact_lock_shared(${BUDDY_CAPTURE_LOCK}::bigint) AS locked`.execute(trx);
    if (!barrier.rows[0]?.locked) throw new Error('Backup is capturing file ownership; retry this restore');
    const key = createHash('sha1').update(path).digest().readBigInt64BE(0);
    const lock = await sql<{
      locked: boolean;
    }>`SELECT pg_try_advisory_xact_lock(${key.toString()}::bigint) AS locked`.execute(trx);
    if (!lock.rows[0]?.locked) throw new Error('Owner restore destination is changing');
    const physical = await trx.selectFrom('physical_file').select('id').where('path', '=', path).executeTakeFirst();
    const references = await this.countPathReferencesIn(trx, path, physical?.id);
    const own = await trx
      .selectFrom('asset')
      .select('id')
      .where('id', '=', assetId)
      .where('ownerId', '=', ownerId)
      .where('originalPath', '=', path)
      .executeTakeFirst();
    const ownFiles = await trx
      .selectFrom('asset_file')
      .innerJoin('asset', 'asset.id', 'asset_file.assetId')
      .select(['asset_file.assetId', 'asset_file.physicalFileId'])
      .where('asset_file.assetId', '=', assetId)
      .where('asset.ownerId', '=', ownerId)
      .where('asset_file.path', '=', path)
      .where('asset_file.type', '=', derivative?.type ?? AssetFileType.Sidecar)
      .$if(!!derivative, (query) => query.where('asset_file.isEdited', '=', derivative!.isEdited))
      .execute();
    // Any other original, derivative, history or retained reference refuses publication, even same-owner.
    return {
      inspectable: (!physical && references === 0) || !!own || ownFiles.length > 0,
      mutable:
        references <= (own ? 1 : 0) + ownFiles.length &&
        (!physical || !!own || ownFiles.some((file) => derivative && file.physicalFileId === physical.id)),
    };
  }
  /**
   * Unlinks `path` only while nothing references it, holding the path's
   * advisory lock across the count and the unlink so a writer cannot introduce
   * a reference in between. Every method that can point a new row at an
   * existing file takes the same lock, which is what makes the count still
   * true at the moment `unlink` runs.
   *
   * The physical_file row is cleaned up in the same transaction, so a failed
   * unlink leaves both the file and its row intact.
   *
   * FL-169: `removedAssetId` names an asset whose removal queued this delete inside its transaction
   * while holding this path's lock. Holding the lock here means that transaction has ended; if the
   * asset still exists it rolled back, and the path is kept even when no counted row names it (a
   * video duplicate frame, a develop revision output: those are not counted
   * by `countPathReferencesIn`, which is why the asset's survival keeps them).
   */
  async deleteUnreferencedPath(
    path: string,
    unlink: () => Promise<void>,
    options: {
      removedAssetId?: string;
      orphanStudioImport?: {
        projectId: string;
        id: string;
        ownerId: string;
        checksum: string;
        sizeBytes: number;
      };
      retiredStudioExport?: {
        id: string;
        ownerId: string;
        checksum: Buffer | null;
        sizeBytes: number | null;
      };
      /**
       * Moves an unreferenced original into the file trash instead of unlinking it. An original is a path
       * with an `original` physical file row, or `original` here (an unregistered original being removed).
       */
      trash?: {
        move: PhysicalFileTrashMove;
        original?: TrashedOriginal;
      };
    } = {},
  ): Promise<{
    deleted: boolean;
    references: number;
    trashed?: boolean;
  }> {
    const shouldTrash =
      options.trash &&
      (options.trash.original ||
        (await this.db.selectFrom('physical_file').select('type').where('path', '=', path).executeTakeFirst())?.type ===
          PhysicalFileType.Original);
    const execute = async (trx: Transaction<DB>, trashId?: string) => {
      if (options.removedAssetId) {
        const kept = await trx
          .selectFrom('asset')
          .select('id')
          .where('id', '=', asUuid(options.removedAssetId))
          .executeTakeFirst();
        if (kept) {
          return { deleted: false, references: 1 };
        }
      }
      const imported = options.orphanStudioImport;
      const exported = options.retiredStudioExport;
      if (imported && exported) throw new Error('Only one Studio file identity can be released');
      if (imported) {
        // A restored project can recreate an absent ID. Do not wait in the reverse lock order
        // of its project-before-path transaction, or credit an import that has since changed.
        const lock = await sql<{
          locked: boolean;
        }>`SELECT pg_try_advisory_xact_lock(hashtextextended(
          ${`buddy-studio:${imported.projectId}`},0)) AS locked`.execute(trx);
        if (!lock.rows[0]?.locked) return { deleted: false, references: 1 };
        const orphan = await sql`SELECT item.id FROM public.studio_project_import item
          WHERE item."projectId"=${imported.projectId}::uuid AND item.id=${imported.id}::uuid
            AND item."ownerId"=${imported.ownerId}::uuid AND item.path=${path}
            AND item.checksum=${imported.checksum} AND item."sizeBytes"=${imported.sizeBytes}
            AND NOT EXISTS (SELECT 1 FROM public.studio_project project WHERE project.id=item."projectId")
          FOR UPDATE`.execute(trx);
        if (orphan.rows.length === 0) return { deleted: false, references: 1 };
      }
      if (exported) {
        const retired = await trx
          .selectFrom('studio_export_version')
          .select('id')
          .where('id', '=', exported.id)
          .where('ownerId', '=', exported.ownerId)
          .where('outputPath', '=', path)
          .where('outputRemovedAt', 'is', null)
          .where(sql<boolean>`"outputChecksum" IS NOT DISTINCT FROM ${exported.checksum}::bytea`)
          .where(sql<boolean>`"outputSizeInBytes" IS NOT DISTINCT FROM ${exported.sizeBytes}::bigint`)
          .where((eb) =>
            eb.or([
              eb('state', 'in', [StudioExportVersionState.Failed, StudioExportVersionState.Cancelled]),
              eb.and([
                eb('state', '=', StudioExportVersionState.Published),
                eb('scope', '=', StudioExportScope.Project),
                eb('projectId', 'is', null),
              ]),
            ]),
          )
          .forUpdate()
          .executeTakeFirst();
        if (!retired) return { deleted: false, references: 1 };
      }
      const physicalFile = await trx
        .selectFrom('physical_file')
        .select(['id', 'type', 'checksum', 'sizeInBytes'])
        .where('path', '=', path)
        .executeTakeFirst();
      // Only this exact orphan row may be released. Other imports, generated outputs, live
      // assets and Buddy capture pins remain references, even when owned by the same person.
      const references =
        (await this.countPathReferencesIn(trx, path, physicalFile?.id)) -
        (imported || exported ? 1 : 0) -
        (trashId ? 1 : 0);
      if (references > 0) {
        await sql`UPDATE public.buddy_backup_reference SET "deleteRequested" = true WHERE path = ${path} AND NOT released`.execute(
          trx,
        );
        return { deleted: false, references };
      }
      // universal storage: an original is never unlinked by a job. Its last copy goes to the file trash,
      // which only an administrator empties (spec §3.5); generated files are deleted as before.
      const original = options.trash?.original;
      if (options.trash && !trashId && (physicalFile?.type === PhysicalFileType.Original || original)) {
        throw new ConflictException('Original registration changed; retry file trash');
      }
      const trashed =
        options.trash && !imported && !exported && (physicalFile?.type === PhysicalFileType.Original || original)
          ? await trashUnreferencedOriginal(
              trx,
              path,
              options.trash.move,
              {
                physicalFileId: physicalFile?.id ?? null,
                checksum: physicalFile?.checksum ?? original!.checksum,
                sizeInBytes: physicalFile ? Number(physicalFile.sizeInBytes) : original!.sizeInBytes,
                lastOwnerId: original?.ownerId ?? null,
                lastAssetId: original?.assetId ?? options.removedAssetId ?? null,
                originalFileName: original?.originalFileName ?? parse(path).base,
              },
              trashId!,
            )
          : undefined;
      if (!trashed) {
        await unlink();
      }
      if (imported) {
        // The row is the durable retry intent: retain it through pin deferral and unlink failure.
        // A crash after unlink but before commit retries the same idempotent unlink next sweep.
        await sql`DELETE FROM public.studio_project_import
          WHERE "projectId"=${imported.projectId}::uuid AND id=${imported.id}::uuid`.execute(trx);
      }
      if (exported)
        await trx
          .updateTable('studio_export_version')
          .set({
            outputPath: null,
            outputRemovedAt: sql<Date>`clock_timestamp()`,
            updatedAt: sql<Date>`clock_timestamp()`,
          })
          .where('id', '=', exported.id)
          .execute();
      if (physicalFile) {
        await trx.deleteFrom('physical_file').where('id', '=', physicalFile.id).execute();
      }
      return trashed ? { deleted: true, references: 0, trashed: true } : { deleted: true, references: 0 };
    };
    return shouldTrash
      ? withFileTrashMove(
          this.db,
          path,
          options.trash!.original?.originalFileName ?? parse(path).base,
          options.trash!.move,
          execute,
        )
      : this.withPathLock(path, execute);
  }
  getMigrationCandidates(masterUserId: string) {
    return this.db
      .selectFrom('asset')
      .innerJoin('asset_exif', 'asset_exif.assetId', 'asset.id')
      .select([
        'asset.id',
        'asset.ownerId',
        'asset.originalPath',
        'asset.originalFileName',
        'asset.type',
        'asset.checksum',
        'asset.isExternal',
        'asset.isOffline',
        'asset.libraryId',
        'asset.physicalOriginalFileId',
        'asset.width',
        'asset.height',
        'asset.duration',
        'asset_exif.fileSizeInByte as sizeInBytes',
      ])
      .where('asset.ownerId', '!=', asUuid(masterUserId))
      .where('asset.deletedAt', 'is', null)
      .where('asset.status', '=', AssetStatus.Active)
      .stream();
  }
  getGeneratedFile(assetId: string, type: AssetFileType) {
    return this.db
      .selectFrom('asset_file')
      .select(['id', 'assetId', 'type', 'path', 'physicalFileId'])
      .where('assetId', '=', asUuid(assetId))
      .where('type', '=', type)
      .where('isEdited', '=', false)
      .executeTakeFirst();
  }
  getGeneratedFiles(assetId: string) {
    return this.db
      .selectFrom('asset_file')
      .select(['id', 'assetId', 'type', 'path', 'physicalFileId'])
      .where('assetId', '=', asUuid(assetId))
      .where('type', 'in', [
        AssetFileType.Thumbnail,
        AssetFileType.Preview,
        AssetFileType.FullSize,
        AssetFileType.EncodedVideo,
      ])
      .where('isEdited', '=', false)
      .execute();
  }
  private toPhysicalFileType(type: AssetFileType) {
    switch (type) {
      case AssetFileType.Thumbnail: {
        return PhysicalFileType.Thumbnail;
      }
      case AssetFileType.Preview: {
        return PhysicalFileType.Preview;
      }
      case AssetFileType.FullSize: {
        return PhysicalFileType.FullSize;
      }
      case AssetFileType.EncodedVideo: {
        return PhysicalFileType.EncodedVideo;
      }
      default: {
        throw new Error(`Unsupported physical generated file type: ${type}`);
      }
    }
  }
}
