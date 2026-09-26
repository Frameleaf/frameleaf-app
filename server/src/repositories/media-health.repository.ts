import { Injectable } from '@nestjs/common';
import { Insertable, Kysely, Selectable, Updateable, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import type { HiddenContentQueryOptions } from 'src/utils/hidden-content.js';
import type { LockedVisibilityOptions } from 'src/utils/locked-visibility.js';
import { EXTERNAL_SCAN_CHECKSUM } from 'src/constants.js';
import {
  AssetFileType,
  AssetStatus,
  ChecksumAlgorithm,
  MediaHealthCategory,
  MediaHealthSeverity,
  MediaHealthStatus,
  PhysicalFileType,
} from 'src/enum.js';
import {
  DerivedBackfillResult,
  TableVerification,
  combineVerifications,
  getForkSchemaPhase,
  lockForkAssetParent,
  readsForkSidecar,
  verifyRows,
  writesForkSidecar,
  writesLegacy,
} from 'src/repositories/fork-derived-results.js';
import { DB } from 'src/schema/index.js';
import {
  AssetHealthCandidateTable,
  AssetHealthRunTable,
  AssetHealthTable,
} from 'src/schema/tables/asset-health.table.js';
import { AssetTable } from 'src/schema/tables/asset.table.js';
import { anyUuid, asUuid, lockedOwnerScope, withHiddenContentFilter } from 'src/utils/database.js';
import { isLocked } from 'src/utils/locked.js';

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
};

export type UpsertMediaHealthCandidate = Omit<Insertable<AssetHealthCandidateTable>, 'id' | 'createdAt' | 'updatedAt'>;
export type RelinkManagedAsset = {
  verifyCandidate: () => Promise<{ sha1: Buffer; sha256: Buffer; sizeInBytes: number } | undefined>;
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
};
export type RelinkExternalAsset = RelinkManagedAsset & { expectedLibraryId: string };
type HealthBackfillTables = {
  assetHealthRun: TableVerification;
  assetHealth: TableVerification;
  assetHealthCandidate: TableVerification;
};

