import { Injectable } from '@nestjs/common';
import { Insertable, Kysely, Selectable, Updateable, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import type { HiddenContentQueryOptions } from 'src/utils/hidden-content.js';
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
import { anyUuid, asUuid, withHiddenContentFilter } from 'src/utils/database.js';

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
    privacy?: HiddenContentQueryOptions;
    status?: MediaHealthStatus;
    size: number;
  }): Promise<MediaHealthFinding[]> {
    const phase = await getForkSchemaPhase(this.db);
    const schema = readsForkSidecar(phase) ? 'immich_fork' : 'public';
    return (this.db as Kysely<any>)
      .selectFrom(`${schema}.asset_health as asset_health`)
      .innerJoin('public.asset as asset', 'asset.id', 'asset_health.assetId')
      .selectAll('asset_health')
      .$if(!!options.ownerId, (qb) => qb.where('asset.ownerId', '=', asUuid(options.ownerId!)))
      .$call((qb) => withHiddenContentFilter(qb, options.privacy))
      .$if(!!options.category, (qb) => qb.where('asset_health.category', '=', options.category!))
      .$if(!!options.status, (qb) => qb.where('asset_health.status', '=', options.status!))
      .orderBy('asset_health.checkedAt', 'desc')
      .limit(options.size)
      .execute() as Promise<MediaHealthFinding[]>;
  }

  async count(options: {
    category?: MediaHealthCategory;
    ownerId?: string;
    privacy?: HiddenContentQueryOptions;
    status?: MediaHealthStatus;
  }): Promise<number> {
    const phase = await getForkSchemaPhase(this.db);
    const schema = readsForkSidecar(phase) ? 'immich_fork' : 'public';
    const row = await (this.db as Kysely<any>)
      .selectFrom(`${schema}.asset_health as asset_health`)
      .innerJoin('public.asset as asset', 'asset.id', 'asset_health.assetId')
      .select((eb) => eb.fn.countAll<number>().as('count'))
      .$if(!!options.ownerId, (qb) => qb.where('asset.ownerId', '=', asUuid(options.ownerId!)))
      .$call((qb) => withHiddenContentFilter(qb, options.privacy))
      .$if(!!options.category, (qb) => qb.where('asset_health.category', '=', options.category!))
      .$if(!!options.status, (qb) => qb.where('asset_health.status', '=', options.status!))
      .executeTakeFirstOrThrow();
    return Number(row.count);
  }

  async getByIds(ids: string[], ownerId?: string, privacy?: HiddenContentQueryOptions): Promise<MediaHealthFinding[]> {
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
    return new Set(rows.map(({ originalPath }) => originalPath));
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

  async upsertFinding(
    finding: UpsertMediaHealthFinding & { expectedUpdateId: string },
  ): Promise<MediaHealthFinding | undefined>;
  async upsertFinding(finding: UpsertMediaHealthFinding): Promise<MediaHealthFinding>;
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
          .set({ status: MediaHealthStatus.Dismissed, dismissedAt })
          .where('id', '=', anyUuid(ids))
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

    const query = this.db
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

    for await (const asset of query.stream()) {
      yield asset;
    }
  }

  getAssets(assetIds: string[], ownerId?: string, privacy?: HiddenContentQueryOptions): Promise<MediaHealthAsset[]> {
    if (assetIds.length === 0) {
      return Promise.resolve([]);
    }

    return this.db
      .withSchema('public')
      .selectFrom('asset')
      .selectAll('asset')
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
      .$call((qb) => withHiddenContentFilter(qb, privacy))
      .execute();
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
      if (!writesForkSidecar(phase)) {
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
      if (
        !health ||
        health.assetId !== asset.id ||
        health.category !== MediaHealthCategory.Missing ||
        health.status !== MediaHealthStatus.Found ||
        health.resolvedAt ||
        health.dismissedAt ||
        health.originalPath !== asset.originalPath ||
        health.resolution?.autoRelinkable !== true
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
      const candidate = candidates[0];
      if (
        candidates.length !== 1 ||
        candidate.id !== input.candidateId ||
        path.normalize(candidate.candidatePath) !== recoveredPath ||
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
        if (!forkPhysical) {
          await sql`INSERT INTO immich_fork.physical_file (id, "canonicalAssetId", type, checksum, "sizeInBytes", "canonicalPath")
            VALUES (${forkId}::uuid, ${canonical}::uuid, 'original', ${input.sha256}, ${input.sizeInBytes}, ${recoveredPath})`.execute(
            trx,
          );
        }
        await sql`INSERT INTO immich_fork.asset_physical_file ("assetId", "physicalFileId", "upstreamPath", "verifiedAt", "updatedAt")
          VALUES (${asset.id}::uuid, ${forkId}::uuid, ${recoveredPath}, now(), now()) ON CONFLICT ("assetId") DO UPDATE SET
          "physicalFileId" = EXCLUDED."physicalFileId", "upstreamPath" = EXCLUDED."upstreamPath", "verifiedAt" = now(), "updatedAt" = now()`.execute(
          trx,
        );
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
        if (previousForkId) {
          await sql`UPDATE immich_fork.physical_file SET "canonicalAssetId" = (SELECT "assetId" FROM immich_fork.asset_physical_file WHERE "physicalFileId" = ${previousForkId}::uuid ORDER BY "assetId" LIMIT 1)
            WHERE id = ${previousForkId}::uuid AND "canonicalAssetId" = ${asset.id}::uuid`.execute(trx);
        }
      }
      await sql`INSERT INTO immich_fork.asset_checksum ("assetId", sha1, sha256, "sizeInBytes", "verifiedPaths", "linkCount", evidence, "verifiedAt", "updatedAt")
        VALUES (${asset.id}::uuid, ${input.sha1}, ${input.sha256}, ${input.sizeInBytes}, ARRAY[${recoveredPath}]::text[], 1, '{"source":"recovery"}'::jsonb, now(), now())
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
            status: MediaHealthStatus.Relinked,
            severity: MediaHealthSeverity.Info,
            originalPath: recoveredPath,
            originalFileName: input.originalFileName,
            evidence: { reason: 'candidate_relinked', previousPath: asset.originalPath },
            resolution: { healthId: input.healthId },
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
