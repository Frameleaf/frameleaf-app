import { stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { v5 } from 'uuid';
import {
  AssetLockReason,
  MediaHealthCategory,
  MediaHealthSeverity,
  MediaHealthStatus,
  SystemMetadataKey,
} from 'src/enum.js';
import {
  CONTENT_TABLES,
  DEFERRED_COLUMNS,
  PATH_COLUMNS,
  clusterId,
  digest,
  transformRow,
  vectorCompatible,
} from 'src/immich-import/adapters.js';
import { assertCanonicalDestination } from 'src/immich-import/destination-schema.js';
import { EmbeddingAdmission, inspectEmbeddingAdmission } from 'src/immich-import/embeddings.js';
import {
  LostOriginalReason,
  isUnmappedPath,
  lostOriginalPath,
  lostOriginalReason,
  mapInOrder,
  mapMediaPath,
  pathChecksum,
  verifyMediaFile,
  verifyMediaRoots,
} from 'src/immich-import/media.js';
import { ImmichSource } from 'src/immich-import/source.js';
import { getImmichImportState } from 'src/immich-import/state.js';
import { ImportConfig, ImportDatabase, ImportRefused, ImportRow, quote } from 'src/immich-import/types.js';
import { assertFreshImportDestination } from 'src/library-import/admission.js';
import { LIBRARY_IMPORT_LOCK as IMPORT_LOCK } from 'src/library-import/lock.js';
import { folderFacts } from 'src/utils/file-fix.js';
import { deriveIsNsfwFromMetadata } from 'src/utils/nsfw.js';

const localColumns = new Set(['updateId', 'createId']);
const LOST_REPORT_ITEMS = 1000;
const LOST_REASON_TEXT: Record<LostOriginalReason, string> = {
  missing: 'already missing in the source library',
  changed: 'changed since the source library recorded them',
  unmapped: 'outside the imported media folders',
};
const unlocked = (asset: string) => `NOT EXISTS (SELECT 1 FROM public.asset_lock l WHERE l."assetId"=${asset})`;
const lockedFace = `NOT ${unlocked('(SELECT f."assetId" FROM public.asset_face f WHERE f.id=s."faceAssetId")')}`;
/** Columns `convertLocks` rewrites. Verification accepts a changed value only where a lock explains it, and
 * only a value the conversion could have written. */
const LOCK_REWRITES: Record<string, Record<string, string>> = {
  asset: {
    visibility: `s.visibility='locked' AND NOT ${unlocked('d.id')}
      AND d.visibility=CASE WHEN EXISTS (SELECT 1 FROM public.asset still WHERE still."livePhotoVideoId"=d.id)
        THEN 'hidden' ELSE 'timeline' END::asset_visibility_enum`,
  },
  album: {
    // Replaced by an unlocked, undeleted photo of the same album, or none.
    albumThumbnailAssetId: `NOT ${unlocked('s."albumThumbnailAssetId"')} AND (d."albumThumbnailAssetId" IS NULL
      OR EXISTS (SELECT 1 FROM public.album_asset aa JOIN public.asset a ON a.id=aa."assetId" AND a."deletedAt" IS NULL
        WHERE aa."albumId"=d.id AND aa."assetId"=d."albumThumbnailAssetId" AND ${unlocked('a.id')}))`,
  },
  person: {
    // Replaced by a visible face of the same person on unlocked media, or none, with a thumbnail to regenerate.
    faceAssetId: `${lockedFace} AND (d."faceAssetId" IS NULL OR EXISTS (SELECT 1 FROM public.asset_face f
      WHERE f.id=d."faceAssetId" AND f."personGroupId"=d."personGroupId" AND f."deletedAt" IS NULL
        AND f."isVisible" IS TRUE AND ${unlocked('f."assetId"')}))`,
    thumbnailPath: `${lockedFace} AND d."thumbnailPath"=''`,
  },
};

// Serialized row/checkpoint parameters enter as text so postgres.js does not JSON-encode them again.
export class ImmichImportService {
  readonly source: ImmichSource;
  private embeddingAdmission?: EmbeddingAdmission;
  /** Originals kept without a verified file, collected by the verification pass for the owners' report. */
  private lostOriginals = new Map<string, { reason: LostOriginalReason; immichPath: string }>();
  constructor(
    readonly destination: ImportDatabase,
    source: ImportDatabase,
    readonly config: ImportConfig,
  ) {
    this.source = new ImmichSource(source, config);
  }

  status() {
    return getImmichImportState(this.destination);
  }

  async preflight() {
    await verifyMediaRoots(this.config.mediaRoots, this.config.media);
    const fingerprint = await this.source.preflight();
    await this.assertDistinctDestination();
    await assertCanonicalDestination(this.destination);
    this.embeddingAdmission = await inspectEmbeddingAdmission(this.source.db, this.destination);
    const [run] = await this.destination.query(
      'SELECT status,source_fingerprint,config_fingerprint FROM public.frameleaf_immich_import',
    );
    if (run) {
      if (run.source_fingerprint !== fingerprint || run.config_fingerprint !== digest(this.config)) {
        throw new ImportRefused('RESUME_SOURCE_OR_CONFIGURATION_CHANGED');
      }
      if (run.status === 'abandoned') {
        throw new ImportRefused('ABANDONED_DESTINATION_REQUIRES_FRESH_DATABASE');
      }
    } else {
      await assertFreshImportDestination(this.destination);
    }
    return {
      embeddings: Object.entries(this.embeddingAdmission).map(([table, evidence]) => ({
        table,
        sourceDimensions: evidence.sourceDimensions,
        destinationDimensions: evidence.destinationDimensions,
        action: 'regenerate',
        reason: 'SOURCE_PRODUCER_MODEL_UNRECORDED',
      })),
      sourceVersion: this.config.version,
      sourceCommit: this.source.fixture.commit,
      notImported: this.source.notImported,
      fingerprint,
      status: run?.status ?? 'fresh',
    };
  }

  async run(resume = false): Promise<void> {
    await this.exclusive(async () => {
      const report = await this.preflight();
      if (report.status === 'activated') {
        throw new ImportRefused('IMPORT_ALREADY_ACTIVATED');
      }
      if (resume === (report.status === 'fresh')) {
        throw new ImportRefused(resume ? 'NO_IMPORT_TO_RESUME' : 'USE_RESUME_FOR_PARTIAL_IMPORT');
      }
      if (!resume) {
        await this.destination.query(
          `INSERT INTO public.frameleaf_immich_import
          (source_fingerprint,config_fingerprint,source_version,status) VALUES ($1,$2,$3,'copying')`,
          [report.fingerprint, digest(this.config), this.config.version],
        );
      }
      for (const table of CONTENT_TABLES) {
        if (this.source.fixture.tables[table]) {
          await this.copyTable(table);
        }
      }
      // Cyclic nullable relationships are patched only once both endpoints exist.
      for (const table of Object.keys(DEFERRED_COLUMNS)) {
        if (this.deferredColumns(table).length === 0) continue;
        for await (const batch of this.source.batches(table)) {
          await this.destination.transaction(async (db) => {
            for (const { row } of batch) {
              const mapped = transformRow(table, row, this.legacyPeople);
              await this.patchReferences(db, table, mapped);
            }
          });
        }
      }
      await this.buildAlbumTree();
      await this.convertLocks();
      await this.copyMediaLocation();
      await this.destination.query("UPDATE public.frameleaf_immich_import SET status='verifying'");
    });
  }

  async verify(dispatchWork: (config: ImportConfig) => Promise<unknown>): Promise<void> {
    await this.exclusive(async () => {
      const report = await this.preflight();
      if (report.status !== 'verifying') {
        throw new ImportRefused('IMPORT_COPY_NOT_COMPLETE');
      }
      const incomplete = await this.destination.query(
        'SELECT 1 FROM public.frameleaf_immich_import_checkpoint WHERE NOT complete LIMIT 1',
      );
      if (incomplete.length > 0) {
        throw new ImportRefused('INCOMPLETE_CHECKPOINTS');
      }
      this.lostOriginals.clear();
      for (const table of CONTENT_TABLES) {
        if (!this.source.fixture.tables[table]) {
          continue;
        }
        let expected = 0;
        for await (const batch of this.source.batches(table)) {
          for (const mapped of await mapInOrder(batch, ({ row }) => this.mapRow(table, row))) {
            if (mapped) {
              expected++;
              await this.verifyRow(table, mapped);
            }
          }
        }
        const [count] = await this.destination.query(`SELECT count(*)::text AS count FROM public.${quote(table)}`);
        if (count.count !== String(expected)) {
          throw new ImportRefused('DESTINATION_CARDINALITY_MISMATCH');
        }
      }
      await this.verifyRelationships();
      if ((await this.destination.query(`SELECT 1 FROM public.asset WHERE visibility='locked' LIMIT 1`)).length > 0) {
        throw new ImportRefused('LOCKED_FOLDER_NOT_CONVERTED');
      }
      // Detect source changes since the copy, including changes during verification.
      if ((await this.source.preflight()) !== report.fingerprint) {
        throw new ImportRefused('SOURCE_CHANGED_DURING_VERIFICATION');
      }
      await this.queueMissingDerivedWork();
      await dispatchWork(this.config);
      const [pending] = await this.destination.query(
        'SELECT count(*)::text AS count FROM public.frameleaf_immich_import_work WHERE dispatched_at IS NULL',
      );
      if (pending.count !== '0') {
        throw new ImportRefused('DERIVED_WORK_NOT_DURABLY_DISPATCHED');
      }
      // These are fresh pgvector indexes on the destination, never copied from upstream.
      await this.destination.query('REINDEX INDEX public.clip_index');
      await this.destination.query('REINDEX INDEX public.face_index');
      // Recheck after verification/dispatch: an intact ledger does not authorize schema drift.
      await assertCanonicalDestination(this.destination);
      await verifyMediaRoots(this.config.mediaRoots, this.config.media);
      await this.rememberSourceRoots();
      await this.recordLostOriginalProblems();
      await this.reportLostOriginals(report.fingerprint);
      await this.reportNotImported(report.fingerprint);
      await this.destination.query(
        "UPDATE public.frameleaf_immich_import SET status='activated',verified_at=now() WHERE status='verifying'",
      );
    });
  }

  async abandon(): Promise<void> {
    await this.exclusive(async () => {
      const result = await this.destination.query(`UPDATE public.frameleaf_immich_import SET status='abandoned'
        WHERE status IN ('copying','verifying') RETURNING status`);
      if (result.length !== 1) {
        throw new ImportRefused('NO_PARTIAL_IMPORT_TO_ABANDON');
      }
    });
  }

  private get legacyPeople(): boolean {
    return !this.source.fixture.tables.cluster_group;
  }

  private async exclusive(body: () => Promise<void>): Promise<void> {
    const [lock] = await this.destination.query('SELECT pg_try_advisory_lock($1::bigint) AS acquired', [IMPORT_LOCK]);
    if (!lock.acquired) {
      throw new ImportRefused('IMPORT_ALREADY_RUNNING');
    }
    try {
      await body();
    } finally {
      await this.destination.query('SELECT pg_advisory_unlock($1::bigint)', [IMPORT_LOCK]);
    }
  }

  private async assertDistinctDestination(): Promise<void> {
    const statement = `SELECT system_identifier::text AS system_identifier,
      (SELECT oid::text FROM pg_database WHERE datname=current_database()) AS database_oid FROM pg_control_system()`;
    const [source, target] = await Promise.all([this.source.db.query(statement), this.destination.query(statement)]);
    if (digest(source) === digest(target)) {
      throw new ImportRefused('SOURCE_IS_DESTINATION');
    }
    const [version] = await this.destination.query("SELECT current_setting('server_version_num')::int AS version");
    if (Number(version.version) < 190_000 || Number(version.version) >= 200_000) {
      throw new ImportRefused('DESTINATION_REQUIRES_POSTGRES_19');
    }
    const extensions = await this.destination.query(
      "SELECT extname FROM pg_extension WHERE extname IN ('vector','vectors','vchord')",
    );
    if (extensions.length !== 1 || extensions[0].extname !== 'vector') {
      throw new ImportRefused('DESTINATION_REQUIRES_PGVECTOR_ONLY');
    }
    const indexes = await this.destination.query(`SELECT c.relname, am.amname, pg_get_indexdef(c.oid) AS definition
      FROM pg_class c JOIN pg_am am ON am.oid=c.relam
      JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname IN ('clip_index','face_index')`);
    if (
      indexes.length !== 2 ||
      indexes.some((index) => index.amname !== 'hnsw' || !String(index.definition).includes('vector_cosine_ops'))
    ) {
      throw new ImportRefused('DESTINATION_REQUIRES_PGVECTOR_HNSW');
    }
  }

  private async copyTable(table: string): Promise<void> {
    const [checkpoint] = await this.destination.query(
      'SELECT cursor,complete FROM public.frameleaf_immich_import_checkpoint WHERE table_name=$1',
      [table],
    );
    if (checkpoint?.complete) {
      return;
    }
    for await (const batch of this.source.batches(table, (checkpoint?.cursor as string[] | null) ?? null)) {
      const mapped = await mapInOrder(batch, async (item) => ({ ...item, mapped: await this.mapRow(table, item.row) }));
      await this.destination.transaction(async (db) => {
        for (const { row, mapped: target } of mapped) {
          if (!target) {
            continue;
          }
          if (this.legacyPeople && table === 'user') {
            await this.insert(db, 'cluster_group', { id: target.clusterGroupId });
          }
          if (this.legacyPeople && table === 'person') {
            await this.insert(db, 'person_group', {
              id: target.personGroupId,
              clusterGroupId: clusterId(String(target.ownerId)),
            });
          }
          const initial = { ...target };
          for (const column of this.deferredColumns(table)) {
            initial[column] = null;
          }
          await this.insert(db, table, initial);
          if (table === 'asset') {
            // Missing output repair is durably resolved at verification.
            await db.query(
              `INSERT INTO public.frameleaf_immich_import_work(asset_id,kind) VALUES ($1,'metadata') ON CONFLICT DO NOTHING`,
              [row.id],
            );
          }
        }
        await db.query(
          `INSERT INTO public.frameleaf_immich_import_checkpoint(table_name,cursor,row_count)
          VALUES ($1,$2::text::jsonb,$3) ON CONFLICT(table_name) DO UPDATE SET cursor=excluded.cursor,
          row_count=frameleaf_immich_import_checkpoint.row_count+excluded.row_count`,
          [table, JSON.stringify(batch.at(-1)!.cursor), batch.length],
        );
      });
    }
    await this.destination.query(
      `INSERT INTO public.frameleaf_immich_import_checkpoint(table_name,complete)
      VALUES ($1,true) ON CONFLICT(table_name) DO UPDATE SET complete=true`,
      [table],
    );
  }

  /** Every album needs its closure self row, and fork albums their ancestors, as the album repository writes
   * them. Parents become collections and keep their nesting, as the in-place upgrade did
   * (2100000000080-AddAlbumKind). Idempotent, so a resumed run repeats it. */
  private async buildAlbumTree(): Promise<void> {
    // UNION, not UNION ALL: a fork tree saved before its cycle guard (2100000000020) still terminates.
    await this.destination.query(`INSERT INTO public.album_closure(id_ancestor,id_descendant)
      WITH RECURSIVE tree(id_ancestor,id_descendant) AS (
        SELECT id,id FROM public.album
        UNION SELECT a."parentId",t.id_descendant FROM tree t JOIN public.album a ON a.id=t.id_ancestor
        WHERE a."parentId" IS NOT NULL)
      SELECT id_ancestor,id_descendant FROM tree ON CONFLICT DO NOTHING`);
    await this.destination.query(`UPDATE public.album SET kind='collection' WHERE kind='album'
      AND id IN (SELECT "parentId" FROM public.album WHERE "parentId" IS NOT NULL)
      AND id NOT IN (SELECT "albumId" FROM public.smart_album)`);
  }

  /** Frameleaf locks with `asset_lock` records, never `visibility = locked` (src/utils/locked.ts). Carries the
   * upstream Locked folder and the fork's Mark Sensitive over exactly as 2100000000320-AddAssetLock did for an
   * in-place upgrade: whole stacks and live photos lock, and locked media stops being a cover or face thumbnail.
   * Idempotent, so a resumed run repeats it. */
  private async convertLocks(): Promise<void> {
    await this.destination.query(
      `INSERT INTO public.asset_lock("assetId",reason,"lockedAt","previousVisibility")
      SELECT id,$1,"updatedAt",'locked' FROM public.asset WHERE visibility='locked' ON CONFLICT DO NOTHING`,
      [AssetLockReason.FrameleafLockedFolder],
    );
    await this.destination.query(`UPDATE public.asset SET visibility=CASE
      WHEN EXISTS (SELECT 1 FROM public.asset still WHERE still."livePhotoVideoId"=asset.id) THEN 'hidden'
      ELSE 'timeline' END::asset_visibility_enum WHERE visibility='locked'`);
    // Owner marks come from the imported ml-enrichment review.
    await this.destination.query(
      `INSERT INTO public.asset_lock("assetId",reason,"lockedAt")
      SELECT "assetId",$1,"updatedAt" FROM public.asset_metadata
      WHERE key='ml-enrichment' AND value #>> '{nsfwDetection,review,isNsfw}'='true' ON CONFLICT DO NOTHING`,
      [AssetLockReason.Marked],
    );
    // The fork-only asset.is_nsfw column is not in the copied shape; rebuild it with the server's own rule
    // (deriveIsNsfwFromMetadata: a review decides, else a successful detection, else a high-confidence description
    // with strong indicators). SQL only narrows the candidates. Detections hid media only while the source's "hide
    // sensitive detections from the library" switch was on; then they lock, as 2100000000320 did.
    const candidates = await this.destination.query(`SELECT "assetId" AS id, value FROM public.asset_metadata
      WHERE key='ml-enrichment' AND (value #>> '{nsfwDetection,review,isNsfw}'='true'
        OR value #>> '{nsfwDetection,result,isNsfw}'='true' OR value #>> '{description,result,safety,is_nsfw_likely}'='true')`);
    const sensitive = candidates.filter((row) => deriveIsNsfwFromMetadata(row.value) === true).map((row) => row.id);
    for (let index = 0; index < sensitive.length; index += 10_000) {
      await this.destination.query(
        `UPDATE public.asset SET is_nsfw=true WHERE NOT is_nsfw
        AND id IN (SELECT jsonb_array_elements_text($1::text::jsonb)::uuid)`,
        [JSON.stringify(sensitive.slice(index, index + 10_000))],
      );
    }
    const [hiding] = await this.source.db.query(
      `SELECT value #>> '{machineLearning,nsfwDetection,hideFromLibrary}' AS enabled
      FROM public.system_metadata WHERE key='system-config'`,
    );
    if (hiding?.enabled === 'true') {
      await this.destination.query(
        `INSERT INTO public.asset_lock("assetId",reason) SELECT id,$1 FROM public.asset WHERE is_nsfw ON CONFLICT DO NOTHING`,
        [AssetLockReason.Detected],
      );
    }
    // Stacks and live photos lock as a whole, from any member or either part. Repeat until no lock is added,
    // so a lock reached through one relationship spreads through the others.
    for (let added = true; added;) {
      added = false;
      for (const select of [
        `SELECT still.id,l.reason,l."lockedAt",l."lockedBy" FROM public.asset_lock l
          JOIN public.asset still ON still."livePhotoVideoId"=l."assetId"`,
        `SELECT member.id,source.reason,source."lockedAt",source."lockedBy" FROM public.asset member
          JOIN (SELECT DISTINCT ON (a."stackId") a."stackId",l.reason,l."lockedAt",l."lockedBy"
            FROM public.asset_lock l JOIN public.asset a ON a.id=l."assetId" JOIN public.stack s ON s.id=a."stackId"
            ORDER BY a."stackId",(a.id=s."primaryAssetId") DESC,l."lockedAt") source ON source."stackId"=member."stackId"`,
        `SELECT still."livePhotoVideoId",l.reason,l."lockedAt",l."lockedBy" FROM public.asset_lock l
          JOIN public.asset still ON still.id=l."assetId" WHERE still."livePhotoVideoId" IS NOT NULL`,
      ]) {
        const rows = await this.destination.query(`INSERT INTO public.asset_lock("assetId",reason,"lockedAt","lockedBy")
          ${select} ON CONFLICT DO NOTHING RETURNING 1`);
        added ||= rows.length > 0;
      }
    }
    await this.destination.query(`UPDATE public.album SET "albumThumbnailAssetId"=(
        SELECT aa."assetId" FROM public.album_asset aa JOIN public.asset a ON a.id=aa."assetId" AND a."deletedAt" IS NULL
          AND NOT EXISTS (SELECT 1 FROM public.asset_lock l WHERE l."assetId"=a.id)
        WHERE aa."albumId"=album.id ORDER BY a."fileCreatedAt" DESC LIMIT 1)
      WHERE "albumThumbnailAssetId" IN (SELECT "assetId" FROM public.asset_lock)`);
    await this.destination.query(`UPDATE public.person SET "faceAssetId"=(
        SELECT f.id FROM public.asset_face f JOIN public.asset a ON a.id=f."assetId"
          AND NOT EXISTS (SELECT 1 FROM public.asset_lock l WHERE l."assetId"=a.id)
        WHERE f."personGroupId"=person."personGroupId" AND f."deletedAt" IS NULL AND f."isVisible" IS TRUE
        ORDER BY a."deletedAt" IS NOT NULL,a."fileCreatedAt" DESC LIMIT 1),"thumbnailPath"=''
      WHERE "faceAssetId" IN (SELECT f.id FROM public.asset_face f JOIN public.asset_lock l ON l."assetId"=f."assetId")`);
  }

  /** Imported paths start with the source's media root; without its saved location the server assumes the
   * legacy default on first boot and refuses to start (InconsistentMediaLocation). Overwrites the fresh
   * destination's own value, which described no assets. */
  private async copyMediaLocation(): Promise<void> {
    const [saved] = await this.source.db.query(
      `SELECT value->>'location' AS location FROM public.system_metadata WHERE key='MediaLocation'`,
    );
    const location = saved?.location;
    if (typeof location !== 'string' || !location) {
      return;
    }
    let target: string;
    try {
      target = mapMediaPath(location, this.config.mediaRoots, this.config.media).target;
    } catch {
      // ponytail: an unmapped or relative root keeps the server's own path-based inference.
      return;
    }
    await this.destination.query(
      `INSERT INTO public.system_metadata(key,value) VALUES ('MediaLocation',$1::text::jsonb)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
      [JSON.stringify({ location: target })],
    );
  }

  private async mapRow(table: string, source: ImportRow): Promise<ImportRow | null> {
    const row = transformRow(table, source, this.legacyPeople);
    if (
      (table === 'smart_search' || table === 'face_search') &&
      !vectorCompatible(row.embedding, this.embeddingAdmission?.[table])
    ) {
      return null;
    }
    for (const column of PATH_COLUMNS[table] ?? []) {
      const path = row[column];
      if (typeof path === 'string' && path) {
        try {
          row[column] = await verifyMediaFile(
            path,
            this.config.mediaRoots,
            table === 'asset' ? String(row.checksum) : undefined,
            table === 'asset' ? String(row.checksumAlgorithm) : undefined,
            this.config.media,
          );
        } catch (error) {
          // Missing regenerable output is allowed; originals and profile images are never silently dropped.
          const lost =
            table === 'asset' ? await lostOriginalReason(error, path, this.config.mediaRoots, this.config.media) : null;
          if (lost) {
            row[column] = lostOriginalPath(path, lost, this.config.mediaRoots, this.config.media);
            this.lostOriginals.set(String(row.id), { reason: lost, immichPath: path });
          } else if (
            (error as NodeJS.ErrnoException).code === 'ENOENT' &&
            (table === 'asset_file' || table === 'person')
          ) {
            if (table === 'asset_file') {
              return null;
            }
            row[column] = '';
          } else {
            throw error;
          }
        }
      }
    }
    if (table === 'asset' && row.checksumAlgorithm === 'sha1-path') {
      if (row.isExternal !== true || !row.libraryId || typeof row.originalPath !== 'string') {
        throw new ImportRefused('PATH_CHECKSUM_REQUIRES_EXTERNAL_LIBRARY_ASSET');
      }
      // Source verification used the upstream path. Destination identity must use its mapped path.
      row.checksum = String.raw`\x${pathChecksum(row.originalPath)}`;
    }
    if (table === 'library') {
      // An unmapped import path is kept as it was: the library's own scan marks its items offline.
      row.importPaths = (row.importPaths as string[]).map((path) => {
        try {
          return mapMediaPath(path, this.config.mediaRoots, this.config.media).target;
        } catch (error) {
          if (!isUnmappedPath(error)) throw error;
          return path;
        }
      });
    }
    return row;
  }

  private async insert(db: ImportDatabase, table: string, row: ImportRow): Promise<void> {
    const columns = Object.keys(row).filter((column) => !localColumns.has(column));
    await db.query(
      `INSERT INTO public.${quote(table)} (${columns.map((column) => quote(column)).join(',')})
      SELECT ${columns.map((column) => quote(column)).join(',')} FROM jsonb_populate_record(NULL::public.${quote(table)},$1::text::jsonb)`,
      [JSON.stringify(row)],
    );
  }

  /** Deferred columns this source has: fork album nesting only exists on fork sources. */
  private deferredColumns(table: string): string[] {
    const columns = this.source.fixture.tables[table]?.columns ?? [];
    return (DEFERRED_COLUMNS[table] ?? []).filter((column) => columns.includes(column));
  }

  private targetKeys(table: string): string[] {
    return table === 'person' && this.legacyPeople
      ? ['ownerId', 'personGroupId']
      : this.source.fixture.tables[table].key;
  }

  private async patchReferences(db: ImportDatabase, table: string, row: ImportRow): Promise<void> {
    const columns = this.deferredColumns(table);
    const keys = this.targetKeys(table);
    await db.query(
      `UPDATE public.${quote(table)} d SET ${columns.map((column) => `${quote(column)}=s.${quote(column)}`).join(',')}
      FROM jsonb_populate_record(NULL::public.${quote(table)},$1::text::jsonb) s
      WHERE ${keys.map((key) => `d.${quote(key)}=s.${quote(key)}`).join(' AND ')}`,
      [JSON.stringify(row)],
    );
  }

  private async verifyRow(table: string, row: ImportRow): Promise<void> {
    // Reference restoration fires updatedAt triggers; sync identities belong to Frameleaf.
    const columns = Object.keys(row).filter((column) => !localColumns.has(column) && column !== 'updatedAt');
    const keys = this.targetKeys(table);
    const records = await this.destination.query(
      `SELECT 1 FROM public.${quote(table)} d,
      jsonb_populate_record(NULL::public.${quote(table)},$1::text::jsonb) s
      WHERE ${keys.map((key) => `d.${quote(key)}=s.${quote(key)}`).join(' AND ')}
      AND ${columns
        .map((column) => {
          const same = `d.${quote(column)} IS NOT DISTINCT FROM s.${quote(column)}`;
          const rewrite = LOCK_REWRITES[table]?.[column];
          return rewrite ? `(${same} OR (${rewrite}))` : same;
        })
        .join(' AND ')}`,
      [JSON.stringify(row)],
    );
    if (records.length !== 1) {
      throw new ImportRefused('DESTINATION_ROW_OR_PERMISSION_MISMATCH');
    }
  }

  private async verifyRelationships(): Promise<void> {
    // Check all actual canonical FKs without disabling constraints or trusting source triggers.
    const constraints = await this.destination.query(`SELECT c.relname AS child, p.relname AS parent,
      array_agg(a.attname ORDER BY k.ordinality) AS child_columns,
      array_agg(b.attname ORDER BY k.ordinality) AS parent_columns
      FROM pg_constraint f JOIN pg_class c ON c.oid=f.conrelid JOIN pg_class p ON p.oid=f.confrelid
      JOIN pg_namespace n ON n.oid=c.relnamespace
      CROSS JOIN LATERAL unnest(f.conkey,f.confkey) WITH ORDINALITY k(child_key,parent_key,ordinality)
      JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum=k.child_key
      JOIN pg_attribute b ON b.attrelid=p.oid AND b.attnum=k.parent_key
      WHERE f.contype='f' AND n.nspname='public' GROUP BY f.oid,c.relname,p.relname`);
    for (const constraint of constraints) {
      const child = constraint.child_columns as string[];
      const parent = constraint.parent_columns as string[];
      const invalid = await this.destination.query(`SELECT 1 FROM public.${quote(String(constraint.child))} c
        WHERE ${child.map((column) => `c.${quote(column)} IS NOT NULL`).join(' AND ')}
        AND NOT EXISTS (SELECT 1 FROM public.${quote(String(constraint.parent))} p
          WHERE ${child.map((column, i) => `p.${quote(parent[i])}=c.${quote(column)}`).join(' AND ')}) LIMIT 1`);
      if (invalid.length > 0) {
        throw new ImportRefused('DESTINATION_RELATIONSHIP_MISMATCH');
      }
    }
  }

  /**
   * Tell each owner which originals came across without a usable file, with what the database knows
   * about each one, and give administrators the whole list. The photos stay in the library: a
   * re-upload restores one, and Library care searches for the rest. Derived ids make a repeated
   * verification idempotent.
   */
  /** Tell administrators which Noodle Gallery features held data that stayed in the source. */
  private async reportNotImported(fingerprint: string): Promise<void> {
    const names = this.source.notImported;
    if (names.length === 0) {
      return;
    }
    const admins = await this.destination.query(`SELECT id FROM public."user" WHERE "isAdmin" AND "deletedAt" IS NULL`);
    for (const { id } of admins) {
      await this.destination.query(
        `INSERT INTO public.notification (id, "userId", level, type, title, description, data)
        VALUES ($1::uuid, $2::uuid, 'warning', 'SystemMessage', $3, $4, $5::text::jsonb) ON CONFLICT (id) DO NOTHING`,
        [
          v5(JSON.stringify(['noodle-gallery-not-imported', fingerprint, id]), v5.URL),
          id,
          'Some Noodle Gallery data was not imported',
          `Frameleaf doesn't have these Noodle Gallery features yet, so they stayed behind: ${names.join(', ')}. ` +
            'Your photos, albums and people came across, and your Noodle Gallery database still holds the rest.',
          JSON.stringify({ kind: 'noodle-gallery-not-imported', items: names }),
        ],
      );
    }
  }

  /** Keeps the folders Immich read from, so Library care's contents search looks there while they are mounted. */
  private async rememberSourceRoots(): Promise<void> {
    await this.destination.query(
      `INSERT INTO public.system_metadata(key,value) VALUES ('${SystemMetadataKey.FileFixSourceRoots}',$1::text::jsonb)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
      [JSON.stringify([...new Set(this.config.mediaRoots.map(({ source }) => source))])],
    );
  }

  /**
   * FL-1337: each lost original gets its Missing problem with the first lines of its history: that it came
   * from Immich and from where, and, when Immich's own move record names where it was headed, whether
   * anything is there. Safe to repeat: a problem that exists already is left as it is, with no second copy
   * of its history. The nightly file check hands the problem to the automatic fix.
   */
  private async recordLostOriginalProblems(): Promise<void> {
    if (this.lostOriginals.size === 0) {
      return;
    }
    const ids = this.lostOriginals.keys().toArray();
    const moves = await this.source.intendedPaths(ids);
    const assets = await this.destination.query(
      `SELECT a.id, a."ownerId", u."storageLabel", a."originalFileName", a."originalPath", a."isExternal", a."libraryId"
      FROM public.asset a JOIN public."user" u ON u.id = a."ownerId"
      WHERE a.id IN (SELECT jsonb_array_elements_text($1::text::jsonb)::uuid)`,
      [JSON.stringify(ids)],
    );
    for (const asset of assets) {
      const id = String(asset.id);
      const lost = this.lostOriginals.get(id);
      if (!lost) continue;
      const within = (side: 'source' | 'target') =>
        this.config.mediaRoots.flatMap((root) => [
          join(root[side], 'library', String(asset.storageLabel || asset.ownerId)),
          join(root[side], 'upload', String(asset.ownerId)),
          join(root[side], String(asset.storageLabel || asset.ownerId)),
          join(root[side], String(asset.ownerId)),
        ]);
      // only inside the owner's own folders, else just the file name: nothing here names another account
      const relative = (roots: string[], path: string) => {
        const { folder, name } = folderFacts(roots, path);
        return name === undefined ? basename(path) : folder ? `${folder}/${name}` : name;
      };
      const steps: Array<Record<string, unknown>> = [
        {
          step: 'imported',
          outcome: 'failed',
          facts: { source: 'Immich', sourcePath: relative(within('source'), lost.immichPath) },
        },
      ];
      const moveTo = moves.get(id);
      let intended: string | undefined;
      if (moveTo) {
        try {
          intended = mapMediaPath(moveTo, this.config.mediaRoots, this.config.media).target;
        } catch {
          // a path outside every imported folder says nothing we can look at
        }
      }
      if (intended) {
        const exists = await stat(intended)
          .then(() => true)
          .catch(() => false);
        const facts = folderFacts(within('target'), intended);
        (steps[0].facts as Record<string, unknown>).intendedPath = relative(within('target'), intended);
        steps.push({ step: 'looked-where-moving', outcome: exists ? 'ok' : 'not-found', facts });
      }
      await this.destination.query(
        `WITH f AS (
          INSERT INTO public.asset_health ("assetId", category, status, severity, "originalPath", "originalFileName",
            evidence, resolution, "checkedAt")
          VALUES ($1::uuid, $2, $3, $4, $5, $6, $7::text::jsonb, $8::text::jsonb, now())
          ON CONFLICT ("assetId", category) DO NOTHING RETURNING id, "assetId")
        INSERT INTO public.asset_health_step ("healthId", "assetId", at, step, outcome, facts)
        SELECT f.id, f."assetId", clock_timestamp() + s.ord * interval '1 millisecond',
          s.item->>'step', s.item->>'outcome', coalesce(s.item->'facts', '{}'::jsonb)
        FROM f CROSS JOIN jsonb_array_elements($9::text::jsonb) WITH ORDINALITY AS s(item, ord)`,
        [
          id,
          MediaHealthCategory.Missing,
          MediaHealthStatus.Missing,
          MediaHealthSeverity.Critical,
          String(asset.originalPath),
          String(asset.originalFileName),
          JSON.stringify({ reason: 'source_file_missing_or_unreadable', source: 'import', lostReason: lost.reason }),
          JSON.stringify({ autoRelinkable: !!asset.isExternal && !!asset.libraryId }),
          JSON.stringify(steps),
        ],
      );
    }
  }

  private async reportLostOriginals(fingerprint: string): Promise<void> {
    if (this.lostOriginals.size === 0) {
      return;
    }
    const rows = await this.destination.query(
      `SELECT a.id, a."ownerId", u.name AS "ownerName", u.email AS "ownerEmail", a."originalFileName",
        a."originalPath", a.type, a."fileCreatedAt", a."createdAt", a."deletedAt", a.visibility,
        a."libraryId", a."isExternal", a.width, a.height, encode(a.checksum, 'hex') AS checksum,
        a."checksumAlgorithm", e."fileSizeInByte", e."dateTimeOriginal", e.make, e.model
      FROM public.asset a JOIN public."user" u ON u.id = a."ownerId"
      LEFT JOIN public.asset_exif e ON e."assetId" = a.id
      WHERE a.id IN (SELECT jsonb_array_elements_text($1::text::jsonb)::uuid)
      ORDER BY u.name, a."fileCreatedAt", a.id`,
      [JSON.stringify(this.lostOriginals.keys().toArray())],
    );
    const items = rows.map((row) => ({
      ...row,
      ...this.lostOriginals.get(String(row.id)),
    })) as Array<Record<string, unknown> & { ownerId: string; ownerName: string; reason: LostOriginalReason }>;
    const byOwner = Map.groupBy(items, (item) => item.ownerId);
    const admins = await this.destination.query(`SELECT id FROM public."user" WHERE "isAdmin" AND "deletedAt" IS NULL`);
    const send = async (userId: string, scope: string, list: typeof items, title: string, accounts?: string) => {
      const reasons = Object.entries(Object.groupBy(list, (item) => item.reason))
        .map(([reason, entries]) => `${entries!.length} ${LOST_REASON_TEXT[reason as LostOriginalReason]}`)
        .join(', ');
      const names = list.slice(0, 10).map((item) => item.originalFileName);
      const more = list.length > names.length ? ` and ${list.length - names.length} more` : '';
      const description =
        `${reasons}. ${accounts ?? ''}Files: ${names.join(', ')}${more}. ` +
        'They are still in the library. Upload a file again to restore it, or open Library care to search for it.';
      await this.destination.query(
        `INSERT INTO public.notification (id, "userId", level, type, title, description, data)
        VALUES ($1::uuid, $2::uuid, 'warning', 'SystemMessage', $3, $4, $5::text::jsonb) ON CONFLICT (id) DO NOTHING`,
        [
          v5(JSON.stringify(['immich-import-lost-originals', fingerprint, scope, userId]), v5.URL),
          userId,
          title,
          description,
          // ponytail: the first LOST_REPORT_ITEMS rows ride along; Library care holds the complete list.
          JSON.stringify({
            kind: 'immich-import-lost-originals',
            total: list.length,
            items: list.slice(0, LOST_REPORT_ITEMS),
          }),
        ],
      );
    };
    for (const [ownerId, list] of byOwner) {
      await send(
        ownerId,
        'owner',
        list,
        `${list.length} imported ${list.length === 1 ? 'original needs' : 'originals need'} attention`,
      );
    }
    if (byOwner.size > 1 || admins.some(({ id }) => !byOwner.has(String(id)))) {
      const accounts = byOwner
        .values()
        .map((list) => `${list[0].ownerName}: ${list.length}`)
        .toArray()
        .join(', ');
      for (const { id } of admins) {
        await send(
          String(id),
          'admin',
          items,
          `Library import: ${items.length} originals need attention`,
          `By account: ${accounts}. `,
        );
      }
    }
  }

  private async queueMissingDerivedWork(): Promise<void> {
    await this.destination.query(`INSERT INTO public.frameleaf_immich_import_work(asset_id,kind)
      SELECT a.id,'thumbnail' FROM public.asset a WHERE NOT EXISTS
      (SELECT 1 FROM public.asset_file f WHERE f."assetId"=a.id AND f.type='thumbnail') ON CONFLICT DO NOTHING`);
    await this.destination.query(`INSERT INTO public.frameleaf_immich_import_work(asset_id,kind)
      SELECT a.id,'smart-search' FROM public.asset a WHERE NOT EXISTS
      (SELECT 1 FROM public.smart_search s WHERE s."assetId"=a.id) ON CONFLICT DO NOTHING`);
    await this.destination.query(`INSERT INTO public.frameleaf_immich_import_work(asset_id,kind)
      SELECT a.id,'face-detection' FROM public.asset a WHERE NOT EXISTS
      (SELECT 1 FROM public.asset_face f WHERE f."assetId"=a.id)
      OR EXISTS (SELECT 1 FROM public.asset_face f WHERE f."assetId"=a.id AND NOT EXISTS
        (SELECT 1 FROM public.face_search s WHERE s."faceId"=f.id))
      ON CONFLICT DO NOTHING`);
  }
}