@Injectable()
export class MediaHealthRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {}

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
    const phase = await getForkSchemaPhase(this.db);
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
          .withSchema(readsForkSidecar(phase) ? 'immich_fork' : 'public')
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
      if (writesLegacy(phase)) {
        await trx.withSchema('public').insertInto('asset_health_run').values(run).execute();
      }
      if (writesForkSidecar(phase)) {
        await trx.withSchema('immich_fork').insertInto('asset_health_run').values(run).execute();
      }
      return run;
    });
  }

  async finishRun(id: string, update: Updateable<AssetHealthRunTable>): Promise<MediaHealthRun | undefined> {
    const phase = await getForkSchemaPhase(this.db);
    const values = { ...update, finishedAt: update.finishedAt === undefined ? new Date() : update.finishedAt };
    let result: MediaHealthRun | undefined;
    await this.db.transaction().execute(async (trx) => {
      if (writesLegacy(phase)) {
        result = await trx
          .withSchema('public')
          .updateTable('asset_health_run')
          .set(values)
          .where('id', '=', asUuid(id))
          .returningAll()
          .executeTakeFirst();
      }
      if (writesForkSidecar(phase)) {
        const sidecar = await trx
          .withSchema('immich_fork')
          .updateTable('asset_health_run')
          .set(values)
          .where('id', '=', asUuid(id))
          .returningAll()
          .executeTakeFirst();
        result ??= sidecar;
      }
    });
    return result;
  }

  async getLatestRun(category?: MediaHealthCategory, ownerId?: string): Promise<MediaHealthRun | undefined> {
    const phase = await getForkSchemaPhase(this.db);
    return this.db
      .withSchema(readsForkSidecar(phase) ? 'immich_fork' : 'public')
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
    const phase = await getForkSchemaPhase(this.db);
    const schema = readsForkSidecar(phase) ? 'immich_fork' : 'public';
    return (this.db as Kysely<any>)
      .selectFrom(`${schema}.asset_health as asset_health`)
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
    const phase = await getForkSchemaPhase(this.db);
    const schema = readsForkSidecar(phase) ? 'immich_fork' : 'public';
    const row = await (this.db as Kysely<any>)
      .selectFrom(`${schema}.asset_health as asset_health`)
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
  async countByStatus(options: {
    ownerId?: string;
    privacy: MediaHealthPrivacy;
  }): Promise<Array<{ category: MediaHealthCategory; status: MediaHealthStatus; count: number }>> {
    const phase = await getForkSchemaPhase(this.db);
    const schema = readsForkSidecar(phase) ? 'immich_fork' : 'public';
    const rows = await (this.db as Kysely<any>)
      .selectFrom(`${schema}.asset_health as asset_health`)
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
      const result = await sql<{ count: number }>`
        SELECT count(*)::int AS count FROM immich_fork.icloud_resource
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
    const phase = await getForkSchemaPhase(this.db);
    const schema = readsForkSidecar(phase) ? 'immich_fork' : 'public';
    return (this.db as Kysely<any>)
      .selectFrom(`${schema}.asset_health as asset_health`)
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
    const phase = await getForkSchemaPhase(this.db);
    return this.db
      .withSchema(readsForkSidecar(phase) ? 'immich_fork' : 'public')
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
      FROM immich_fork.asset_checksum
      WHERE "assetId" = ANY(${assetIds}::uuid[])
    `.execute(this.db);
    return result.rows;
  }

  getInternalAssetByOriginalPath(originalPath: string): Promise<{ id: string } | undefined> {
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
    const phase = await getForkSchemaPhase(this.db);
    const retained = await (this.db as Kysely<any>)
      .selectFrom(`${readsForkSidecar(phase) ? 'immich_fork' : 'public'}.asset_health as asset_health`)
      .select(sql<string>`asset_health.evidence->>'retainedPath'`.as('retainedPath'))
      .where(sql<string>`asset_health.evidence->>'retainedPath'`, 'in', paths)
      .execute();
    for (const { retainedPath } of retained as Array<{ retainedPath: string }>) {
      tracked.add(retainedPath);
    }
    return tracked;
  }

  async replaceCandidates(healthId: string, candidates: UpsertMediaHealthCandidate[]): Promise<void> {
    const phase = await getForkSchemaPhase(this.db);
    if (candidates.some((candidate) => candidate.healthId !== healthId)) {
      throw new Error(`Cannot replace media-health candidates for multiple findings`);
    }
    const now = new Date();
    const rows = candidates.map((candidate) => ({ id: randomUUID(), createdAt: now, updatedAt: now, ...candidate }));
    await this.db.transaction().execute(async (trx) => {
      if (writesForkSidecar(phase)) {
        const observedFinding = await trx
          .withSchema('immich_fork')
          .selectFrom('asset_health')
          .select(['assetId', 'runId'])
          .where('id', '=', asUuid(healthId))
          .executeTakeFirst();
        if (!observedFinding) {
          throw new Error(`Cannot write candidates for missing fork media-health finding ${healthId}`);
        }
        await lockForkAssetParent(trx, observedFinding.assetId);
        const finding = await trx
          .withSchema('immich_fork')
          .selectFrom('asset_health')
          .select(['assetId', 'runId'])
          .where('id', '=', asUuid(healthId))
          .forKeyShare()
          .executeTakeFirst();
        if (!finding || finding.assetId !== observedFinding.assetId) {
          throw new Error(`Fork media-health finding ${healthId} changed while replacing candidates`);
        }
        if (finding.runId) {
          await this.lockForkHealthRun(trx, finding.runId);
        }
      }
      for (const schema of this.writeSchemas(phase)) {
        const target = trx.withSchema(schema);
        await target.deleteFrom('asset_health_candidate').where('healthId', '=', asUuid(healthId)).execute();
        if (rows.length > 0) {
          await target.insertInto('asset_health_candidate').values(rows).execute();
        }
      }
    });
  }

  async upsertFinding(input: UpsertMediaHealthFinding): Promise<MediaHealthFinding | undefined> {
    const { expectedUpdateId, ...finding } = input;
    return this.db.transaction().execute(async (trx) => {
      const phase = await this.lockHealthPhase(trx);
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
      if (writesForkSidecar(phase)) {
        await lockForkAssetParent(trx, finding.assetId);
        if (finding.runId) {
          await this.lockForkHealthRun(trx, finding.runId);
        }
      }
      let result: MediaHealthFinding | undefined;
      if (writesLegacy(phase)) {
        result = await this.upsertFindingInto(trx.withSchema('public'), finding);
      }
      if (writesForkSidecar(phase)) {
        if (writesLegacy(phase)) {
          await this.copyFindingExact(trx.withSchema('immich_fork'), result!);
        } else {
          result = await this.upsertFindingInto(trx.withSchema('immich_fork'), finding);
        }
      }
      return result;
    });
  }

  private async lockHealthPhase(trx: Kysely<DB>) {
    const phase = await getForkSchemaPhase(trx);
    if (phase === 'legacy') {
      return phase;
    }
    const result = await sql<{
      phase: typeof phase;
    }>`SELECT phase FROM immich_fork.state WHERE id = 1 FOR SHARE`.execute(trx);
    return result.rows[0]?.phase ?? phase;
  }

  async markResolvedForAssets(
    categories: MediaHealthCategory[],
    assets: Pick<MediaHealthAsset, 'id' | 'updateId' | 'originalPath'>[],
  ): Promise<void> {
    if (assets.length === 0 || categories.length === 0) {
      return;
    }
    await this.db.transaction().execute(async (trx) => {
      const phase = await this.lockHealthPhase(trx);
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
      for (const schema of this.writeSchemas(phase)) {
        await trx
          .withSchema(schema)
          .updateTable('asset_health')
          .set({ status: MediaHealthStatus.Resolved, severity: MediaHealthSeverity.Info, resolvedAt: new Date() })
          .where('category', 'in', categories)
          .where('assetId', '=', anyUuid(ids))
          .execute();
      }
    });
  }

  async trashCorruptIfUnchanged(input: {
    healthId: string;
    asset: Pick<MediaHealthAsset, 'id' | 'ownerId' | 'updateId' | 'originalPath'>;
  }): Promise<boolean> {
    return this.db.transaction().execute(async (trx) => {
      const phase = await this.lockHealthPhase(trx);
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
        .withSchema(readsForkSidecar(phase) ? 'immich_fork' : 'public')
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
      for (const schema of this.writeSchemas(phase)) {
        await trx
          .withSchema(schema)
          .updateTable('asset_health')
          .set({ status: MediaHealthStatus.Trashed })
          .where('id', '=', asUuid(input.healthId))
          .execute();
      }
      return true;
    });
  }

  private async lockForkHealthRun(db: Kysely<DB>, runId: string): Promise<void> {
    const run = await db
      .withSchema('immich_fork')
      .selectFrom('asset_health_run')
      .select('id')
      .where('id', '=', asUuid(runId))
      .forKeyShare()
      .executeTakeFirst();
    if (!run) {
      throw new Error(`Cannot write fork media-health result for missing run ${runId}`);
    }
  }

  private upsertFindingInto(db: Kysely<DB>, finding: UpsertMediaHealthFinding): Promise<MediaHealthFinding> {
    return db
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
          evidence: eb.ref('excluded.evidence'),
          resolution: eb.ref('excluded.resolution'),
          checkedAt: eb.ref('excluded.checkedAt'),
          dismissedAt: eb.ref('excluded.dismissedAt'),
          resolvedAt: eb.ref('excluded.resolvedAt'),
        })),
      )
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  private async copyFindingExact(db: Kysely<DB>, finding: MediaHealthFinding): Promise<void> {
    await db
      .insertInto('asset_health')
      .values(finding)
      .onConflict((oc) => oc.columns(['assetId', 'category']).doUpdateSet(finding))
      .execute();
  }

  async markResolved(category: MediaHealthCategory, assetId: string): Promise<void> {
    const phase = await getForkSchemaPhase(this.db);
    const resolvedAt = new Date();
    await this.db.transaction().execute(async (trx) => {
      for (const schema of this.writeSchemas(phase)) {
        await trx
          .withSchema(schema)
          .updateTable('asset_health')
          .set({ status: MediaHealthStatus.Resolved, severity: MediaHealthSeverity.Info, resolvedAt })
          .where('category', '=', category)
          .where('assetId', '=', asUuid(assetId))
          .execute();
      }
    });
  }

  async markResolvedMany(category: MediaHealthCategory, assetIds: string[]): Promise<void> {
    if (assetIds.length === 0) {
      return;
    }
    const phase = await getForkSchemaPhase(this.db);
    const resolvedAt = new Date();
    await this.db.transaction().execute(async (trx) => {
      for (const schema of this.writeSchemas(phase)) {
        await trx
          .withSchema(schema)
          .updateTable('asset_health')
          .set({ status: MediaHealthStatus.Resolved, severity: MediaHealthSeverity.Info, resolvedAt })
          .where('category', '=', category)
          .where('assetId', '=', anyUuid(assetIds))
          .execute();
      }
    });
  }

  async markResolvedCategories(categories: MediaHealthCategory[], assetId: string): Promise<void> {
    if (categories.length === 0) {
      return;
    }
    const phase = await getForkSchemaPhase(this.db);
    const resolvedAt = new Date();
    await this.db.transaction().execute(async (trx) => {
      for (const schema of this.writeSchemas(phase)) {
        await trx
          .withSchema(schema)
          .updateTable('asset_health')
          .set({ status: MediaHealthStatus.Resolved, severity: MediaHealthSeverity.Info, resolvedAt })
          .where('category', 'in', categories)
          .where('assetId', '=', asUuid(assetId))
          .execute();
      }
    });
  }

  async markDismissed(ids: string[], ownerId?: string): Promise<void> {
    if (ids.length === 0) {
      return;
    }

    const phase = await getForkSchemaPhase(this.db);
    const dismissedAt = new Date();
    await this.db.transaction().execute(async (trx) => {
      for (const schema of this.writeSchemas(phase)) {
        await trx
          .withSchema(schema)
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
            qb.where(
              sql<boolean>`EXISTS (
                SELECT 1 FROM public.asset
                WHERE asset.id = asset_health."assetId" AND asset."ownerId" = ${ownerId}::uuid
              )`,
            ),
          )
          .execute();
      }
    });
  }

  /**
   * Put a settled finding back to `to` (FL-69, UT-2: undoing a dismissal, or damage whose trash move
   * was reversed). Only while it is still `from`, so a finding something else changed since is left
   * alone. Returns whether it was reopened.
   */
  async reopenFinding(id: string, from: MediaHealthStatus, to: MediaHealthStatus): Promise<boolean> {
    const phase = await getForkSchemaPhase(this.db);
    return this.db.transaction().execute(async (trx) => {
      let reopened = false;
      for (const schema of this.writeSchemas(phase)) {
        const result = await trx
          .withSchema(schema)
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
      }
      return reopened;
    });
  }

  /**
   * Record which candidate the reviewer chose for a finding (FL-69). A missing original found in
   * several places relinks to this one; the choice is metadata only and is re-verified at relink.
   * Returns false when the candidate no longer belongs to the finding.
   */
  async setChosenCandidate(healthId: string, candidateId: string): Promise<boolean> {
    const phase = await getForkSchemaPhase(this.db);
    return this.db.transaction().execute(async (trx) => {
      const candidate = await trx
        .withSchema(readsForkSidecar(phase) ? 'immich_fork' : 'public')
        .selectFrom('asset_health_candidate')
        .select('id')
        .where('id', '=', asUuid(candidateId))
        .where('healthId', '=', asUuid(healthId))
        .executeTakeFirst();
      if (!candidate) {
        return false;
      }
      for (const schema of this.writeSchemas(phase)) {
        await trx
          .withSchema(schema)
          .updateTable('asset_health')
          .set({
            resolution: sql`coalesce(resolution, '{}'::jsonb) || jsonb_build_object('chosenCandidateId', ${candidateId}::text)`,
          })
          .where('id', '=', asUuid(healthId))
          .execute();
      }
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

  /** Record where a replaced damaged original is kept now (FL-69). Metadata only. */
  async setRetainedPath(healthId: string, retainedPath: string): Promise<void> {
    const phase = await getForkSchemaPhase(this.db);
    await this.db.transaction().execute(async (trx) => {
      for (const schema of this.writeSchemas(phase)) {
        await trx
          .withSchema(schema)
          .updateTable('asset_health')
          .set({
            evidence: sql`coalesce(evidence, '{}'::jsonb) || jsonb_build_object('retainedPath', ${retainedPath}::text)`,
          })
          .where('id', '=', asUuid(healthId))
          .execute();
      }
    });
  }

  /**
   * Findings a trash job was queued for but no running job holds any more (FL-69): the job was
   * cancelled, skipped them or failed. They go back to confirmed damage so they can be reviewed
   * again. Findings queued in the last few minutes are left alone: their job may not exist yet.
   */
  async releaseTrashQueued(options: { ownerId?: string; keep: string[]; olderThan: Date }): Promise<number> {
    const phase = await getForkSchemaPhase(this.db);
    return this.db.transaction().execute(async (trx) => {
      let released = 0;
      for (const schema of this.writeSchemas(phase)) {
        const result = await (trx as Kysely<any>)
          .updateTable(`${schema}.asset_health as asset_health`)
          .set({ status: MediaHealthStatus.CorruptConfirmed })
          .where('asset_health.status', '=', MediaHealthStatus.TrashQueued)
          .where('asset_health.updatedAt', '<', options.olderThan)
          .$if(options.keep.length > 0, (qb) =>
            qb.where((eb) => eb.not(eb('asset_health.id', '=', anyUuid(options.keep)))),
          )
          .$if(!!options.ownerId, (qb) =>
            qb.where(
              sql<boolean>`EXISTS (
                SELECT 1 FROM public.asset
                WHERE asset.id = asset_health."assetId" AND asset."ownerId" = ${options.ownerId}::uuid
              )`,
            ),
          )
          .executeTakeFirst();
        released = Math.max(released, Number(result.numUpdatedRows ?? 0));
      }
      return released;
    });
  }

  /** Findings a running or waiting trash job still holds, across every account (FL-69). */
  async getActiveTrashFindingIds(): Promise<string[]> {
    const result = await sql<{ findingId: string | null }>`
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

    const phase = await getForkSchemaPhase(this.db);
    await this.db.transaction().execute(async (trx) => {
      for (const schema of this.writeSchemas(phase)) {
        await trx
          .withSchema(schema)
          .updateTable('asset_health')
          .set({ status })
          .where('id', '=', anyUuid(ids))
          .execute();
      }
    });
  }

  async *streamAssets(options: { assetIds?: string[]; ownerId?: string } = {}): AsyncGenerator<MediaHealthAsset> {
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
  }): Promise<MediaHealthAsset[]> {
    return this.scanAssetQuery({ ownerId: options.ownerId })
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

  private async commitRelink(input: RelinkManagedAsset | RelinkExternalAsset): Promise<boolean> {
    const recoveredPath = path.normalize(input.originalPath);
    const external = 'expectedLibraryId' in input;
    return this.db.transaction().execute(async (trx) => {
      const phase = await this.lockHealthPhase(trx);
      // A relink writes whichever schemas the locked phase keeps: the legacy tables before the fork
      // backfill (a new install stays in the legacy phase until it runs), the fork sidecar once it does.
      // With neither (inactive or failed), nothing may be written.
      const forkWrites = writesForkSidecar(phase);
      if (!writesLegacy(phase) && !forkWrites) {
        return false;
      }
      const migrating = await sql`SELECT 1 FROM immich_fork.migration_audit
        WHERE status = 'running' AND name IN ('fork-return-reconciliation', 'official-handoff-preparation') LIMIT 1`.execute(
        trx,
      );
      if (migrating.rows.length > 0) {
        return false;
      }
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
        const key = createHash('sha1').update(candidatePath).digest().readBigInt64BE(0);
        await sql`SELECT pg_advisory_xact_lock(${key.toString()}::bigint)`.execute(trx);
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
      const reserved =
        await sql`SELECT 1 FROM immich_fork.asset_storage_reservation WHERE "assetId" = ${asset.id}::uuid AND status = 'reserved'`.execute(
          trx,
        );
      if (reserved.rows.length > 0) {
        return false;
      }
      const sidecars =
        await sql<MediaHealthChecksum>`SELECT "assetId", sha1, sha256, "sizeInBytes" FROM immich_fork.asset_checksum WHERE "assetId" = ${asset.id}::uuid FOR UPDATE`.execute(
          trx,
        );
      const contentMatches =
        asset.checksumAlgorithm === ChecksumAlgorithm.sha256File
          ? input.sha256.equals(asset.checksum)
          : asset.checksumAlgorithm === ChecksumAlgorithm.sha1File
            ? input.sha1.equals(asset.checksum)
            : !!sidecars.rows[0]?.sha1.equals(input.sha1) && !!sidecars.rows[0]?.sha256.equals(input.sha256);
      if (
        !contentMatches ||
        input.sha1.length !== 20 ||
        input.sha256.length !== 32 ||
        !Number.isSafeInteger(input.sizeInBytes) ||
        input.sizeInBytes <= 0
      ) {
        return false;
      }
      const schema = readsForkSidecar(phase) ? 'immich_fork' : 'public';
      const health = await trx
        .withSchema(schema)
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
        health.status !==
          (category === MediaHealthCategory.Missing ? MediaHealthStatus.Found : MediaHealthStatus.CorruptConfirmed) ||
        health.resolvedAt ||
        health.dismissedAt ||
        health.originalPath !== asset.originalPath ||
        (category === MediaHealthCategory.Missing && health.resolution?.autoRelinkable !== true && !chosen)
      ) {
        return false;
      }
      const candidates = await trx
        .withSchema(schema)
        .selectFrom('asset_health_candidate')
        .selectAll()
        .where('healthId', '=', input.healthId)
        .where('status', '=', MediaHealthStatus.Found)
        .forUpdate()
        .execute();
      // One verified candidate relinks by itself; among several, only the one the reviewer chose.
      const candidate = candidates.find(({ id }) => id === input.candidateId);
      if (
        !candidate ||
        (candidates.length !== 1 && !chosen) ||
        path.normalize(candidate.candidatePath) !== path.normalize(input.candidatePath ?? input.originalPath) ||
        candidate.resolution?.autoRelinkable !== true
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
            checksum: createHash('sha1').update(`path:${recoveredPath}`).digest(),
            checksumAlgorithm: ChecksumAlgorithm.sha1Path,
            fileModifiedAt: input.fileModifiedAt,
            isOffline: false,
          })
          .where('id', '=', asset.id)
          .execute();
      } else {
        const oldMapping = await sql<{
          physicalFileId: string;
        }>`SELECT "physicalFileId" FROM immich_fork.asset_physical_file WHERE "assetId" = ${asset.id}::uuid FOR UPDATE`.execute(
          trx,
        );
        const forkRows = await sql<{
          id: string;
          checksum: Buffer;
          sizeInBytes: number;
          type: string;
        }>`SELECT id, checksum, "sizeInBytes", type FROM immich_fork.physical_file WHERE "canonicalPath" = ${recoveredPath} FOR UPDATE`.execute(
          trx,
        );
        const forkPhysical = forkRows.rows[0];
        if (
          forkPhysical &&
          (forkPhysical.type !== PhysicalFileType.Original ||
            !(forkPhysical.checksum.length === 20
              ? forkPhysical.checksum.equals(input.sha1)
              : forkPhysical.checksum.length === 32 && forkPhysical.checksum.equals(input.sha256)) ||
            Number(forkPhysical.sizeInBytes) !== input.sizeInBytes)
        ) {
          return false;
        }
        let legacyId: string | undefined;
        if (writesLegacy(phase)) {
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
          legacyId = physical?.id ?? randomUUID();
          if (!physical) {
            await trx
              .withSchema('public')
              .insertInto('physical_file')
              .values({
                id: legacyId,
                canonicalAssetId: canonical,
                checksum: input.sha256,
                path: recoveredPath,
                sizeInBytes: input.sizeInBytes,
                type: PhysicalFileType.Original,
              })
              .execute();
          }
        }
        if (!writesLegacy(phase) && !(await verify())) {
          return false;
        }
        const forkId = forkPhysical?.id ?? legacyId ?? randomUUID();
        // the fork's physical mapping is kept only while its writes are on; the backfill rebuilds it
        if (forkWrites && !forkPhysical) {
          await sql`INSERT INTO immich_fork.physical_file (id, "canonicalAssetId", type, checksum, "sizeInBytes", "canonicalPath", "createdAt", "updatedAt")
            VALUES (${forkId}::uuid, ${canonical}::uuid, 'original', ${input.sha256}, ${input.sizeInBytes}, ${recoveredPath}, now(), now())`.execute(
            trx,
          );
        }
        if (forkWrites) {
          await sql`INSERT INTO immich_fork.asset_physical_file ("assetId", "physicalFileId", "upstreamPath", "verifiedAt", "updatedAt")
            VALUES (${asset.id}::uuid, ${forkId}::uuid, ${recoveredPath}, now(), now()) ON CONFLICT ("assetId") DO UPDATE SET
            "physicalFileId" = EXCLUDED."physicalFileId", "upstreamPath" = EXCLUDED."upstreamPath", "verifiedAt" = now(), "updatedAt" = now()`.execute(
            trx,
          );
        }
        const column = await sql<{
          present: boolean;
        }>`SELECT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.asset'::regclass AND attname = 'physicalOriginalFileId' AND NOT attisdropped) AS present`.execute(
          trx,
        );
        await trx
          .withSchema('public')
          .updateTable('asset')
          .set({
            originalPath: recoveredPath,
            checksum: input.sha256,
            checksumAlgorithm: ChecksumAlgorithm.sha256File,
            fileModifiedAt: input.fileModifiedAt,
            isOffline: false,
            ...(column.rows[0]?.present && { physicalOriginalFileId: legacyId ?? null }),
          })
          .where('id', '=', asset.id)
          .execute();
        if (writesLegacy(phase) && asset.physicalOriginalFileId) {
          await sql`UPDATE public.physical_file SET "canonicalAssetId" = (SELECT id FROM public.asset WHERE "physicalOriginalFileId" = ${asset.physicalOriginalFileId}::uuid ORDER BY id LIMIT 1)
            WHERE id = ${asset.physicalOriginalFileId}::uuid AND "canonicalAssetId" = ${asset.id}::uuid`.execute(trx);
        }
        const previousForkId = oldMapping.rows[0]?.physicalFileId;
        if (forkWrites && previousForkId) {
          await sql`UPDATE immich_fork.physical_file SET "canonicalAssetId" = (SELECT "assetId" FROM immich_fork.asset_physical_file WHERE "physicalFileId" = ${previousForkId}::uuid ORDER BY "assetId" LIMIT 1)
            WHERE id = ${previousForkId}::uuid AND "canonicalAssetId" = ${asset.id}::uuid`.execute(trx);
        }
      }
      // FL-69: an external original keeps its path checksum, so its digests stay Library Care's own (an
      // external scan's), never a managed copy that sync, upload checks or restores could count
      const evidenceSource = external ? EXTERNAL_SCAN_CHECKSUM : 'recovery';
      await sql`INSERT INTO immich_fork.asset_checksum ("assetId", sha1, sha256, "sizeInBytes", "verifiedPaths", "linkCount", evidence, "verifiedAt", "updatedAt")
        VALUES (${asset.id}::uuid, ${input.sha1}, ${input.sha256}, ${input.sizeInBytes}, ARRAY[${recoveredPath}]::text[], 1, jsonb_build_object('source', ${evidenceSource}::text), now(), now())
        ON CONFLICT ("assetId") DO UPDATE SET sha1=EXCLUDED.sha1, sha256=EXCLUDED.sha256, "sizeInBytes"=EXCLUDED."sizeInBytes",
          "verifiedPaths"=EXCLUDED."verifiedPaths", evidence=EXCLUDED.evidence, "verifiedAt"=now(), "updatedAt"=now()`.execute(
        trx,
      );
      const checkedAt = new Date();
      for (const writeSchema of this.writeSchemas(phase)) {
        await trx
          .withSchema(writeSchema)
          .updateTable('asset_health')
          .set({
            runId: null,
            // A replaced damaged original is resolved; its file stays where it was (`retainedPath`).
            status: category === MediaHealthCategory.Missing ? MediaHealthStatus.Relinked : MediaHealthStatus.Resolved,
            severity: MediaHealthSeverity.Info,
            originalPath: recoveredPath,
            originalFileName: input.originalFileName,
            evidence: {
              reason: category === MediaHealthCategory.Missing ? 'candidate_relinked' : 'recovered_from_verified_copy',
              previousPath: asset.originalPath,
              ...(category === MediaHealthCategory.Corrupt && { retainedPath: asset.originalPath }),
              ...(input.candidatePath && { candidatePath: path.normalize(input.candidatePath) }),
              ...(input.provenance && { provenance: input.provenance }),
            },
            resolution: { healthId: input.healthId, candidateId: input.candidateId },
            checkedAt,
            resolvedAt: checkedAt,
          })
          .where('id', '=', input.healthId)
          .where('assetId', '=', asset.id)
          .execute();
        await trx
          .withSchema(writeSchema)
          .updateTable('asset_health_candidate')
          .set({ resolution: { autoRelinkable: false } })
          .where('healthId', '=', input.healthId)
          .execute();
      }
      return true;
    });
  }

  async deleteForAssets(assetIds: string[], db: Kysely<DB> = this.db): Promise<void> {
    if (assetIds.length === 0) {
      return;
    }
    await sql`
      DELETE FROM immich_fork.asset_health_candidate candidate
      USING immich_fork.asset_health health
      WHERE candidate."healthId" = health.id AND health."assetId" = ANY(${assetIds}::uuid[])
    `.execute(db);
    await sql`DELETE FROM immich_fork.asset_health WHERE "assetId" = ANY(${assetIds}::uuid[])`.execute(db);
  }

  async backfillHealth(ids: string[]): Promise<DerivedBackfillResult<HealthBackfillTables>> {
    return this.db.transaction().execute(async (trx) => {
      await sql`
        INSERT INTO immich_fork.orphaned_records ("sourceTable", "sourceKey", payload)
        SELECT 'asset_health', health.id::text, to_jsonb(health)
        FROM public.asset_health health
        LEFT JOIN public.asset ON asset.id = health."assetId"
        WHERE asset.id IS NULL
        ON CONFLICT ("sourceTable", "sourceKey") DO UPDATE SET payload = EXCLUDED.payload
      `.execute(trx);
      await sql`
        INSERT INTO immich_fork.orphaned_records ("sourceTable", "sourceKey", payload)
        SELECT 'asset_health_candidate', candidate.id::text, to_jsonb(candidate)
        FROM public.asset_health_candidate candidate
        LEFT JOIN public.asset_health health ON health.id = candidate."healthId"
        LEFT JOIN public.asset ON asset.id = health."assetId"
        WHERE asset.id IS NULL
        ON CONFLICT ("sourceTable", "sourceKey") DO UPDATE SET payload = EXCLUDED.payload
      `.execute(trx);
      await sql`
        DELETE FROM immich_fork.asset_health_candidate candidate
        WHERE NOT EXISTS (
          SELECT 1 FROM public.asset_health_candidate source WHERE source.id = candidate.id
        )
      `.execute(trx);
      await sql`
        DELETE FROM immich_fork.asset_health health
        WHERE NOT EXISTS (SELECT 1 FROM public.asset_health source WHERE source.id = health.id)
      `.execute(trx);
      await sql`
        DELETE FROM immich_fork.asset_health_run run
        WHERE NOT EXISTS (SELECT 1 FROM public.asset_health_run source WHERE source.id = run.id)
      `.execute(trx);
      await sql`
        INSERT INTO immich_fork.asset_health_run
        SELECT * FROM public.asset_health_run
        ON CONFLICT (id) DO UPDATE SET
          category = EXCLUDED.category, status = EXCLUDED.status, "startedAt" = EXCLUDED."startedAt",
          "finishedAt" = EXCLUDED."finishedAt", "totalAssets" = EXCLUDED."totalAssets",
          "checkedAssets" = EXCLUDED."checkedAssets", "foundAssets" = EXCLUDED."foundAssets", error = EXCLUDED.error,
          "ownerId" = EXCLUDED."ownerId"
      `.execute(trx);
      if (ids.length > 0) {
        await sql`
          DELETE FROM immich_fork.asset_health_candidate candidate
          USING immich_fork.asset_health health
          WHERE candidate."healthId" = health.id AND health."assetId" = ANY(${ids}::uuid[])
        `.execute(trx);
        await sql`DELETE FROM immich_fork.asset_health WHERE "assetId" = ANY(${ids}::uuid[])`.execute(trx);
        await sql`
          INSERT INTO immich_fork.asset_health
          SELECT health.* FROM public.asset_health health
          INNER JOIN public.asset ON asset.id = health."assetId"
          WHERE health."assetId" = ANY(${ids}::uuid[])
          ON CONFLICT ("assetId", category) DO UPDATE SET
            id = EXCLUDED.id, "runId" = EXCLUDED."runId", status = EXCLUDED.status, severity = EXCLUDED.severity,
            "originalPath" = EXCLUDED."originalPath", "originalFileName" = EXCLUDED."originalFileName",
            evidence = EXCLUDED.evidence, resolution = EXCLUDED.resolution, "checkedAt" = EXCLUDED."checkedAt",
            "dismissedAt" = EXCLUDED."dismissedAt", "resolvedAt" = EXCLUDED."resolvedAt",
            "createdAt" = EXCLUDED."createdAt", "updatedAt" = EXCLUDED."updatedAt"
        `.execute(trx);
        await sql`
          INSERT INTO immich_fork.asset_health_candidate
          SELECT candidate.* FROM public.asset_health_candidate candidate
          INNER JOIN public.asset_health health ON health.id = candidate."healthId"
          INNER JOIN public.asset ON asset.id = health."assetId"
          WHERE health."assetId" = ANY(${ids}::uuid[])
          ON CONFLICT ("healthId", "candidatePath") DO UPDATE SET
            id = EXCLUDED.id, status = EXCLUDED.status, "visualMatchScore" = EXCLUDED."visualMatchScore",
            evidence = EXCLUDED.evidence, resolution = EXCLUDED.resolution, "checkedAt" = EXCLUDED."checkedAt",
            "createdAt" = EXCLUDED."createdAt", "updatedAt" = EXCLUDED."updatedAt"
        `.execute(trx);
      }
      await sql`
        DELETE FROM immich_fork.asset_health_candidate candidate
        WHERE NOT EXISTS (SELECT 1 FROM immich_fork.asset_health health WHERE health.id = candidate."healthId")
      `.execute(trx);
      await sql`
        DELETE FROM immich_fork.asset_health health
        WHERE NOT EXISTS (SELECT 1 FROM public.asset WHERE asset.id = health."assetId")
      `.execute(trx);
      const runs = await sql<Record<string, unknown>>`
        SELECT * FROM immich_fork.asset_health_run ORDER BY id::text
      `.execute(trx);
      const health = await sql<Record<string, unknown>>`
        SELECT * FROM immich_fork.asset_health WHERE "assetId" = ANY(${ids}::uuid[])
        ORDER BY "assetId"::text, category
      `.execute(trx);
      const candidates = await sql<Record<string, unknown>>`
        SELECT candidate.* FROM immich_fork.asset_health_candidate candidate
        INNER JOIN immich_fork.asset_health health ON health.id = candidate."healthId"
        WHERE health."assetId" = ANY(${ids}::uuid[])
        ORDER BY candidate."healthId"::text, candidate."candidatePath"
      `.execute(trx);
      return combineVerifications(ids.length, {
        assetHealthRun: verifyRows(runs.rows),
        assetHealth: verifyRows(health.rows),
        assetHealthCandidate: verifyRows(candidates.rows),
      });
    });
  }

  private writeSchemas(phase: Awaited<ReturnType<typeof getForkSchemaPhase>>): Array<'public' | 'immich_fork'> {
    return [
      ...(writesLegacy(phase) ? (['public'] as const) : []),
      ...(writesForkSidecar(phase) ? (['immich_fork'] as const) : []),
    ];
  }
}
