import { Injectable } from '@nestjs/common';
import { Insertable, Kysely, Selectable, Updateable, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import type { FileProblemTab } from 'src/dtos/file-problem.dto.js';
import type { FileStep, FindingStep, NewFileStep } from 'src/utils/file-steps.js';
import type { HiddenContentQueryOptions } from 'src/utils/hidden-content.js';
import type { LockedVisibilityOptions } from 'src/utils/locked-visibility.js';
import type { FileDigests } from 'src/utils/media-health-roots.js';
import { EXTERNAL_SCAN_CHECKSUM } from 'src/constants.js';
import {
  AssetFileType,
  AssetStatus,
  ChecksumAlgorithm,
  JobName,
  MediaHealthCategory,
  MediaHealthSeverity,
  MediaHealthStatus,
  PhysicalFileType,
  QueueName,
} from 'src/enum.js';
import { BUDDY_CAPTURE_LOCK, countPathReferences, lockFilePath } from 'src/repositories/physical-file.repository.js';
import { DB } from 'src/schema/index.js';
import {
  AssetHealthCandidateTable,
  AssetHealthRunTable,
  AssetHealthTable,
} from 'src/schema/tables/asset-health.table.js';
import { AssetTable } from 'src/schema/tables/asset.table.js';
import { anyUuid, asUuid, lockedOwnerScope, withHiddenContentFilter } from 'src/utils/database.js';
import { libraryPathOnRelink } from 'src/utils/library-path.js';
import { isLocked, isNotLocked } from 'src/utils/locked.js';

/** The steps for the finding a write has just recorded, written in that write's transaction (FL-1337). */
const stepsFor = (steps: FindingStep[] | undefined, finding: { id: string; assetId: string }): NewFileStep[] =>
  (steps ?? []).map((step) => ({ ...step, healthId: finding.id, assetId: step.assetId ?? finding.assetId }));
/**
 * What an interactive read may show: the viewer's hidden-content settings, and their Locked media only
 * in their elevated session (`lockedOwnerId`, FL-34). Background jobs pass no privacy and see every
 * asset, Locked included (owner decision, September 22, 2026).
 */
type MediaHealthPrivacy = HiddenContentQueryOptions & LockedVisibilityOptions;
export type MediaHealthRun = Selectable<AssetHealthRunTable>;
export type MediaHealthFinding = Selectable<AssetHealthTable>;
export type MediaHealthCandidate = Selectable<AssetHealthCandidateTable>;
export type MediaHealthChecksum = {
  assetId: string;
  sha1: Buffer;
  sha256: Buffer;
  sizeInBytes: number;
};
export type MediaHealthAsset = Pick<
  Selectable<AssetTable>,
  | 'id'
  | 'updateId'
  | 'ownerId'
  | 'type'
  | 'originalPath'
  | 'originalFileName'
  | 'isExternal'
  | 'libraryId'
  | 'thumbhash'
  | 'fileCreatedAt'
  | 'fileModifiedAt'
  | 'localDateTime'
  | 'createdAt'
  | 'updatedAt'
  | 'deletedAt'
  | 'duration'
  | 'checksum'
  | 'checksumAlgorithm'
  | 'isFavorite'
  | 'visibility'
  | 'livePhotoVideoId'
  | 'stackId'
  | 'duplicateId'
  | 'status'
  | 'isOffline'
  | 'width'
  | 'height'
  | 'isEdited'
> & {
  previewPath: string | null;
  thumbnailPath: string | null;
  /** FL-34: selected by `getAssets`, so a listed asset reports `locked` (`effectiveVisibilityOf`) */
  isLocked?: boolean | null;
};
export type UpsertMediaHealthFinding = Omit<
  Insertable<AssetHealthTable>,
  'id' | 'createdAt' | 'updatedAt' | 'dismissedAt' | 'resolvedAt'
> & {
  dismissedAt?: Date | null;
  resolvedAt?: Date | null;
  expectedUpdateId?: string;
  /** FL-1337: the history it starts or adds to, written with it. */
  steps?: FindingStep[];
};
export type UpsertMediaHealthCandidate = Omit<Insertable<AssetHealthCandidateTable>, 'id' | 'createdAt' | 'updatedAt'>;
export type RelinkManagedAsset = {
  verifyCandidate: () => Promise<
    | {
        sha1: Buffer;
        sha256: Buffer;
        sizeInBytes: number;
      }
    | undefined
  >;
  expectedUpdateId: string;
  expectedChecksumAlgorithm: ChecksumAlgorithm;
  assetId: string;
  candidateId: string;
  ownerId: string;
  healthId: string;
  expectedOriginalPath: string;
  originalPath: string;
  originalFileName: string;
  expectedChecksum: Buffer;
  sha1: Buffer;
  sha256: Buffer;
  sizeInBytes: number;
  fileModifiedAt: Date;
  /**
   * FL-69: the finding's category. Missing (the default) relinks a `found` finding; Corrupt replaces
   * a `corrupt_confirmed` one and keeps the damaged file where it is, recorded as `retainedPath`.
   */
  category?: MediaHealthCategory;
  /**
   * FL-69: where the chosen candidate was found, when the asset is linked to a copy published from it
   * (`originalPath`) rather than to the candidate itself. A recovery location is only ever read.
   */
  candidatePath?: string;
  /** FL-69: who recovered it and from which search location, kept on the finding. */
  provenance?: Record<string, unknown>;
  /** FL-1337: how the fix left the finding (`fixState`, `partSaved`), kept beside the relink's own evidence. */
  evidence?: Record<string, unknown>;
  /**
   * FL-1337: the history the relink adds, written with it. A step carrying `undo` gets the asset's new
   * `originalPath` and `checksum` (hex) in it, which Undo compares before it changes anything.
   */
  steps?: FindingStep[];
};
export type RelinkExternalAsset = RelinkManagedAsset & {
  expectedLibraryId: string;
};
/**
 * A damaged JPEG's repaired file, approved by its reviewer. Unlike a recovery its content is new, so
 * there is no checksum to match and no candidate: the asset must still be the damaged file that was
 * repaired (`expectedChecksum`, `expectedUpdateId`), and the damaged file is kept as `retainedPath`.
 */
export type ReplaceRepairedOriginal = Omit<RelinkManagedAsset, 'candidateId' | 'category' | 'candidatePath'>;
/**
 * A problem as Damaged and missing files lists it (FL-1337): the finding, whose library it is in, and the
 * step its one-line story is told from (the newest, apart from the damaged file kept beside a repair).
 */
export type FileProblemRecord = MediaHealthFinding & {
  ownerId: string;
  ownerName: string;
  assetDeletedAt: Date | null;
  line: { step: string; outcome: string; facts: Record<string, unknown> } | null;
};
/**
 * Undo one fix (FL-1337, design §5), in one transaction: written only while the photo is still as that fix
 * left it (Review Focus 3).
 */
export type UndoFileFix = {
  healthId: string;
  assetId: string;
  ownerId: string;
  /** The step that recorded the fix. A later fix or Undo, or an edit saved or removed since it, refuses. */
  stepId: string;
  /** The asset as the fix left it, from that step's `undo`: any other file or checksum refuses. */
  expectedOriginalPath: string;
  expectedChecksum: Buffer;
  /**
   * A repair or a relink: the file the photo goes back to. A repair's photo takes that file's own contents as
   * its checksum (`takeChecksum`, from `digests`); a relink keeps the photo's own, which its copy matched.
   * Nothing at the file it leaves is touched.
   */
  relinkTo?: { path: string; digests?: FileDigests; takeChecksum: boolean };
  /** A restore: moves its files, under the lock, once the photo is proven unchanged; the caller puts them back if this fails. */
  moveFiles?: () => Promise<void>;
  /** Where the problem goes back to: reopened, with these states merged into its evidence and these steps. */
  status: MediaHealthStatus;
  evidence: Record<string, unknown>;
  steps: FindingStep[];
};
/**
 * What `undoFix` did: `undone`; `changed`, when the photo is no longer as the fix left it; `open`, when the
 * same photo has another problem open (Review Focus 5). Nothing is written or moved unless `undone`.
 */
export type UndoFileFixResult = 'undone' | 'changed' | 'open';
/** The fix states of each tab of Damaged and missing files (FL-1337 ruling 1). */
const NEEDS_FIX_STATES = ['missing', 'waiting-phone', 'cant-repair', 'couldnt-check'];
const FIXED_FIX_STATES = ['repaired', 'part-saved', 'found-again', 'restored'];
/** How long a fixed problem stays in Fixed for you. */
const FIXED_TAB_DAYS = 30;
/** A search id as a claim names it: compared as a uuid, so the job's primary key is used. */
const UUID_PATTERN = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
@Injectable()
export class MediaHealthRepository {
  constructor(
    @InjectKysely()
    private db: Kysely<DB>,
  ) {}
  async createRun(category: MediaHealthCategory, ownerId?: string): Promise<MediaHealthRun>;
  async createRun(
    category: MediaHealthCategory,
    ownerId: string,
    minimumIntervalMs: number,
  ): Promise<MediaHealthRun | undefined>;
  async createRun(
    category: MediaHealthCategory,
    ownerId?: string,
    minimumIntervalMs = 0,
  ): Promise<MediaHealthRun | undefined> {
    const run = {
      id: randomUUID(),
      ownerId: ownerId ?? null,
      category,
      status: 'running',
      startedAt: new Date(),
      finishedAt: null,
      totalAssets: 0,
      checkedAssets: 0,
      foundAssets: 0,
      error: null,
    };
    return this.db.transaction().execute(async (trx) => {
      if (ownerId && minimumIntervalMs > 0) {
        // Serialize admission across API processes before checking the owner's cooldown.
        await trx
          .selectFrom('user')
          .select('id')
          .where('id', '=', asUuid(ownerId))
          .forUpdate()
          .executeTakeFirstOrThrow();
        const recent = await trx
          .withSchema('public')
          .selectFrom('asset_health_run')
          .select('id')
          .where('ownerId', '=', asUuid(ownerId))
          .where('category', '=', category)
          .where((eb) =>
            eb.or([eb('startedAt', '>', new Date(Date.now() - minimumIntervalMs)), eb('status', '=', 'running')]),
          )
          .executeTakeFirst();
        if (recent) {
          return;
        }
      }
      {
        await trx.withSchema('public').insertInto('asset_health_run').values(run).execute();
      }
      return run;
    });
  }
  async finishRun(id: string, update: Updateable<AssetHealthRunTable>): Promise<MediaHealthRun | undefined> {
    const values = { ...update, finishedAt: update.finishedAt === undefined ? new Date() : update.finishedAt };
    let result: MediaHealthRun | undefined;
    await this.db.transaction().execute(async (trx) => {
      {
        result = await trx
          .withSchema('public')
          .updateTable('asset_health_run')
          .set(values)
          .where('id', '=', asUuid(id))
          .returningAll()
          .executeTakeFirst();
      }
    });
    return result;
  }
  async getLatestRun(category?: MediaHealthCategory, ownerId?: string): Promise<MediaHealthRun | undefined> {
    return this.db
      .withSchema('public')
      .selectFrom('asset_health_run')
      .selectAll()
      .$if(!!ownerId, (qb) => qb.where('ownerId', '=', asUuid(ownerId!)))
      .$if(!!category, (qb) => qb.where('category', '=', category!))
      .orderBy('startedAt', 'desc')
      .limit(1)
      .executeTakeFirst();
  }
  async list(options: {
    category?: MediaHealthCategory;
    ownerId?: string;
    privacy?: MediaHealthPrivacy;
    status?: MediaHealthStatus;
    /** Library Care's "needs attention" (FL-69): any of these statuses. */
    statuses?: readonly MediaHealthStatus[];
    size: number;
    offset?: number;
  }): Promise<MediaHealthFinding[]> {
    return (this.db as Kysely<any>)
      .selectFrom('public.asset_health as asset_health')
      .innerJoin('public.asset as asset', 'asset.id', 'asset_health.assetId')
      .selectAll('asset_health')
      .$if(!!options.ownerId, (qb) => qb.where('asset.ownerId', '=', asUuid(options.ownerId!)))
      .$if(!!options.privacy, (qb) => qb.where((eb) => lockedOwnerScope(eb, options.privacy!.lockedOwnerId)))
      .$call((qb) => withHiddenContentFilter(qb, options.privacy))
      .$if(!!options.category, (qb) => qb.where('asset_health.category', '=', options.category!))
      .$if(!!options.status, (qb) => qb.where('asset_health.status', '=', options.status!))
      .$if(!!options.statuses, (qb) => qb.where('asset_health.status', 'in', [...options.statuses!]))
      .orderBy('asset_health.checkedAt', 'desc')
      .orderBy('asset_health.id', 'desc')
      .limit(options.size)
      .$if(!!options.offset, (qb) => qb.offset(options.offset!))
      .execute() as Promise<MediaHealthFinding[]>;
  }
  async count(options: {
    category?: MediaHealthCategory;
    ownerId?: string;
    privacy?: MediaHealthPrivacy;
    status?: MediaHealthStatus;
    statuses?: readonly MediaHealthStatus[];
  }): Promise<number> {
    const row = await (this.db as Kysely<any>)
      .selectFrom('public.asset_health as asset_health')
      .innerJoin('public.asset as asset', 'asset.id', 'asset_health.assetId')
      .select((eb) => eb.fn.countAll<number>().as('count'))
      .$if(!!options.ownerId, (qb) => qb.where('asset.ownerId', '=', asUuid(options.ownerId!)))
      .$if(!!options.privacy, (qb) => qb.where((eb) => lockedOwnerScope(eb, options.privacy!.lockedOwnerId)))
      .$call((qb) => withHiddenContentFilter(qb, options.privacy))
      .$if(!!options.category, (qb) => qb.where('asset_health.category', '=', options.category!))
      .$if(!!options.status, (qb) => qb.where('asset_health.status', '=', options.status!))
      .$if(!!options.statuses, (qb) => qb.where('asset_health.status', 'in', [...options.statuses!]))
      .executeTakeFirstOrThrow();
    return Number(row.count);
  }
  /**
   * Library Care's queue sizes (FL-69): open findings by category and status, read with the same
   * owner scope and privacy as the list, so a count never reveals an item the list would hide.
   */
  async countByStatus(options: { ownerId?: string; privacy: MediaHealthPrivacy }): Promise<
    Array<{
      category: MediaHealthCategory;
      status: MediaHealthStatus;
      count: number;
    }>
  > {
    const rows = await (this.db as Kysely<any>)
      .selectFrom('public.asset_health as asset_health')
      .innerJoin('public.asset as asset', 'asset.id', 'asset_health.assetId')
      .select(['asset_health.category', 'asset_health.status'])
      .select((eb) => eb.fn.countAll<number>().as('count'))
      .where('asset.deletedAt', 'is', null)
      .$if(!!options.ownerId, (qb) => qb.where('asset.ownerId', '=', asUuid(options.ownerId!)))
      .where((eb) => lockedOwnerScope(eb, options.privacy.lockedOwnerId))
      .$call((qb) => withHiddenContentFilter(qb, options.privacy))
      .groupBy(['asset_health.category', 'asset_health.status'])
      .execute();
    return rows.map((row: { category: MediaHealthCategory; status: MediaHealthStatus; count: number | string }) => ({
      category: row.category,
      status: row.status,
      count: Number(row.count),
    }));
  }
  /** Duplicate groups with at least two visible members, with the list's privacy (FL-69). */
  async countDuplicateGroups(options: { ownerId?: string; privacy: MediaHealthPrivacy }): Promise<number> {
    const groups = this.db
      .withSchema('public')
      .selectFrom('asset')
      .select('asset.duplicateId')
      .where('asset.duplicateId', 'is not', null)
      .where('asset.deletedAt', 'is', null)
      .where('asset.status', '=', AssetStatus.Active)
      .$if(!!options.ownerId, (qb) => qb.where('asset.ownerId', '=', asUuid(options.ownerId!)))
      .where((eb) => lockedOwnerScope(eb, options.privacy.lockedOwnerId))
      .$call((qb) => withHiddenContentFilter(qb, options.privacy))
      .groupBy('asset.duplicateId')
      .having((eb) => eb(eb.fn.countAll(), '>', 1))
      .as('groups');
    const row = await this.db
      .selectFrom(groups)
      .select((eb) => eb.fn.countAll<number>().as('count'))
      .executeTakeFirst();
    return Number(row?.count ?? 0);
  }
  /** Items whose metadata has not been read yet: the enrichment backlog Library Care shows (FL-69). */
  async countPendingMetadata(options: { ownerId?: string; privacy: MediaHealthPrivacy }): Promise<number> {
    const row = await this.db
      .withSchema('public')
      .selectFrom('asset')
      .leftJoin('asset_job_status', 'asset_job_status.assetId', 'asset.id')
      .select((eb) => eb.fn.countAll<number>().as('count'))
      .where('asset.deletedAt', 'is', null)
      .where('asset.status', '=', AssetStatus.Active)
      .where('asset_job_status.metadataExtractedAt', 'is', null)
      .$if(!!options.ownerId, (qb) => qb.where('asset.ownerId', '=', asUuid(options.ownerId!)))
      .where((eb) => lockedOwnerScope(eb, options.privacy.lockedOwnerId))
      .$call((qb) => withHiddenContentFilter(qb, options.privacy))
      .executeTakeFirst();
    return Number(row?.count ?? 0);
  }
  /**
   * Imported iCloud items that need a person's review (FL-69), or null when the import tables are
   * not there to read. Counts only; the review itself stays on the iCloud Photos tool.
   */
  async countImportReview(ownerId?: string): Promise<number | null> {
    try {
      const result = await sql<{
        count: number;
      }>`
        SELECT count(*)::int AS count FROM public.icloud_resource
        WHERE status IN ('needs-review', 'failed')
        ${ownerId ? sql`AND "ownerId" = ${ownerId}::uuid` : sql``}`.execute(this.db);
      return Number(result.rows[0]?.count ?? 0);
    } catch {
      return null;
    }
  }
  async getByIds(ids: string[], ownerId?: string, privacy?: MediaHealthPrivacy): Promise<MediaHealthFinding[]> {
    if (ids.length === 0) {
      return [];
    }
    return (this.db as Kysely<any>)
      .selectFrom('public.asset_health as asset_health')
      .innerJoin('public.asset as asset', 'asset.id', 'asset_health.assetId')
      .selectAll('asset_health')
      .where('asset_health.id', '=', anyUuid(ids))
      .$if(!!ownerId, (qb) => qb.where('asset.ownerId', '=', asUuid(ownerId!)))
      .$if(!!privacy, (qb) => qb.where((eb) => lockedOwnerScope(eb, privacy!.lockedOwnerId)))
      .$call((qb) => withHiddenContentFilter(qb, privacy))
      .execute() as Promise<MediaHealthFinding[]>;
  }
  async getCandidatesByHealthIds(healthIds: string[]): Promise<MediaHealthCandidate[]> {
    if (healthIds.length === 0) {
      return [];
    }
    return this.db
      .withSchema('public')
      .selectFrom('asset_health_candidate')
      .selectAll()
      .where('healthId', '=', anyUuid(healthIds))
      .orderBy('visualMatchScore', 'desc')
      .execute();
  }
  async getAssetChecksums(assetIds: string[]): Promise<MediaHealthChecksum[]> {
    if (assetIds.length === 0) {
      return [];
    }
    const result = await sql<MediaHealthChecksum>`
      SELECT "assetId", sha1, sha256, "sizeInBytes"::float8 AS "sizeInBytes"
      FROM public.asset_checksum
      WHERE "assetId" = ANY(${assetIds}::uuid[])
    `.execute(this.db);
    return result.rows;
  }
  getInternalAssetByOriginalPath(originalPath: string): Promise<
    | {
        id: string;
      }
    | undefined
  > {
    return this.db
      .withSchema('public')
      .selectFrom('asset')
      .select('id')
      .where('originalPath', '=', path.normalize(originalPath))
      .where('libraryId', 'is', null)
      .where('isExternal', '=', false)
      .where('deletedAt', 'is', null)
      .where('status', '=', AssetStatus.Active)
      .limit(1)
      .executeTakeFirst();
  }
  async getTrackedPaths(paths: string[]): Promise<Set<string>> {
    if (paths.length === 0) {
      return new Set();
    }
    const rows = await this.db
      .withSchema('public')
      .selectFrom('asset')
      .select('originalPath')
      .where('originalPath', 'in', paths)
      .execute();
    const tracked = new Set(rows.map(({ originalPath }) => originalPath));
    // FL-69: a damaged original replaced from a verified copy is kept where it was, for recovery.
    // It is no longer any asset's original, but it is not untracked media either: importing it
    // again would bring the damage back as a new item.
    const retained = await (this.db as Kysely<any>)
      .selectFrom('public.asset_health as asset_health')
      .select(sql<string>`asset_health.evidence->>'retainedPath'`.as('retainedPath'))
      .where(sql<string>`asset_health.evidence->>'retainedPath'`, 'in', paths)
      .execute();
    for (const { retainedPath } of retained as Array<{
      retainedPath: string;
    }>) {
      tracked.add(retainedPath);
    }
    // Frameleaf's own outputs (Studio exports, develop masters, backups, Unused files…) live in library
    // storage too; restoring one would duplicate it. Same authoritative count the file trash uses.
    // ponytail: a few queries per untracked file, fine while untracked files stay rare.
    const untracked = paths.filter((candidate) => !tracked.has(candidate));
    if (untracked.length > 0) {
      await this.db.transaction().execute(async (trx) => {
        for (const candidate of untracked) {
          if ((await countPathReferences(trx, candidate)) > 0) {
            tracked.add(candidate);
          }
        }
      });
    }
    return tracked;
  }
  async replaceCandidates(healthId: string, candidates: UpsertMediaHealthCandidate[]): Promise<void> {
    if (candidates.some((candidate) => candidate.healthId !== healthId)) {
      throw new Error(`Cannot replace media-health candidates for multiple findings`);
    }
    const now = new Date();
    const rows = candidates.map((candidate) => ({ id: randomUUID(), createdAt: now, updatedAt: now, ...candidate }));
    await this.db.transaction().execute(async (trx) => {
      const target = trx.withSchema('public');

      await target.deleteFrom('asset_health_candidate').where('healthId', '=', asUuid(healthId)).execute();

      if (rows.length > 0) {
        await target.insertInto('asset_health_candidate').values(rows).execute();
      }
    });
  }
  async upsertFinding(input: UpsertMediaHealthFinding): Promise<MediaHealthFinding | undefined> {
    const { expectedUpdateId, steps, ...finding } = input;
    return this.db.transaction().execute(async (trx) => {
      const asset = await trx
        .withSchema('public')
        .selectFrom('asset')
        .select(['updateId', 'originalPath', 'deletedAt', 'status'])
        .where('id', '=', asUuid(finding.assetId))
        .forUpdate()
        .executeTakeFirst();
      if (
        !asset ||
        asset.originalPath !== finding.originalPath ||
        (expectedUpdateId &&
          (asset.updateId !== expectedUpdateId || asset.deletedAt || asset.status !== AssetStatus.Active))
      ) {
        return;
      }
      let result: MediaHealthFinding | undefined;
      {
        result = await this.upsertFindingInto(trx.withSchema('public'), finding, steps);
      }
      return result;
    });
  }
  async markResolvedForAssets(
    categories: MediaHealthCategory[],
    assets: Pick<MediaHealthAsset, 'id' | 'updateId' | 'originalPath'>[],
  ): Promise<void> {
    if (assets.length === 0 || categories.length === 0) {
      return;
    }
    await this.db.transaction().execute(async (trx) => {
      const current = await trx
        .withSchema('public')
        .selectFrom('asset')
        .select(['id', 'updateId', 'originalPath'])
        .where('id', '=', anyUuid(assets.map(({ id }) => id)))
        .where('deletedAt', 'is', null)
        .where('status', '=', AssetStatus.Active)
        .orderBy('id')
        .forUpdate()
        .execute();
      const expected = new Map(assets.map((asset) => [asset.id, asset]));
      const ids = current
        .filter(
          (asset) =>
            asset.updateId === expected.get(asset.id)?.updateId &&
            asset.originalPath === expected.get(asset.id)?.originalPath,
        )
        .map(({ id }) => id);
      if (ids.length === 0) {
        return;
      }

      await trx
        .withSchema('public')
        .updateTable('asset_health')
        .set({ status: MediaHealthStatus.Resolved, severity: MediaHealthSeverity.Info, resolvedAt: new Date() })
        .where('category', 'in', categories)
        .where('assetId', '=', anyUuid(ids))
        .execute();
    });
  }
  async trashCorruptIfUnchanged(input: {
    healthId: string;
    asset: Pick<MediaHealthAsset, 'id' | 'ownerId' | 'updateId' | 'originalPath'>;
  }): Promise<boolean> {
    return this.db.transaction().execute(async (trx) => {
      const asset = await trx
        .withSchema('public')
        .selectFrom('asset')
        .select(['updateId', 'originalPath', 'ownerId', 'deletedAt', 'status'])
        .where('id', '=', asUuid(input.asset.id))
        .forUpdate()
        .executeTakeFirst();
      if (
        !asset ||
        asset.updateId !== input.asset.updateId ||
        asset.originalPath !== input.asset.originalPath ||
        asset.ownerId !== input.asset.ownerId ||
        asset.deletedAt ||
        asset.status !== AssetStatus.Active
      ) {
        return false;
      }
      const health = await trx
        .withSchema('public')
        .selectFrom('asset_health')
        .select(['status', 'originalPath', 'resolvedAt'])
        .where('id', '=', asUuid(input.healthId))
        .where('assetId', '=', asUuid(input.asset.id))
        .where('category', '=', MediaHealthCategory.Corrupt)
        .forUpdate()
        .executeTakeFirst();
      if (
        !health ||
        health.status !== MediaHealthStatus.TrashQueued ||
        health.resolvedAt ||
        health.originalPath !== asset.originalPath
      ) {
        return false;
      }
      await trx
        .withSchema('public')
        .updateTable('asset')
        .set({ deletedAt: new Date(), status: AssetStatus.Trashed })
        .where('id', '=', asUuid(input.asset.id))
        .execute();

      await trx
        .withSchema('public')
        .updateTable('asset_health')
        .set({ status: MediaHealthStatus.Trashed })
        .where('id', '=', asUuid(input.healthId))
        .execute();
      return true;
    });
  }
  /**
   * Insert or replace the asset's finding of this category, and append `steps` to it in the same
   * transaction. FL-1337: replacing keeps what a person decided (`autoRepairDeclined`, after an Undo)
   * unless the new evidence says otherwise, and keeps how the last fix left it (`fixState`,
   * `partSaved`) and a search it waits for (`searchPending`) while it is the same open problem. A change
   * of status is the same problem while the finding stays open (F6: missing to found, suspected to
   * confirmed damage); a finding that was resolved or dismissed, or is written closed, starts afresh.
   */
  private async upsertFindingInto(
    db: Kysely<DB>,
    finding: UpsertMediaHealthFinding,
    steps?: FindingStep[],
  ): Promise<MediaHealthFinding> {
    const result = await db
      .insertInto('asset_health')
      .values({
        dismissedAt: null,
        resolvedAt: null,
        ...finding,
      })
      .onConflict((oc) =>
        oc.columns(['assetId', 'category']).doUpdateSet((eb) => ({
          runId: eb.ref('excluded.runId'),
          status: eb.ref('excluded.status'),
          severity: eb.ref('excluded.severity'),
          originalPath: eb.ref('excluded.originalPath'),
          originalFileName: eb.ref('excluded.originalFileName'),
          evidence: sql<Record<string, unknown>>`
            CASE WHEN asset_health."resolvedAt" IS NULL AND asset_health."dismissedAt" IS NULL
              AND excluded."resolvedAt" IS NULL AND excluded."dismissedAt" IS NULL
            THEN jsonb_strip_nulls(jsonb_build_object(
              'fixState', asset_health.evidence->'fixState', 'partSaved', asset_health.evidence->'partSaved',
              'searchPending', asset_health.evidence->'searchPending'))
            ELSE '{}'::jsonb END
            || jsonb_strip_nulls(jsonb_build_object('autoRepairDeclined', asset_health.evidence->'autoRepairDeclined'))
            || excluded.evidence`,
          resolution: eb.ref('excluded.resolution'),
          checkedAt: eb.ref('excluded.checkedAt'),
          dismissedAt: eb.ref('excluded.dismissedAt'),
          resolvedAt: eb.ref('excluded.resolvedAt'),
        })),
      )
      .returningAll()
      .executeTakeFirstOrThrow();
    await this.appendSteps(stepsFor(steps, result), db);
    return result;
  }
  async markResolved(category: MediaHealthCategory, assetId: string): Promise<void> {
    const resolvedAt = new Date();
    await this.db.transaction().execute(async (trx) => {
      await trx
        .withSchema('public')
        .updateTable('asset_health')
        .set({ status: MediaHealthStatus.Resolved, severity: MediaHealthSeverity.Info, resolvedAt })
        .where('category', '=', category)
        .where('assetId', '=', asUuid(assetId))
        .execute();
    });
  }
  async markResolvedMany(category: MediaHealthCategory, assetIds: string[]): Promise<void> {
    if (assetIds.length === 0) {
      return;
    }
    const resolvedAt = new Date();
    await this.db.transaction().execute(async (trx) => {
      await trx
        .withSchema('public')
        .updateTable('asset_health')
        .set({ status: MediaHealthStatus.Resolved, severity: MediaHealthSeverity.Info, resolvedAt })
        .where('category', '=', category)
        .where('assetId', '=', anyUuid(assetIds))
        .execute();
    });
  }
  async markResolvedCategories(categories: MediaHealthCategory[], assetId: string): Promise<void> {
    if (categories.length === 0) {
      return;
    }
    const resolvedAt = new Date();
    await this.db.transaction().execute(async (trx) => {
      await trx
        .withSchema('public')
        .updateTable('asset_health')
        .set({ status: MediaHealthStatus.Resolved, severity: MediaHealthSeverity.Info, resolvedAt })
        .where('category', 'in', categories)
        .where('assetId', '=', asUuid(assetId))
        .execute();
    });
  }
  async markDismissed(ids: string[], ownerId?: string): Promise<void> {
    if (ids.length === 0) {
      return;
    }
    const dismissedAt = new Date();
    await this.db.transaction().execute(async (trx) => {
      await trx
        .withSchema('public')
        .updateTable('asset_health')
        // The status it had is kept on the finding, so the dismissal can be undone (FL-69, UT-2).
        .set({
          status: MediaHealthStatus.Dismissed,
          dismissedAt,
          resolution: sql<
            Record<string, unknown>
          >`coalesce(resolution, '{}'::jsonb) || jsonb_build_object('dismissedFrom', status)`,
        })
        .where('id', '=', anyUuid(ids))
        .where('status', '!=', MediaHealthStatus.Dismissed)
        .$if(!!ownerId, (qb) =>
          qb.where(sql<boolean>`EXISTS (
                SELECT 1 FROM public.asset
                WHERE asset.id = asset_health."assetId" AND asset."ownerId" = ${ownerId}::uuid
              )`),
        )
        .execute();
    });
  }
  /**
   * Put a settled finding back to `to` (FL-69, UT-2: undoing a dismissal, or damage whose trash move
   * was reversed). Only while it is still `from`, so a finding something else changed since is left
   * alone. Returns whether it was reopened.
   */
  async reopenFinding(id: string, from: MediaHealthStatus, to: MediaHealthStatus): Promise<boolean> {
    return this.db.transaction().execute(async (trx) => {
      let reopened = false;

      const result = await trx
        .withSchema('public')
        .updateTable('asset_health')
        .set({
          status: to,
          dismissedAt: null,
          resolution: sql<Record<string, unknown>>`coalesce(resolution, '{}'::jsonb) - 'dismissedFrom'`,
        })
        .where('id', '=', asUuid(id))
        .where('status', '=', from)
        .executeTakeFirst();

      reopened ||= Number(result.numUpdatedRows) > 0;
      return reopened;
    });
  }
  /**
   * Record which candidate the reviewer chose for a finding (FL-69). A missing original found in
   * several places relinks to this one; the choice is metadata only and is re-verified at relink.
   * Returns false when the candidate no longer belongs to the finding.
   */
  async setChosenCandidate(healthId: string, candidateId: string): Promise<boolean> {
    return this.db.transaction().execute(async (trx) => {
      const candidate = await trx
        .withSchema('public')
        .selectFrom('asset_health_candidate')
        .select('id')
        .where('id', '=', asUuid(candidateId))
        .where('healthId', '=', asUuid(healthId))
        .executeTakeFirst();
      if (!candidate) {
        return false;
      }

      await trx
        .withSchema('public')
        .updateTable('asset_health')
        .set({
          resolution: sql`coalesce(resolution, '{}'::jsonb) || jsonb_build_object('chosenCandidateId', ${candidateId}::text)`,
        })
        .where('id', '=', asUuid(healthId))
        .execute();
      return true;
    });
  }
  /** True when any asset, in any state (a trashed one can still be restored), has this original. */
  async isOriginalPathInUse(originalPath: string): Promise<boolean> {
    const row = await this.db
      .withSchema('public')
      .selectFrom('asset')
      .select('id')
      .where('originalPath', '=', originalPath)
      .limit(1)
      .executeTakeFirst();
    return !!row;
  }
  /**
   * Record where a replaced damaged original is kept now (FL-69). Metadata only. FL-1337: `steps` (the
   * kept file, with what Undo needs) are written with it.
   */
  async setRetainedPath(healthId: string, retainedPath: string, steps?: FindingStep[]): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      const row = await trx
        .withSchema('public')
        .updateTable('asset_health')
        .set({
          evidence: sql`coalesce(evidence, '{}'::jsonb) || jsonb_build_object('retainedPath', ${retainedPath}::text)`,
        })
        .where('id', '=', asUuid(healthId))
        .returning(['id', 'assetId'])
        .executeTakeFirst();
      if (row) {
        await this.appendSteps(stepsFor(steps, row), trx);
      }
    });
  }
  /**
   * Record how a fix left a finding (FL-1337): merge `evidence` (its `fixState` and flags) into the
   * finding's own and append `steps`, in one transaction. Keys the patch leaves out are kept, so a
   * person's `autoRepairDeclined` survives. With `status` the finding is settled as fixed too, resolved
   * now unless it already was. Only an undismissed finding is written, and without `status` only an
   * open one: a finding someone dismissed, or that was resolved meanwhile, is left as it is. Returns
   * whether it was written.
   */
  async settleFinding(input: {
    healthId: string;
    evidence: Record<string, unknown>;
    steps?: FindingStep[];
    status?: MediaHealthStatus;
  }): Promise<boolean> {
    return this.db.transaction().execute(async (trx) => {
      const row = await trx
        .withSchema('public')
        .updateTable('asset_health')
        .set({
          evidence: sql`coalesce(evidence, '{}'::jsonb) || ${JSON.stringify(input.evidence)}::text::jsonb`,
          ...(input.status && {
            status: input.status,
            severity: MediaHealthSeverity.Info,
            resolvedAt: sql<Date>`coalesce("resolvedAt", now())`,
          }),
        })
        .where('id', '=', asUuid(input.healthId))
        .where('dismissedAt', 'is', null)
        .$if(!input.status, (qb) => qb.where('resolvedAt', 'is', null))
        .returning(['id', 'assetId'])
        .executeTakeFirst();
      if (!row) {
        return false;
      }
      await this.appendSteps(stepsFor(input.steps, row), trx);
      return true;
    });
  }
  /**
   * What a search by contents found for one finding (FL-1337 F7), written against the finding as it is now, not
   * as the search read it before its walk: under the asset's lock, only while the photo still has the file the
   * search looked for, and in one guarded update, only while the finding is still open. A person's Keep, a
   * dismissal, an upload that put the photo back or a fix's state, all written during the walk, stay as they are.
   * The search's own evidence keys are merged into the live evidence, and its resolution into the live one, less a
   * choice made from the old candidate list. With `found` the finding also takes that status, severity and run, and
   * is checked now; without it (damage the search looked behind) its status and the time it was confirmed stay.
   * Returns whether it was written.
   */
  async recordSearchResult(input: {
    healthId: string;
    assetId: string;
    expectedUpdateId: string;
    originalPath: string;
    evidence: Record<string, unknown>;
    resolution: Record<string, unknown>;
    found?: { status: MediaHealthStatus; severity: MediaHealthSeverity; runId: string | null };
  }): Promise<boolean> {
    return this.db.transaction().execute(async (trx) => {
      const asset = await trx
        .withSchema('public')
        .selectFrom('asset')
        .select(['updateId', 'originalPath', 'deletedAt', 'status'])
        .where('id', '=', asUuid(input.assetId))
        .forUpdate()
        .executeTakeFirst();
      if (
        !asset ||
        asset.originalPath !== input.originalPath ||
        asset.updateId !== input.expectedUpdateId ||
        asset.deletedAt ||
        asset.status !== AssetStatus.Active
      ) {
        return false;
      }
      const row = await trx
        .withSchema('public')
        .updateTable('asset_health')
        .set({
          evidence: sql`coalesce(evidence, '{}'::jsonb) || ${JSON.stringify(input.evidence)}::text::jsonb`,
          resolution: sql`(coalesce(resolution, '{}'::jsonb) - 'chosenCandidateId') || ${JSON.stringify(input.resolution)}::text::jsonb`,
          ...(input.found && {
            status: input.found.status,
            severity: input.found.severity,
            runId: input.found.runId,
            checkedAt: new Date(),
          }),
        })
        .where('id', '=', asUuid(input.healthId))
        .where('assetId', '=', asUuid(input.assetId))
        .where('resolvedAt', 'is', null)
        .where('dismissedAt', 'is', null)
        .returning('id')
        .executeTakeFirst();
      return !!row;
    });
  }
  /**
   * Claim the owner's findings waiting for the shared search by contents (FL-1337) as search `searchId`:
   * open ones marked `searchPending: true`, ones this search claimed before (a retried step), and ones a
   * search claimed that no live job carries on any more (it failed, or was stopped for attention). A
   * claim names its search, `{ search }`, so a search asked for meanwhile leaves it to the live one.
   */
  async claimSearchPending(ownerId: string, searchId: string): Promise<string[]> {
    const { rows } = await sql<{ id: string }>`
      UPDATE public.asset_health health
      SET evidence = health.evidence || jsonb_build_object('searchPending', jsonb_build_object('search', ${searchId}::text))
      FROM public.asset asset
      WHERE asset.id = health."assetId" AND asset."ownerId" = ${ownerId}::uuid AND asset."deletedAt" IS NULL
        AND health."resolvedAt" IS NULL AND health."dismissedAt" IS NULL
        AND (
          health.evidence->'searchPending' = 'true'::jsonb
          OR (
            jsonb_typeof(health.evidence->'searchPending') = 'object'
            AND (
              health.evidence->'searchPending'->>'search' = ${searchId}::text
              OR NOT EXISTS (
                SELECT 1 FROM job
                WHERE job.queue = ${QueueName.MediaHealth} AND job.state IN ('pending', 'waiting', 'active')
                  AND job.name = ${JobName.MediaHealthLocateMissing}
                  AND (job.id = CASE WHEN health.evidence->'searchPending'->>'search' ~* ${UUID_PATTERN}
                      THEN (health.evidence->'searchPending'->>'search')::uuid END
                    OR job.data->>'searchId' = health.evidence->'searchPending'->>'search')
              )
            )
          )
        )
      RETURNING health.id`.execute(this.db);
    return rows.map(({ id }) => id);
  }
  /** Every finding of one asset, open or settled (FL-1337): at most one of each category. */
  getFindingsForAsset(assetId: string): Promise<MediaHealthFinding[]> {
    return this.db
      .withSchema('public')
      .selectFrom('asset_health')
      .selectAll()
      .where('assetId', '=', asUuid(assetId))
      .orderBy('category')
      .execute();
  }
  /**
   * Findings a trash job was queued for but no running job holds any more (FL-69): the job was
   * cancelled, skipped them or failed. They go back to confirmed damage so they can be reviewed
   * again. Findings queued in the last few minutes are left alone: their job may not exist yet.
   */
  async releaseTrashQueued(options: { ownerId?: string; keep: string[]; olderThan: Date }): Promise<number> {
    return this.db.transaction().execute(async (trx) => {
      let released = 0;

      const result = await (trx as Kysely<any>)
        .updateTable(`public.asset_health as asset_health`)
        .set({ status: MediaHealthStatus.CorruptConfirmed })
        .where('asset_health.status', '=', MediaHealthStatus.TrashQueued)
        .where('asset_health.updatedAt', '<', options.olderThan)
        .$if(options.keep.length > 0, (qb) =>
          qb.where((eb) => eb.not(eb('asset_health.id', '=', anyUuid(options.keep)))),
        )
        .$if(!!options.ownerId, (qb) =>
          qb.where(sql<boolean>`EXISTS (
                SELECT 1 FROM public.asset
                WHERE asset.id = asset_health."assetId" AND asset."ownerId" = ${options.ownerId}::uuid
              )`),
        )
        .executeTakeFirst();

      released = Math.max(released, Number(result.numUpdatedRows ?? 0));
      return released;
    });
  }
  /** Findings a running or waiting trash job still holds, across every account (FL-69). */
  async getActiveTrashFindingIds(): Promise<string[]> {
    const result = await sql<{
      findingId: string | null;
    }>`
      SELECT entry->>'findingId' AS "findingId"
      FROM media_operation, jsonb_array_elements(coalesce(snapshot->'payload'->'mediaHealth', '[]'::jsonb)) AS entry
      WHERE kind = 'bulk'
        AND snapshot->>'action' = 'trash-damaged-media'
        AND status IN ('queued', 'preparing', 'rendering', 'validating', 'cancelling', 'paused')`.execute(this.db);
    return result.rows.map(({ findingId }) => findingId).filter((id): id is string => !!id);
  }
  /**
   * Serialize Library Care job admission for one account (FL-69): the check for a running scan or
   * search and the creation of a new one happen under one transaction-scoped advisory lock, so two
   * requests cannot both start a job.
   */
  async withLibraryCareLock<T>(ownerId: string, work: () => Promise<T>): Promise<T> {
    return this.db.transaction().execute(async (trx) => {
      await sql`SELECT pg_advisory_xact_lock(hashtext(${`library-care:${ownerId}`}))`.execute(trx);
      return work();
    });
  }
  async markStatus(ids: string[], status: MediaHealthStatus): Promise<void> {
    if (ids.length === 0) {
      return;
    }
    await this.db.transaction().execute(async (trx) => {
      await trx
        .withSchema('public')
        .updateTable('asset_health')
        .set({ status })
        .where('id', '=', anyUuid(ids))
        .execute();
    });
  }
  async *streamAssets(
    options: {
      assetIds?: string[];
      ownerId?: string;
    } = {},
  ): AsyncGenerator<MediaHealthAsset> {
    if (options.assetIds && options.assetIds.length === 0) {
      return;
    }
    for await (const asset of this.scanAssetQuery(options).stream()) {
      yield asset;
    }
  }
  /**
   * One page of an owner's scan (FL-69), in id order after `afterId`. The durable Library Care scan
   * records the last id it finished as its cursor, so a paused, restarted or retried scan carries on
   * from there instead of starting again.
   */
  getAssetPage(options: {
    ownerId: string;
    afterId?: string | null;
    limit: number;
    /** An incremental scan (FL-69): only assets changed since then. */
    changedSince?: Date;
    /** FL-737: a scan of chosen photos, whoever owns them (the service checked they may be scanned). */
    assetIds?: string[];
  }): Promise<MediaHealthAsset[]> {
    return this.scanAssetQuery(options.assetIds ? { assetIds: options.assetIds } : { ownerId: options.ownerId })
      .$if(!!options.afterId, (qb) => qb.where('asset.id', '>', asUuid(options.afterId!)))
      .$if(!!options.changedSince, (qb) => qb.where('asset.updatedAt', '>', options.changedSince!))
      .orderBy('asset.id', 'asc')
      .limit(options.limit)
      .execute();
  }
  /** How many assets an owner's scan covers, for its progress. */
  async countScanAssets(ownerId: string, changedSince?: Date): Promise<number> {
    const row = await this.db
      .withSchema('public')
      .selectFrom('asset')
      .select((eb) => eb.fn.countAll<number>().as('count'))
      .where('asset.deletedAt', 'is', null)
      .where('asset.status', '!=', sql.lit(AssetStatus.Deleted))
      .where('asset.ownerId', '=', asUuid(ownerId))
      .$if(!!changedSince, (qb) => qb.where('asset.updatedAt', '>', changedSince!))
      .executeTakeFirst();
    return Number(row?.count ?? 0);
  }
  private scanAssetQuery(options: { assetIds?: string[]; ownerId?: string }) {
    return this.db
      .withSchema('public')
      .selectFrom('asset')
      .select([
        'asset.id',
        'asset.updateId',
        'asset.ownerId',
        'asset.type',
        'asset.originalPath',
        'asset.originalFileName',
        'asset.isExternal',
        'asset.libraryId',
        'asset.thumbhash',
        'asset.fileCreatedAt',
        'asset.fileModifiedAt',
        'asset.localDateTime',
        'asset.createdAt',
        'asset.updatedAt',
        'asset.deletedAt',
        'asset.duration',
        'asset.checksum',
        'asset.checksumAlgorithm',
        'asset.isFavorite',
        'asset.visibility',
        'asset.livePhotoVideoId',
        'asset.stackId',
        'asset.duplicateId',
        'asset.status',
        'asset.isOffline',
        'asset.width',
        'asset.height',
        'asset.isEdited',
      ])
      .select((eb) => [
        eb
          .selectFrom('asset_file')
          .select('path')
          .whereRef('asset_file.assetId', '=', 'asset.id')
          .where('type', '=', AssetFileType.Preview)
          .where('isEdited', '=', false)
          .limit(1)
          .as('previewPath'),
        eb
          .selectFrom('asset_file')
          .select('path')
          .whereRef('asset_file.assetId', '=', 'asset.id')
          .where('type', '=', AssetFileType.Thumbnail)
          .where('isEdited', '=', false)
          .limit(1)
          .as('thumbnailPath'),
      ])
      .where('asset.deletedAt', 'is', null)
      .where('asset.status', '!=', sql.lit(AssetStatus.Deleted))
      .$if(!!options.ownerId, (qb) => qb.where('asset.ownerId', '=', asUuid(options.ownerId!)))
      .$if(!!options.assetIds, (qb) => qb.where('asset.id', '=', anyUuid(options.assetIds!)));
  }
  getAssets(assetIds: string[], ownerId?: string, privacy?: MediaHealthPrivacy): Promise<MediaHealthAsset[]> {
    if (assetIds.length === 0) {
      return Promise.resolve([]);
    }
    return (
      this.db
        .withSchema('public')
        .selectFrom('asset')
        .selectAll('asset')
        // the stored visibility is never `locked` (FL-34): the lock record tells the response
        .select(isLocked('asset').as('isLocked'))
        .select((eb) => [
          eb
            .selectFrom('asset_file')
            .select('path')
            .whereRef('asset_file.assetId', '=', 'asset.id')
            .where('type', '=', AssetFileType.Preview)
            .where('isEdited', '=', false)
            .limit(1)
            .as('previewPath'),
          eb
            .selectFrom('asset_file')
            .select('path')
            .whereRef('asset_file.assetId', '=', 'asset.id')
            .where('type', '=', AssetFileType.Thumbnail)
            .where('isEdited', '=', false)
            .limit(1)
            .as('thumbnailPath'),
        ])
        .where('asset.id', '=', anyUuid(assetIds))
        .$if(!!ownerId, (qb) => qb.where('asset.ownerId', '=', asUuid(ownerId!)))
        .$if(!!privacy, (qb) => qb.where((eb) => lockedOwnerScope(eb, privacy!.lockedOwnerId)))
        .$call((qb) => withHiddenContentFilter(qb, privacy))
        .execute()
    );
  }
  async relinkManagedAsset(input: RelinkManagedAsset): Promise<boolean> {
    return this.commitRelink(input);
  }
  async relinkExternalAsset(input: RelinkExternalAsset): Promise<boolean> {
    return this.commitRelink(input);
  }
  async replaceRepairedOriginal(input: ReplaceRepairedOriginal): Promise<boolean> {
    return this.commitRelink({ ...input, candidateId: '', category: MediaHealthCategory.Corrupt }, true);
  }
  private async commitRelink(input: RelinkManagedAsset | RelinkExternalAsset, repaired = false): Promise<boolean> {
    const recoveredPath = path.normalize(input.originalPath);
    const external = 'expectedLibraryId' in input;
    return this.db.transaction().execute(async (trx) => {
      await sql`SELECT pg_advisory_xact_lock_shared(${BUDDY_CAPTURE_LOCK}::bigint)`.execute(trx);
      // Match recovery's owner-before-path ordering and serialize canonical path changes.
      const owner = await trx
        .withSchema('public')
        .selectFrom('user')
        .select('id')
        .where('id', '=', input.ownerId)
        .forUpdate()
        .executeTakeFirst();
      if (!owner) {
        return false;
      }
      for (const candidatePath of [...new Set([input.expectedOriginalPath, recoveredPath])].sort()) {
        await lockFilePath(trx, candidatePath);
      }
      const asset = await trx
        .withSchema('public')
        .selectFrom('asset')
        .selectAll()
        .where('id', '=', input.assetId)
        .forUpdate()
        .executeTakeFirst();
      if (
        !asset ||
        asset.ownerId !== input.ownerId ||
        asset.updateId !== input.expectedUpdateId ||
        asset.originalPath !== input.expectedOriginalPath ||
        !asset.checksum.equals(input.expectedChecksum) ||
        asset.checksumAlgorithm !== input.expectedChecksumAlgorithm ||
        asset.deletedAt ||
        asset.status !== AssetStatus.Active ||
        asset.isExternal !== external ||
        (external ? asset.libraryId !== input.expectedLibraryId : asset.libraryId !== null)
      ) {
        return false;
      }
      const sidecars =
        await sql<MediaHealthChecksum>`SELECT "assetId", sha1, sha256, "sizeInBytes" FROM public.asset_checksum WHERE "assetId" = ${asset.id}::uuid FOR UPDATE`.execute(
          trx,
        );
      const contentMatches =
        asset.checksumAlgorithm === ChecksumAlgorithm.sha256File
          ? input.sha256.equals(asset.checksum)
          : asset.checksumAlgorithm === ChecksumAlgorithm.sha1File
            ? input.sha1.equals(asset.checksum)
            : !!sidecars.rows[0]?.sha1.equals(input.sha1) && !!sidecars.rows[0]?.sha256.equals(input.sha256);
      if (
        // a repair's content is new by design; everything else must be the very same file
        (!contentMatches && !repaired) ||
        input.sha1.length !== 20 ||
        input.sha256.length !== 32 ||
        !Number.isSafeInteger(input.sizeInBytes) ||
        input.sizeInBytes <= 0
      ) {
        return false;
      }
      const health = await trx
        .withSchema('public')
        .selectFrom('asset_health')
        .selectAll()
        .where('id', '=', input.healthId)
        .forUpdate()
        .executeTakeFirst();
      // FL-69: a missing original relinks from `found`; confirmed damage is replaced from `corrupt_confirmed`.
      const category = input.category ?? MediaHealthCategory.Missing;
      const chosen = health?.resolution?.chosenCandidateId === input.candidateId;
      if (
        !health ||
        health.assetId !== asset.id ||
        health.category !== category ||
        !(
          health.status ===
            (category === MediaHealthCategory.Missing ? MediaHealthStatus.Found : MediaHealthStatus.CorruptConfirmed) ||
          // a JPEG the decoder only suspects is damaged can be repaired too: its reviewer saw the result
          (repaired && health.status === MediaHealthStatus.CorruptSuspect)
        ) ||
        health.resolvedAt ||
        health.dismissedAt ||
        health.originalPath !== asset.originalPath ||
        (category === MediaHealthCategory.Missing && health.resolution?.autoRelinkable !== true && !chosen)
      ) {
        return false;
      }
      const candidates = await trx
        .withSchema('public')
        .selectFrom('asset_health_candidate')
        .selectAll()
        .where('healthId', '=', input.healthId)
        .where('status', '=', MediaHealthStatus.Found)
        .forUpdate()
        .execute();
      // One verified candidate relinks by itself; among several, only the one the reviewer chose.
      const candidate = candidates.find(({ id }) => id === input.candidateId);
      if (
        !repaired &&
        (!candidate ||
          (candidates.length !== 1 && !chosen) ||
          path.normalize(candidate.candidatePath) !== path.normalize(input.candidatePath ?? input.originalPath) ||
          candidate.resolution?.autoRelinkable !== true)
      ) {
        return false;
      }
      const occupants = await trx
        .withSchema('public')
        .selectFrom('asset')
        .select(['id', 'isExternal', 'libraryId', 'status', 'deletedAt'])
        .where('originalPath', '=', recoveredPath)
        .where('id', '!=', asset.id)
        .orderBy('id')
        .forShare()
        .execute();
      if (external && occupants.some((item) => item.libraryId === asset.libraryId)) {
        return false;
      }
      const verify = async () => {
        const verified = await input.verifyCandidate();
        return (
          !!verified &&
          verified.sha1.equals(input.sha1) &&
          verified.sha256.equals(input.sha256) &&
          verified.sizeInBytes === input.sizeInBytes
        );
      };
      const canonical =
        occupants.find(
          (item) => !item.isExternal && !item.libraryId && !item.deletedAt && item.status === AssetStatus.Active,
        )?.id ?? asset.id;
      // the asset's checksum once relinked: an external original keeps a path checksum
      const checksum = external ? createHash('sha1').update(`path:${recoveredPath}`).digest() : input.sha256;
      if (external) {
        if (!(await verify())) {
          return false;
        }
        await trx
          .withSchema('public')
          .updateTable('asset')
          .set({
            originalPath: recoveredPath,
            originalFileName: input.originalFileName,
            checksum,
            checksumAlgorithm: ChecksumAlgorithm.sha1Path,
            fileModifiedAt: input.fileModifiedAt,
            isOffline: false,
          })
          .where('id', '=', asset.id)
          .execute();
      } else {
        let physicalId: string | undefined;
        {
          const physical = await trx
            .withSchema('public')
            .selectFrom('physical_file')
            .selectAll()
            .where('path', '=', recoveredPath)
            .forUpdate()
            .executeTakeFirst();
          if (
            physical &&
            (physical.type !== PhysicalFileType.Original ||
              !(physical.checksum.length === 20
                ? physical.checksum.equals(input.sha1)
                : physical.checksum.length === 32 && physical.checksum.equals(input.sha256)) ||
              Number(physical.sizeInBytes) !== input.sizeInBytes)
          ) {
            return false;
          }
          if (!(await verify())) {
            return false;
          }
          physicalId = physical?.id ?? randomUUID();
          if (!physical) {
            await trx
              .withSchema('public')
              .insertInto('physical_file')
              .values({
                id: physicalId,
                canonicalAssetId: canonical,
                checksum: input.sha256,
                path: recoveredPath,
                sizeInBytes: input.sizeInBytes,
                type: PhysicalFileType.Original,
              })
              .execute();
          }
        }
        await trx
          .withSchema('public')
          .updateTable('asset')
          .set({
            originalPath: recoveredPath,
            // FL-417: the recovered file is the photo's own
            libraryPath: libraryPathOnRelink(recoveredPath, true),
            checksum,
            checksumAlgorithm: ChecksumAlgorithm.sha256File,
            fileModifiedAt: input.fileModifiedAt,
            isOffline: false,
            physicalOriginalFileId: physicalId,
          })
          .where('id', '=', asset.id)
          .execute();
        // A row already at the path may be one an earlier relink left behind with no owner (or an owner that
        // moved off it). The relinked asset takes it, or it would lose its sidecar and metadata as a copy.
        await sql`UPDATE public.physical_file SET "canonicalAssetId" = ${asset.id}::uuid
          WHERE id = ${physicalId}::uuid AND NOT EXISTS (SELECT 1 FROM public.asset
            WHERE id = physical_file."canonicalAssetId" AND "originalPath" = ${recoveredPath})`.execute(trx);
        if (asset.physicalOriginalFileId && asset.physicalOriginalFileId !== physicalId) {
          await sql`UPDATE public.physical_file SET "canonicalAssetId" = (SELECT id FROM public.asset WHERE "physicalOriginalFileId" = ${asset.physicalOriginalFileId}::uuid ORDER BY id LIMIT 1)
            WHERE id = ${asset.physicalOriginalFileId}::uuid AND "canonicalAssetId" = ${asset.id}::uuid`.execute(trx);
        }
      }
      // FL-69: an external original keeps its path checksum, so its digests stay Library Care's own (an
      // external scan's), never a managed copy that sync, upload checks or restores could count
      const evidenceSource = external ? EXTERNAL_SCAN_CHECKSUM : 'recovery';
      await sql`INSERT INTO public.asset_checksum ("assetId", sha1, sha256, "sizeInBytes", "verifiedPaths", "linkCount", evidence, "verifiedAt", "updatedAt")
        VALUES (${asset.id}::uuid, ${input.sha1}, ${input.sha256}, ${input.sizeInBytes}, ARRAY[${recoveredPath}]::text[], 1, jsonb_build_object('source', ${evidenceSource}::text), now(), now())
        ON CONFLICT ("assetId") DO UPDATE SET sha1=EXCLUDED.sha1, sha256=EXCLUDED.sha256, "sizeInBytes"=EXCLUDED."sizeInBytes",
          "verifiedPaths"=EXCLUDED."verifiedPaths", evidence=EXCLUDED.evidence, "verifiedAt"=now(), "updatedAt"=now()`.execute(
        trx,
      );
      const checkedAt = new Date();

      await trx
        .withSchema('public')
        .updateTable('asset_health')
        .set({
          runId: null,
          // A replaced damaged original is resolved; its file stays where it was (`retainedPath`).
          status: category === MediaHealthCategory.Missing ? MediaHealthStatus.Relinked : MediaHealthStatus.Resolved,
          severity: MediaHealthSeverity.Info,
          originalPath: recoveredPath,
          originalFileName: input.originalFileName,
          evidence: {
            // FL-1337: a person's "don't repair this again" outlives the relink; the fix says how it left it
            ...(health.evidence?.autoRepairDeclined === true && { autoRepairDeclined: true }),
            ...input.evidence,
            reason: repaired
              ? 'repaired_damaged_file'
              : category === MediaHealthCategory.Missing
                ? 'candidate_relinked'
                : 'recovered_from_verified_copy',
            previousPath: asset.originalPath,
            ...(category === MediaHealthCategory.Corrupt && { retainedPath: asset.originalPath }),
            ...(input.candidatePath && { candidatePath: path.normalize(input.candidatePath) }),
            ...(input.provenance && { provenance: input.provenance }),
          },
          resolution: repaired
            ? { healthId: input.healthId, repaired: true }
            : { healthId: input.healthId, candidateId: input.candidateId },
          checkedAt,
          resolvedAt: checkedAt,
        })
        .where('id', '=', input.healthId)
        .where('assetId', '=', asset.id)
        .execute();
      const undoAfter = { originalPath: recoveredPath, checksum: checksum.toString('hex') };
      await this.appendSteps(
        stepsFor(input.steps, { id: input.healthId, assetId: asset.id }).map((step) =>
          step.undo ? { ...step, undo: { ...step.undo, ...undoAfter } } : step,
        ),
        trx,
      );

      await trx
        .withSchema('public')
        .updateTable('asset_health_candidate')
        .set({ resolution: { autoRelinkable: false } })
        .where('healthId', '=', input.healthId)
        .execute();
      return true;
    });
  }
  async deleteForAssets(assetIds: string[], db: Kysely<DB> = this.db): Promise<void> {
    if (assetIds.length === 0) {
      return;
    }
    await sql`
      DELETE FROM public.asset_health_candidate candidate
      USING public.asset_health health
      WHERE candidate."healthId" = health.id AND health."assetId" = ANY(${assetIds}::uuid[])
    `.execute(db);
    await sql`DELETE FROM public.asset_health WHERE "assetId" = ANY(${assetIds}::uuid[])`.execute(db);
  }

  /** Append to the history of a finding; pass `trx` to write in the same transaction as the finding. */
  async appendSteps(steps: NewFileStep[], trx?: Kysely<DB>): Promise<void> {
    if (steps.length === 0) {
      return;
    }
    await (trx ?? this.db)
      .insertInto('asset_health_step')
      .values(
        steps.map(({ healthId, assetId, step, outcome, facts, undo, at }) => ({
          healthId,
          assetId,
          step,
          outcome,
          ...(at && { at }),
          ...(facts && { facts }),
          undo: undo ?? null,
        })),
      )
      .execute();
  }

  /**
   * The owner's open Missing findings a phone may be able to answer (FL-1337): the photo is in the
   * library, not in the Trash, not external and not Locked, and its checksum is the SHA-1 of its
   * contents, which is how phones match. Only the owner's own rows, whoever asks.
   */
  private lostOriginals(ownerId: string) {
    return this.db
      .withSchema('public')
      .selectFrom('asset_health')
      .innerJoin('asset', 'asset.id', 'asset_health.assetId')
      .where('asset.ownerId', '=', asUuid(ownerId))
      .where('asset_health.category', '=', MediaHealthCategory.Missing)
      .where('asset_health.resolvedAt', 'is', null)
      .where('asset_health.dismissedAt', 'is', null)
      .where('asset.deletedAt', 'is', null)
      .where('asset.libraryId', 'is', null)
      .where('asset.isExternal', '=', false)
      .where('asset.checksumAlgorithm', '=', ChecksumAlgorithm.sha1File)
      .where(isNotLocked('asset'));
  }

  /** A page of the owner's lost originals, in a stable order; one more than `take` says there is a next page. */
  listLostOriginals(ownerId: string, take: number, skip: number) {
    return this.lostOriginals(ownerId)
      .select(['asset.id as assetId', 'asset.checksum', 'asset.originalFileName', 'asset.fileCreatedAt'])
      .orderBy('asset_health.id')
      .limit(take + 1)
      .offset(skip)
      .execute();
  }

  /**
   * Whether phones are shown this lost photo (F4): its open Missing finding is one `listLostOriginals` lists, by the
   * same rule. A photo phones are never shown can never be sent back or reported by one, so it never waits for them.
   */
  async isShownToPhones(ownerId: string, assetId: string): Promise<boolean> {
    const row = await this.lostOriginals(ownerId)
      .where('asset.id', '=', asUuid(assetId))
      .select('asset_health.id')
      .executeTakeFirst();
    return !!row;
  }

  /** The owner's lost originals among these SHA-1 checksums, with where each one stands. */
  findLostOriginals(ownerId: string, checksums: Buffer[]) {
    if (checksums.length === 0) {
      return Promise.resolve([]);
    }
    return this.lostOriginals(ownerId)
      .select(['asset_health.id as healthId', 'asset.id as assetId', 'asset_health.evidence'])
      .where('asset.checksum', 'in', checksums)
      .execute();
  }

  /**
   * One phone's report, decided in one transaction against the history as it is under the lock (FL-1337).
   * For each finding still open: the phone's `checked-on-phone` step unless it already reported since the
   * phones were last asked; then, if the finding waits on phones (`fixState: waiting-phone`) and every phone
   * in `phones` has reported, `asked-phones/not-found` and `fixState: missing`. A repeat report adds no
   * step but still takes that decision, so a report that raced another cannot leave the finding waiting.
   */
  async recordPhoneReport(input: {
    findings: Array<{ healthId: string; assetId: string }>;
    sessionId: string;
    device: string;
    deviceId: string;
    phones: string[];
  }): Promise<void> {
    if (input.findings.length === 0) {
      return;
    }
    await this.db.transaction().execute(async (trx) => {
      const open = await trx
        .withSchema('public')
        .selectFrom('asset_health')
        .select(['id', 'evidence'])
        .where(
          'id',
          'in',
          input.findings.map(({ healthId }) => asUuid(healthId)),
        )
        .where('resolvedAt', 'is', null)
        .where('dismissedAt', 'is', null)
        .forUpdate()
        .execute();
      if (open.length === 0) {
        return;
      }
      const history = await trx
        .selectFrom('asset_health_step')
        .select(['healthId', 'step', 'outcome', 'facts'])
        .where(
          'healthId',
          'in',
          open.map(({ id }) => id),
        )
        .where('step', 'in', ['asked-phones', 'checked-on-phone'])
        .orderBy('at')
        .orderBy('id')
        .execute();
      const steps: NewFileStep[] = [];
      const settled: string[] = [];
      for (const row of open) {
        const finding = input.findings.find(({ healthId }) => healthId === row.id);
        if (!finding) {
          continue;
        }
        const own = history.filter(({ healthId }) => healthId === row.id);
        const asked = own.findLastIndex(({ step, outcome }) => step === 'asked-phones' && outcome === 'waiting');
        const answered = new Set(
          own
            .slice(asked + 1)
            .filter(({ step }) => step === 'checked-on-phone')
            .map(({ facts }) => (facts as Record<string, unknown> | null)?.session),
        );
        const base = { healthId: row.id, assetId: finding.assetId };
        if (!answered.has(input.sessionId)) {
          answered.add(input.sessionId);
          steps.push({
            ...base,
            step: 'checked-on-phone',
            outcome: 'not-found',
            facts: {
              ...(input.device && { device: input.device }),
              deviceId: input.deviceId,
              session: input.sessionId,
            },
          });
        }
        const waiting = asked !== -1 && (row.evidence as Record<string, unknown> | null)?.fixState === 'waiting-phone';
        if (waiting && input.phones.every((phone) => answered.has(phone))) {
          steps.push({ ...base, step: 'asked-phones', outcome: 'not-found' });
          settled.push(row.id);
        }
      }
      await this.appendSteps(steps, trx);
      if (settled.length > 0) {
        await trx
          .withSchema('public')
          .updateTable('asset_health')
          .set({ evidence: sql`coalesce(evidence, '{}'::jsonb) || '{"fixState":"missing"}'::jsonb` })
          .where('id', 'in', settled)
          .execute();
      }
    });
  }

  /** The problems a reader may see (FL-1337): the owner's, or every account's for an administrator, with their privacy. */
  private fileProblems(options: { ownerId?: string; privacy?: MediaHealthPrivacy }) {
    return this.db
      .withSchema('public')
      .selectFrom('asset_health')
      .innerJoin('asset', 'asset.id', 'asset_health.assetId')
      .innerJoin('user', 'user.id', 'asset.ownerId')
      .$if(!!options.ownerId, (qb) => qb.where('asset.ownerId', '=', asUuid(options.ownerId!)))
      .$if(!!options.privacy, (qb) => qb.where((eb) => lockedOwnerScope(eb, options.privacy!.lockedOwnerId)))
      .$call((qb) => withHiddenContentFilter(qb, options.privacy));
  }

  /**
   * Which problems a tab holds (FL-1337 ruling 1). Needs you: open, and no fix settled it any other way
   * (a problem no fix has looked at yet counts). Fixed for you: fixed in the last 30 days. Left as they are:
   * kept as they are, open or settled. A dismissed problem, or one whose photo is in the Trash, is in none,
   * and while a photo has a problem open, the list goes by that one: its settled ones are in no tab, their
   * history still readable (Review Focus 5).
   */
  private inFileProblemTab(tab: FileProblemTab, fixedDays = FIXED_TAB_DAYS) {
    const fixState = sql`(asset_health.evidence->>'fixState')`;
    const shown = sql`asset_health."dismissedAt" IS NULL AND asset."deletedAt" IS NULL
      AND (asset_health."resolvedAt" IS NULL OR NOT EXISTS (
        SELECT 1 FROM public.asset_health other
        WHERE other."assetId" = asset_health."assetId" AND other.id <> asset_health.id
          AND other."resolvedAt" IS NULL AND other."dismissedAt" IS NULL))`;
    switch (tab) {
      case 'needs': {
        return sql<boolean>`${shown} AND asset_health."resolvedAt" IS NULL
          AND (${fixState} IS NULL OR ${fixState} IN (${sql.join(NEEDS_FIX_STATES)}))`;
      }
      case 'fixed': {
        return sql<boolean>`${shown} AND ${fixState} IN (${sql.join(FIXED_FIX_STATES)})
          AND asset_health."resolvedAt" >= now() - make_interval(days => ${fixedDays})`;
      }
      default: {
        return sql<boolean>`${shown} AND ${fixState} = 'left-as-is'`;
      }
    }
  }

  /** The problems with what a row shows: whose they are, and the step each one's story is told from. */
  private fileProblemRows(options: { ownerId?: string; privacy?: MediaHealthPrivacy }) {
    return this.fileProblems(options)
      .leftJoinLateral(
        (eb) =>
          eb
            .selectFrom('asset_health_step')
            .select(['asset_health_step.step', 'asset_health_step.outcome', 'asset_health_step.facts'])
            .whereRef('asset_health_step.healthId', '=', 'asset_health.id')
            .where('asset_health_step.step', '!=', 'kept-damaged')
            .orderBy('asset_health_step.at', 'desc')
            .orderBy('asset_health_step.id', 'desc')
            .limit(1)
            .as('line'),
        (join) => join.onTrue(),
      )
      .selectAll('asset_health')
      .select([
        'asset.ownerId',
        'user.name as ownerName',
        'asset.deletedAt as assetDeletedAt',
        'line.step as lineStep',
        'line.outcome as lineOutcome',
        'line.facts as lineFacts',
      ]);
  }

  private toFileProblem<
    T extends { lineStep: string | null; lineOutcome: string | null; lineFacts: Record<string, unknown> | null },
  >({ lineStep, lineOutcome, lineFacts, ...row }: T) {
    return {
      ...row,
      line: lineStep ? { step: lineStep, outcome: lineOutcome ?? 'info', facts: lineFacts ?? {} } : null,
    } as unknown as FileProblemRecord;
  }

  /** One page of a tab (FL-1337): Fixed for you part-saved first, then newest fixed; the others newest first. */
  async listFileProblems(options: {
    tab: FileProblemTab;
    ownerId?: string;
    privacy: MediaHealthPrivacy;
    take: number;
    skip: number;
  }): Promise<FileProblemRecord[]> {
    const rows = await this.fileProblemRows(options)
      .where(this.inFileProblemTab(options.tab))
      .$if(options.tab === 'fixed', (qb) =>
        qb
          .orderBy(sql`(asset_health.evidence->>'fixState') = 'part-saved'`, 'desc')
          .orderBy('asset_health.resolvedAt', 'desc'),
      )
      .orderBy('asset_health.updatedAt', 'desc')
      .orderBy('asset_health.id', 'desc')
      .limit(options.take)
      .offset(options.skip)
      .execute();
    return rows.map((row) => this.toFileProblem(row));
  }

  /** How many problems a tab holds, read with the list's own scope and privacy. */
  async countFileProblems(options: { tab: FileProblemTab; ownerId?: string; privacy: MediaHealthPrivacy }) {
    const row = await this.fileProblems(options)
      .where(this.inFileProblemTab(options.tab))
      .select((eb) => eb.fn.countAll<number>().as('count'))
      .executeTakeFirst();
    return Number(row?.count ?? 0);
  }

  /**
   * The Overview's counts (FL-1337): what Frameleaf fixed in the last `days` days, the earliest and the newest of
   * those fixes (Task 11b), and what needs the reader. Read with the list's own tab rules, scope and privacy.
   */
  async fileProblemCounts(options: {
    ownerId?: string;
    privacy: MediaHealthPrivacy;
    days: number;
  }): Promise<{ fixed: number; needsYou: number; since: Date | null; latest: Date | null }> {
    const [fixed, needsYou] = await Promise.all([
      this.fileProblems(options)
        .where(this.inFileProblemTab('fixed', options.days))
        .select((eb) => [
          eb.fn.countAll<number>().as('count'),
          eb.fn.min('asset_health.resolvedAt').as('since'),
          eb.fn.max('asset_health.resolvedAt').as('latest'),
        ])
        .executeTakeFirst(),
      this.countFileProblems({ ...options, tab: 'needs' }),
    ]);
    const time = (value: unknown) => (value ? new Date(value as string | Date) : null);
    return { fixed: Number(fixed?.count ?? 0), needsYou, since: time(fixed?.since), latest: time(fixed?.latest) };
  }

  /**
   * The problem the viewer flags on one photo (FL-1337): the open one in Needs you, the missing one when both a
   * missing and a damaged record are open (Review Focus 5). Closed records, fixed ones and ones kept as they are
   * never flag. Access to the photo is decided by the caller.
   */
  async getOpenFileProblem(assetId: string): Promise<{ id: string; category: MediaHealthCategory } | undefined> {
    return this.fileProblems({})
      .where('asset_health.assetId', '=', asUuid(assetId))
      .where(this.inFileProblemTab('needs'))
      .select(['asset_health.id', 'asset_health.category'])
      .orderBy(sql`asset_health.category = 'missing'`, 'desc')
      .orderBy('asset_health.updatedAt', 'desc')
      .limit(1)
      .executeTakeFirst();
  }

  /** One problem, in any state, as the reader may see it (FL-1337): its history stays readable once closed. */
  async getFileProblem(
    id: string,
    ownerId?: string,
    privacy?: MediaHealthPrivacy,
  ): Promise<FileProblemRecord | undefined> {
    const row = await this.fileProblemRows({ ownerId, privacy })
      .where('asset_health.id', '=', asUuid(id))
      .executeTakeFirst();
    return row && this.toFileProblem(row);
  }

  /**
   * Undo one fix (FL-1337, design §5) in one transaction, holding the owner, both paths, the asset and the
   * problem in the order a relink holds them. `changed`, with nothing written or moved, when the photo is no
   * longer as the fix left it (Review Focus 3): another file or checksum, in the Trash, an edit saved or removed
   * since the fix, or a later fix or Undo; `open` while the photo has another problem open (Review Focus 5).
   * Then a repair or relink points the photo back at the file it used before, a restore moves its files, and
   * the problem is reopened with the `undone` step.
   */
  async undoFix(input: UndoFileFix): Promise<UndoFileFixResult> {
    const target = input.relinkTo && path.normalize(input.relinkTo.path);
    return this.db.transaction().execute(async (trx) => {
      await sql`SELECT pg_advisory_xact_lock_shared(${BUDDY_CAPTURE_LOCK}::bigint)`.execute(trx);
      const owner = await trx
        .withSchema('public')
        .selectFrom('user')
        .select('id')
        .where('id', '=', asUuid(input.ownerId))
        .forUpdate()
        .executeTakeFirst();
      if (!owner) {
        return 'changed';
      }
      for (const filePath of [...new Set([input.expectedOriginalPath, ...(target ? [target] : [])])].sort()) {
        await lockFilePath(trx, filePath);
      }
      const asset = await trx
        .withSchema('public')
        .selectFrom('asset')
        .selectAll()
        .where('id', '=', asUuid(input.assetId))
        .forUpdate()
        .executeTakeFirst();
      const health = await trx
        .withSchema('public')
        .selectFrom('asset_health')
        .selectAll()
        .where('id', '=', asUuid(input.healthId))
        .forUpdate()
        .executeTakeFirst();
      if (
        !asset ||
        asset.ownerId !== input.ownerId ||
        asset.deletedAt ||
        asset.status !== AssetStatus.Active ||
        asset.originalPath !== input.expectedOriginalPath ||
        !asset.checksum.equals(input.expectedChecksum) ||
        !health ||
        health.assetId !== asset.id ||
        health.dismissedAt ||
        !health.resolvedAt
      ) {
        return 'changed';
      }
      // compared in SQL, where the step's time keeps its microseconds
      const { rows } = await sql<{ known: boolean; replaced: boolean; edited: boolean; open: boolean }>`
        SELECT
          EXISTS (SELECT 1 FROM public.asset_health other
            WHERE other."assetId" = ${asset.id}::uuid AND other.id <> ${health.id}::uuid
              AND other."resolvedAt" IS NULL AND other."dismissedAt" IS NULL) AS open,
          EXISTS (SELECT 1 FROM public.asset_health_step fix
            WHERE fix.id = ${input.stepId}::uuid AND fix."healthId" = ${health.id}::uuid) AS known,
          EXISTS (SELECT 1 FROM public.asset_health_step fix
            JOIN public.asset_health_step later ON later."healthId" = fix."healthId"
            WHERE fix.id = ${input.stepId}::uuid AND (later.at, later.id) > (fix.at, fix.id)
              AND (later.undo IS NOT NULL OR later.step = 'undone')) AS replaced,
          EXISTS (SELECT 1 FROM public.asset_health_step fix JOIN public.asset_edit edit ON edit."assetId" = fix."assetId"
            WHERE fix.id = ${input.stepId}::uuid AND edit."updatedAt" > fix.at)
          OR EXISTS (SELECT 1 FROM public.asset_health_step fix
            JOIN public.asset_edit_audit removed ON removed."assetId" = fix."assetId"
            WHERE fix.id = ${input.stepId}::uuid AND removed."deletedAt" > fix.at) AS edited`.execute(trx);
      if (!rows[0]?.known || rows[0].replaced || rows[0].edited) {
        return 'changed';
      }
      if (rows[0].open) {
        return 'open';
      }

      if (target && input.relinkTo) {
        if (asset.isExternal) {
          // another photo of its library at that path now: it is not this photo's to take back
          const occupied =
            !asset.libraryId ||
            !!(await trx
              .withSchema('public')
              .selectFrom('asset')
              .select('id')
              .where('originalPath', '=', target)
              .where('id', '!=', asset.id)
              .where('libraryId', '=', asUuid(asset.libraryId))
              .executeTakeFirst());
          if (occupied) {
            return 'changed';
          }
          await trx
            .withSchema('public')
            .updateTable('asset')
            .set({
              originalPath: target,
              checksum: createHash('sha1').update(`path:${target}`).digest(),
              checksumAlgorithm: ChecksumAlgorithm.sha1Path,
            })
            .where('id', '=', asset.id)
            .execute();
        } else if (!(await this.relinkManagedBack(trx, asset, target, input.relinkTo))) {
          return 'changed';
        }
      }
      await input.moveFiles?.();

      await trx
        .withSchema('public')
        .updateTable('asset_health')
        .set({
          runId: null,
          status: input.status,
          severity: MediaHealthSeverity.Critical,
          ...(target && { originalPath: target }),
          evidence: sql`coalesce(evidence, '{}'::jsonb) || ${JSON.stringify(input.evidence)}::text::jsonb`,
          checkedAt: new Date(),
          resolvedAt: null,
        })
        .where('id', '=', health.id)
        .execute();
      await this.appendSteps(stepsFor(input.steps, health), trx);
      return 'undone';
    });
  }

  /**
   * Point a stored photo back at the file it used before a fix (FL-1337). Its physical file is the one
   * already recorded at that path, or one recorded now for a file that is there; the file it leaves keeps its
   * record, handed to another photo that uses it when there is one, as a relink leaves its previous file.
   * False, with nothing written, when the record at that path is not this file.
   */
  private async relinkManagedBack(
    trx: Kysely<DB>,
    asset: Selectable<AssetTable>,
    target: string,
    { digests, takeChecksum }: NonNullable<UndoFileFix['relinkTo']>,
  ): Promise<boolean> {
    const physical = await trx
      .withSchema('public')
      .selectFrom('physical_file')
      .selectAll()
      .where('path', '=', target)
      .forUpdate()
      .executeTakeFirst();
    if (
      physical &&
      (physical.type !== PhysicalFileType.Original ||
        (digests &&
          !(physical.checksum.length === 20
            ? physical.checksum.equals(digests.sha1)
            : physical.checksum.equals(digests.sha256))))
    ) {
      return false;
    }
    let physicalId = physical?.id ?? null;
    if (!physicalId && digests) {
      physicalId = randomUUID();
      await trx
        .withSchema('public')
        .insertInto('physical_file')
        .values({
          id: physicalId,
          canonicalAssetId: asset.id,
          checksum: digests.sha256,
          path: target,
          sizeInBytes: digests.sizeInBytes,
          type: PhysicalFileType.Original,
        })
        .execute();
    }
    const checksum = takeChecksum && digests ? digests.sha256 : undefined;
    await trx
      .withSchema('public')
      .updateTable('asset')
      .set({
        originalPath: target,
        libraryPath: libraryPathOnRelink(target, true),
        physicalOriginalFileId: physicalId,
        ...(checksum && { checksum, checksumAlgorithm: ChecksumAlgorithm.sha256File }),
      })
      .where('id', '=', asset.id)
      .execute();
    if (physicalId) {
      await sql`UPDATE public.physical_file SET "canonicalAssetId" = ${asset.id}::uuid
        WHERE id = ${physicalId}::uuid AND NOT EXISTS (SELECT 1 FROM public.asset
          WHERE id = physical_file."canonicalAssetId" AND "originalPath" = ${target})`.execute(trx);
    }
    if (asset.physicalOriginalFileId && asset.physicalOriginalFileId !== physicalId) {
      await sql`UPDATE public.physical_file SET "canonicalAssetId" = (SELECT id FROM public.asset WHERE "physicalOriginalFileId" = ${asset.physicalOriginalFileId}::uuid ORDER BY id LIMIT 1)
        WHERE id = ${asset.physicalOriginalFileId}::uuid AND "canonicalAssetId" = ${asset.id}::uuid`.execute(trx);
    }
    if (checksum && digests) {
      await sql`INSERT INTO public.asset_checksum ("assetId", sha1, sha256, "sizeInBytes", "verifiedPaths", "linkCount", evidence, "verifiedAt", "updatedAt")
        VALUES (${asset.id}::uuid, ${digests.sha1}, ${digests.sha256}, ${digests.sizeInBytes}, ARRAY[${target}]::text[], 1, jsonb_build_object('source', 'recovery'::text), now(), now())
        ON CONFLICT ("assetId") DO UPDATE SET sha1=EXCLUDED.sha1, sha256=EXCLUDED.sha256, "sizeInBytes"=EXCLUDED."sizeInBytes",
          "verifiedPaths"=EXCLUDED."verifiedPaths", evidence=EXCLUDED.evidence, "verifiedAt"=now(), "updatedAt"=now()`.execute(
        trx,
      );
    }
    return true;
  }

  /** A photo went to the Trash (FL-1337): `removed` on each of its open problems, with who removed it. */
  async recordRemoved(assetIds: string[], facts: Record<string, unknown>): Promise<void> {
    if (assetIds.length === 0) {
      return;
    }
    await this.db.transaction().execute(async (trx) => {
      const open = await trx
        .withSchema('public')
        .selectFrom('asset_health')
        .select(['id', 'assetId'])
        .where('assetId', '=', anyUuid(assetIds))
        .where('resolvedAt', 'is', null)
        .where('dismissedAt', 'is', null)
        .forUpdate()
        .execute();
      await this.appendSteps(
        open.map((row) => ({ healthId: row.id, assetId: row.assetId, step: 'removed', outcome: 'info', facts })),
        trx,
      );
    });
  }

  async listSteps(healthId: string): Promise<FileStep[]> {
    const rows = await this.db
      .selectFrom('asset_health_step')
      .selectAll()
      .where('healthId', '=', healthId)
      .orderBy('at')
      .orderBy('id')
      .execute();
    return rows.map((row) => ({
      ...row,
      step: row.step as FileStep['step'],
      outcome: row.outcome as FileStep['outcome'],
    }));
  }
}
