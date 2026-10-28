import { BadRequestException, ConflictException, HttpStatus, Injectable } from '@nestjs/common';
import { Kysely, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import type { BatchReturnAdmission } from 'src/repositories/develop-batch.repository.js';
import {
  type AssetDevelopRecipe,
  AssetDevelopRevisionKind,
  AssetDevelopRevisionStatus,
} from 'src/dtos/asset-develop.dto.js';
import { publicationDatabase, publicationTransaction } from 'src/queue/transaction.js';
import { lockFilePath } from 'src/repositories/physical-file.repository.js';
import { DB } from 'src/schema/index.js';
import { assertRenderableDevelopRecipe, developEnvelope, preserveDevelopEnvelope } from 'src/utils/develop-envelope.js';
import { developRenderArtifacts } from 'src/utils/develop-recipe.js';

export type AssetDevelopRevision = {
  id: string;
  assetId: string;
  ownerId: string;
  revision: number;
  recipeVersion: number;
  recipe: AssetDevelopRecipe;
  label: string | null;
  status: AssetDevelopRevisionStatus;
  progress: number;
  cancelRequested: boolean;
  error: string | null;
  rendererVersion: string | null;
  masterPath: string | null;
  previewPath: string | null;
  hdrMasterPath?: string | null;
  hdrPreviewPath?: string | null;
  hdrRenditionChecksum?: Buffer | null;
  width: number | null;
  height: number | null;
  isCurrent: boolean;
  kind: AssetDevelopRevisionKind;
  sourceAssetId?: string | null;
  sourceChecksum: Buffer | null;
  renditionChecksum: Buffer | null;
  exportId: string | null;
  fileName: string | null;
  software: string | null;
  attempts: number;
  batchChargedBytes?: number;
  createdAt: Date;
  updatedAt: Date;
  renderedAt: Date | null;
};
export type AssetDevelopRevisionUpdate = Partial<
  Pick<
    AssetDevelopRevision,
    | 'status'
    | 'progress'
    | 'cancelRequested'
    | 'error'
    | 'rendererVersion'
    | 'masterPath'
    | 'previewPath'
    | 'hdrMasterPath'
    | 'hdrPreviewPath'
    | 'hdrRenditionChecksum'
    | 'width'
    | 'height'
    | 'renderedAt'
    | 'sourceAssetId'
    | 'sourceChecksum'
    | 'renditionChecksum'
    | 'attempts'
  >
>;
export class BatchDevelopCancelled extends Error {}
const TABLE = sql`public.asset_develop_revision`;
const ARTIFACTS = sql`public.asset_develop_artifact`;
/** FL-233: the artifact ids a recipe's masks and Clean Up name (whether or not they render). */
const referencedArtifacts = (recipe: AssetDevelopRecipe): string[] => {
  const ids = new Set<string>();
  const value = recipe as {
    masks?: unknown;
    cleanup?: unknown;
  };
  for (const [list, key] of [
    [value.masks, 'artifact'],
    [value.cleanup, 'fill'],
  ] as const) {
    for (const item of Array.isArray(list) ? list : []) {
      const id = item && typeof item === 'object' ? (item as Record<string, unknown>)[key] : undefined;
      if (typeof id === 'string' && /^[0-9a-f]{64}$/.test(id)) {
        ids.add(id);
      }
    }
  }
  return [...ids];
};
/** FL-233: a photo keeps at most this many develop artifacts. */
export const DEVELOP_ARTIFACT_PER_ASSET = 64;
/** FL-233: a stored develop artifact (fork migration 0000000000212). */
export type AssetDevelopArtifact = {
  assetId: string;
  id: string;
  ownerId: string;
  kind: 'mask' | 'fill';
  path: string;
  bytes: number;
  width: number;
  height: number;
  createdAt: Date;
};
/**
 * Storage for still-image develop revisions (FL-113). Rows are append-only history: a new
 * save always creates the next revision number, revert only moves the `isCurrent` flag, and
 * nothing here ever points at the original file.
 */
@Injectable()
export class AssetDevelopRepository {
  constructor(
    @InjectKysely()
    private db: Kysely<DB>,
  ) {
    this.db = publicationDatabase(db);
  }
  /** Includes photo, video, reset and external revisions: an unedited current copy may still have history. */
  async getAssetIdsWithHistory(assetIds: string[]): Promise<Set<string>> {
    if (assetIds.length === 0) return new Set();
    const { rows } = await sql<{ assetId: string }>`
      SELECT DISTINCT "assetId" FROM ${TABLE} WHERE "assetId" = ANY(${assetIds}::uuid[])
      UNION SELECT "assetId" FROM public.video_edit_version WHERE "assetId" = ANY(${assetIds}::uuid[])
    `.execute(this.db);
    return new Set(rows.map(({ assetId }) => assetId));
  }
  async listByAsset(assetId: string): Promise<AssetDevelopRevision[]> {
    const { rows } = await sql<AssetDevelopRevision>`
      SELECT * FROM ${TABLE} WHERE "assetId" = ${assetId}::uuid ORDER BY revision DESC
    `.execute(this.db);
    return rows;
  }
  async get(id: string): Promise<AssetDevelopRevision | undefined> {
    const { rows } = await sql<AssetDevelopRevision>`SELECT * FROM ${TABLE} WHERE id = ${id}::uuid`.execute(this.db);
    return rows[0];
  }
  async getCurrent(assetId: string): Promise<AssetDevelopRevision | undefined> {
    const { rows } = await sql<AssetDevelopRevision>`
      SELECT * FROM ${TABLE} WHERE "assetId" = ${assetId}::uuid AND "isCurrent" LIMIT 1
    `.execute(this.db);
    return rows[0];
  }
  /** Inserts the next revision for the asset; the number is assigned inside the statement. */
  async create(input: {
    assetId: string;
    ownerId: string;
    recipe: AssetDevelopRecipe;
    recipeVersion: number;
    sourceRevisionId?: string;
    /** FL-431: undefined skips the check; null expects no current revision. */
    expectedCurrentRevisionId?: string | null;
    replaceRecipe?: boolean;
    requireRenderable?: boolean;
    label: string | null;
    status: AssetDevelopRevisionStatus;
    kind?: AssetDevelopRevisionKind;
    sourceChecksum?: Buffer | null;
    renditionChecksum?: Buffer | null;
    exportId?: string | null;
    fileName?: string | null;
    software?: string | null;
    masterPath?: string | null;
    batchReturn?: BatchReturnAdmission;
  }): Promise<AssetDevelopRevision> {
    // Serialised per asset: two saves racing for the same next number would otherwise collide on
    // the (assetId, revision) unique key and one of them would fail.
    return this.db.transaction().execute(async (trx) => {
      if (input.batchReturn) {
        const b = input.batchReturn;
        const batch = await trx
          .selectFrom('develop_batch')
          .selectAll()
          .where('id', '=', b.batchId)
          .where('ownerId', '=', input.ownerId)
          .forUpdate()
          .executeTakeFirst();
        if (!batch || batch.status === 'cancelled')
          throw new ConflictException('This editing batch is unavailable or cancelled');
        const { rows } = await sql<{
          revisionId: string | null;
          pendingMasterPath: string | null;
        }>`SELECT returned."revisionId",returned."pendingMasterPath" FROM develop_batch_return returned JOIN develop_batch_item item ON item.id=returned."itemId" JOIN develop_export exported ON exported.id=item."exportId"
          WHERE item.id=${b.itemId}::uuid AND item."batchId"=${b.batchId}::uuid AND item."assetId"=${input.assetId}::uuid AND item."exportId"=${input.exportId}::uuid
          AND exported."ownerId"=${input.ownerId}::uuid AND exported."sourceChecksum"=${input.sourceChecksum}
          AND returned."confirmationId"=${b.confirmationId}::uuid AND returned.checksum=${b.checksum} AND returned.status<>'cancelled'`.execute(
          trx,
        );
        if (!rows[0]) throw new ConflictException('Review and confirm this returned file before importing');
        if (rows[0].revisionId) {
          const existing =
            await sql<AssetDevelopRevision>`SELECT * FROM ${TABLE} WHERE id=${rows[0].revisionId}::uuid`.execute(trx);
          if (!existing.rows[0]) throw new ConflictException('The previously imported version is unavailable');
          return existing.rows[0];
        }
        if (rows[0].pendingMasterPath !== input.masterPath)
          throw new ConflictException('This pending upload was cancelled; review and retry');
      }
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`asset_develop_revision:${input.assetId}`}, 0))`.execute(
        trx,
      );
      const asset = await trx
        .selectFrom('asset')
        .select(['id', 'checksum'])
        .where('id', '=', input.assetId)
        .where('ownerId', '=', input.ownerId)
        .where('deletedAt', 'is', null)
        .forShare()
        .executeTakeFirst();
      if (!asset) throw new BadRequestException('Develop source asset is no longer available');
      if (input.batchReturn?.sourceIdentity && !Buffer.from(asset.checksum).equals(input.batchReturn.sourceIdentity))
        throw new ConflictException({ message: 'The original changed during import', code: 'source_changed' });
      if (input.expectedCurrentRevisionId !== undefined) {
        // FL-431: read under the per-asset lock above, in the inserting transaction, so the
        // precondition and the new row are one decision. Saving never moves `isCurrent`, so a
        // render or revert that commits after this read is ordered after this save.
        const current = await sql<{ id: string }>`
          SELECT id FROM ${TABLE} WHERE "assetId" = ${input.assetId}::uuid AND "isCurrent" LIMIT 1
        `.execute(trx);
        const currentRevisionId = current.rows[0]?.id ?? null;
        if (currentRevisionId !== input.expectedCurrentRevisionId) {
          throw new ConflictException({
            message: 'This photo has a newer current version than the one this edit started from',
            error: 'Conflict',
            statusCode: HttpStatus.CONFLICT,
            code: 'develop_current_revision_changed',
            currentRevisionId,
          });
        }
      }
      let recipe = developEnvelope(input.recipe);
      if (input.sourceRevisionId) {
        const source =
          await sql<AssetDevelopRevision>`SELECT revision.* FROM ${TABLE} revision JOIN public.asset asset ON asset.id = revision."assetId" WHERE revision.id = ${input.sourceRevisionId}::uuid AND revision."assetId" = ${input.assetId}::uuid AND revision."ownerId" = ${input.ownerId}::uuid AND asset."ownerId" = ${input.ownerId}::uuid AND asset."deletedAt" IS NULL FOR SHARE OF revision, asset`.execute(
            trx,
          );
        if (!source.rows[0]) throw new BadRequestException('Develop source revision is not available for this asset');
        if (!input.replaceRecipe) recipe = preserveDevelopEnvelope(source.rows[0].recipe, recipe);
      }
      const projection = input.requireRenderable ? assertRenderableDevelopRecipe(recipe) : undefined;
      // FL-233: the artifacts this version names start their grace period again, under their row
      // locks, so the nightly release (which re-checks `createdAt` once these commit) never takes
      // one a version is being saved with; a render needs those its active masks and enabled
      // Clean Up read, each of the right kind
      const artifactIds = referencedArtifacts(recipe);
      const touched =
        artifactIds.length > 0
          ? await sql<{
              id: string;
              kind: string;
            }>`
              UPDATE ${ARTIFACTS} SET "createdAt" = clock_timestamp()
              WHERE "assetId" = ${input.assetId}::uuid AND id IN (${sql.join(artifactIds)})
              RETURNING id, kind
            `.execute(trx)
          : { rows: [] };
      if (projection && projection.version !== 2) {
        const needed = developRenderArtifacts(projection);
        const kinds = new Map(touched.rows.map((row) => [row.id, row.kind]));
        if (needed.mask.some((id) => kinds.get(id) !== 'mask') || needed.fill.some((id) => kinds.get(id) !== 'fill')) {
          throw new BadRequestException({
            message: 'This recipe uses a develop artifact that was not uploaded for this photo',
            code: 'develop_artifact_missing',
          });
        }
      }
      if (input.batchReturn && input.masterPath) await lockFilePath(trx, input.masterPath);
      const { rows } = await sql<AssetDevelopRevision>`
        INSERT INTO ${TABLE} (
          "assetId", "ownerId", revision, "recipeVersion", recipe, label, status,
          kind, "sourceChecksum", "renditionChecksum", "exportId", "fileName", software, "masterPath"
        )
        VALUES (
          ${input.assetId}::uuid,
          ${input.ownerId}::uuid,
          (SELECT COALESCE(MAX(revision), 0) + 1 FROM ${TABLE} WHERE "assetId" = ${input.assetId}::uuid),
          ${recipe.version},
          ${JSON.stringify(recipe)}::text::jsonb,
          ${input.label},
          ${input.status},
          ${input.kind ?? AssetDevelopRevisionKind.Recipe},
          ${input.sourceChecksum ?? null},
          ${input.renditionChecksum ?? null},
          ${input.exportId ?? null}::uuid,
          ${input.fileName ?? null},
          ${input.software ?? null},
          ${input.masterPath ?? null}
        )
        RETURNING *
      `.execute(trx);
      if (input.batchReturn) {
        const b = input.batchReturn;
        const charged = await trx
          .updateTable('user')
          .set({ quotaUsageInBytes: sql`"quotaUsageInBytes" + ${b.bytes}` })
          .where('id', '=', input.ownerId)
          .where(sql<boolean>`"quotaSizeInBytes" IS NULL OR "quotaUsageInBytes" + ${b.bytes} <= "quotaSizeInBytes"`)
          .returning('id')
          .executeTakeFirst();
        if (!charged) throw new BadRequestException({ message: 'Your storage is full', code: 'develop_batch_quota' });
        await sql`UPDATE ${TABLE} SET "batchChargedBytes"=${b.bytes} WHERE id=${rows[0].id}::uuid`.execute(trx);
        await sql`UPDATE develop_batch_return SET "revisionId"=${rows[0].id}::uuid,"sourceIdentity"=${b.sourceIdentity ?? null},"pendingMasterPath"=NULL,"stagedAt"=NULL,status='imported',error=NULL,"errorCode"=NULL WHERE "itemId"=${b.itemId}::uuid AND checksum=${b.checksum}`.execute(
          trx,
        );
      }
      return rows[0];
    });
  }
  /** Revisions whose render the queue may have lost (a restart, a flushed queue): queued or rendering. */
  async listUnfinished(): Promise<Pick<AssetDevelopRevision, 'id' | 'status' | 'updatedAt' | 'recipe' | 'kind'>[]> {
    const { rows } = await sql<Pick<AssetDevelopRevision, 'id' | 'status' | 'updatedAt' | 'recipe' | 'kind'>>`
      SELECT id, status, "updatedAt", recipe, kind FROM ${TABLE}
      WHERE status IN (${AssetDevelopRevisionStatus.Queued}, ${AssetDevelopRevisionStatus.Rendering})
      ORDER BY "updatedAt"
    `.execute(this.db);
    return rows;
  }
  /**
   * Records the start of a render attempt and returns the attempt number, or undefined when the
   * revision is gone, finished, cancelled meanwhile, or held by a render whose lease has not
   * lapsed. One guarded statement, so two deliveries of the same job can never both claim it.
   */
  async beginAttempt(
    id: string,
    rendererVersion: string,
    leaseSeconds: number,
  ): Promise<AssetDevelopRevision | undefined> {
    const { rows } = await sql<AssetDevelopRevision>`
      UPDATE ${TABLE}
      SET status = ${AssetDevelopRevisionStatus.Rendering}, progress = 5, error = NULL,
          attempts = attempts + 1, "rendererVersion" = ${rendererVersion}, "updatedAt" = now()
      WHERE id = ${id}::uuid
        AND NOT "cancelRequested"
        AND (
          status = ${AssetDevelopRevisionStatus.Queued}
          OR (
            status = ${AssetDevelopRevisionStatus.Rendering}
            AND "updatedAt" < now() - make_interval(secs => ${leaseSeconds})
          )
        )
      RETURNING *
    `.execute(this.db);
    return rows[0];
  }
  async update(id: string, patch: AssetDevelopRevisionUpdate): Promise<AssetDevelopRevision | undefined> {
    const entries = Object.entries(patch).filter(([, value]) => value !== undefined);
    if (entries.length === 0) {
      return this.get(id);
    }
    const assignments = entries.map(([key, value]) => sql`${sql.ref(key)} = ${value}`);
    const { rows } = await sql<AssetDevelopRevision>`
      UPDATE ${TABLE}
      SET ${sql.join(assignments, sql`, `)}, "updatedAt" = now()
      WHERE id = ${id}::uuid
      RETURNING *
    `.execute(this.db);
    return rows[0];
  }
  /**
   * Moves the asset's current flag to the given revision, or clears it entirely for the
   * original. One statement pair inside a transaction so the partial unique index never
   * sees two current rows.
   */
  async setCurrent(assetId: string, revisionId: string | null): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`asset_develop_revision:${assetId}`},0))`.execute(trx);
      const current = await sql<{
        id: string;
      }>`SELECT id FROM ${TABLE} WHERE "assetId"=${assetId}::uuid AND "isCurrent"`.execute(trx);
      if ((current.rows[0]?.id ?? null) !== revisionId) await this.invalidateBatchConfirmations(trx, assetId);
      await sql`
        UPDATE ${TABLE} SET "isCurrent" = false, "updatedAt" = now()
        WHERE "assetId" = ${assetId}::uuid AND "isCurrent"
      `.execute(trx);
      if (revisionId) {
        await sql`
          UPDATE ${TABLE} SET "isCurrent" = true, "updatedAt" = now()
          WHERE id = ${revisionId}::uuid AND "assetId" = ${assetId}::uuid
        `.execute(trx);
      }
    });
  }
  private async invalidateBatchConfirmations(tx: Kysely<DB>, assetId: string, except?: string) {
    await sql`UPDATE develop_batch_return r SET "activationInvalidated"=true FROM develop_batch_item item WHERE item.id=r."itemId" AND item."assetId"=${assetId}::uuid AND r.status IN ('confirmed','imported','failed') ${except ? sql`AND r.id<>${except}::uuid` : sql``}`.execute(
      tx,
    );
  }
  /** A moved master remains discoverable even if the process dies before inserting its version. */
  async reserveBatchMaster(ownerId: string, admission: BatchReturnAdmission, candidate: string): Promise<string> {
    return this.db.transaction().execute(async (tx) => {
      const batch = await tx
        .selectFrom('develop_batch')
        .select('status')
        .where('id', '=', admission.batchId)
        .where('ownerId', '=', ownerId)
        .forUpdate()
        .executeTakeFirst();
      if (!batch || batch.status === 'cancelled')
        throw new ConflictException({ message: 'This batch was cancelled', code: 'batch_cancelled' });
      const returned = await tx
        .selectFrom('develop_batch_return as returned')
        .innerJoin('develop_batch_item as item', 'item.id', 'returned.itemId')
        .select(['returned.id', 'returned.revisionId', 'returned.pendingMasterPath'])
        .where('item.batchId', '=', admission.batchId)
        .where('item.id', '=', admission.itemId)
        .where('returned.confirmationId', '=', admission.confirmationId)
        .where('returned.checksum', '=', admission.checksum)
        .forUpdate('returned')
        .executeTakeFirst();
      if (!returned) throw new ConflictException('Review this returned file before importing');
      if (returned.revisionId) {
        const revision = await sql<{
          masterPath: string | null;
        }>`SELECT "masterPath" FROM ${TABLE} WHERE id=${returned.revisionId}::uuid`.execute(tx);
        if (!revision.rows[0]?.masterPath)
          throw new ConflictException({ message: 'The stored master is no longer available', code: 'source_changed' });
        return revision.rows[0].masterPath;
      }
      const target = returned.pendingMasterPath ?? candidate;
      await lockFilePath(tx, target);
      await tx
        .updateTable('develop_batch_return')
        .set({ pendingMasterPath: target, stagedAt: new Date() })
        .where('id', '=', returned.id)
        .execute();
      return target;
    });
  }
  async abandonBatchMaster(ownerId: string, admission: BatchReturnAdmission): Promise<string | undefined> {
    return this.db.transaction().execute(async (tx) => {
      await tx
        .selectFrom('develop_batch')
        .select('id')
        .where('id', '=', admission.batchId)
        .where('ownerId', '=', ownerId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      const { rows } = await sql<{
        pendingMasterPath: string | null;
      }>`WITH pending AS (SELECT r.id,r."pendingMasterPath" FROM develop_batch_return r JOIN develop_batch_item item ON item.id=r."itemId" WHERE item.id=${admission.itemId}::uuid AND item."batchId"=${admission.batchId}::uuid AND r.checksum=${admission.checksum} AND r."confirmationId"=${admission.confirmationId}::uuid AND r."revisionId" IS NULL FOR UPDATE OF r) UPDATE develop_batch_return r SET "pendingMasterPath"=NULL,"stagedAt"=NULL FROM pending WHERE r.id=pending.id RETURNING pending."pendingMasterPath"`.execute(
        tx,
      );
      return rows[0]?.pendingMasterPath ?? undefined;
    });
  }
  async failBatchRender(id: string, code: string) {
    await sql`UPDATE develop_batch_return SET "errorCode"=${code},error=CASE WHEN ${code}='source_changed' THEN 'The original or returned master changed' ELSE 'Preview rendering failed' END WHERE "revisionId"=${id}::uuid AND status NOT IN ('completed','conflict','cancelled')`.execute(
      this.db,
    );
  }
  async recoverBatchImports() {
    const { rows } = await sql<{
      id: string;
    }>`UPDATE ${TABLE} revision SET status='queued' FROM develop_batch_return r JOIN develop_batch_item item ON item.id=r."itemId" JOIN develop_batch batch ON batch.id=item."batchId" WHERE r."revisionId"=revision.id AND revision.status='saved' AND NOT revision."cancelRequested" AND batch.status='open' RETURNING revision.id`.execute(
      this.db,
    );
    return rows;
  }
  async queueBatchRevision(id: string) {
    const { rows } = await sql<{
      id: string;
    }>`UPDATE ${TABLE} SET status='queued' WHERE id=${id}::uuid AND status='saved' RETURNING id`.execute(this.db);
    return rows.length > 0;
  }
  async releaseBatchMaster(id: string): Promise<string | undefined> {
    return this.db.transaction().execute(async (tx) => {
      const { rows } = await sql<{
        ownerId: string;
        batchChargedBytes: number;
        masterPath: string | null;
      }>`SELECT "ownerId","batchChargedBytes","masterPath" FROM ${TABLE} WHERE id=${id}::uuid FOR UPDATE`.execute(tx);
      const revision = rows[0];
      if (!revision || !revision.masterPath || Number(revision.batchChargedBytes) === 0) return;
      await tx
        .updateTable('user')
        .set({ quotaUsageInBytes: sql`GREATEST("quotaUsageInBytes"-${revision.batchChargedBytes},0)` })
        .where('id', '=', revision.ownerId)
        .execute();
      await sql`UPDATE ${TABLE} SET "batchChargedBytes"=0,"masterPath"=NULL WHERE id=${id}::uuid`.execute(tx);
      return revision.masterPath;
    });
  }
  /** Batch previews publish under the same locks as confirmation/import/cancellation and current-version changes. */
  async publishBatchRendered(revision: AssetDevelopRevision, patch: AssetDevelopRevisionUpdate): Promise<boolean> {
    return this.db.transaction().execute(async (tx) =>
      publicationTransaction.run(tx, async () => {
        const found = await sql<{
          batchId: string;
          returnId: string;
        }>`SELECT item."batchId",r.id AS "returnId" FROM develop_batch_return r JOIN develop_batch_item item ON item.id=r."itemId" WHERE r."revisionId"=${revision.id}::uuid`.execute(
          tx,
        );
        const batchReturn = found.rows[0];
        if (!batchReturn) return false;
        const batch = await tx
          .selectFrom('develop_batch')
          .selectAll()
          .where('id', '=', batchReturn.batchId)
          .forUpdate()
          .executeTakeFirstOrThrow();
        await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`asset_develop_revision:${revision.assetId}`},0))`.execute(
          tx,
        );
        const returned = await tx
          .selectFrom('develop_batch_return')
          .selectAll()
          .where('id', '=', batchReturn.returnId)
          .forUpdate()
          .executeTakeFirstOrThrow();
        if (batch.status === 'cancelled' || returned.status === 'cancelled')
          throw new BatchDevelopCancelled('Batch cancelled');
        const asset = await tx
          .selectFrom('asset')
          .select(['id', 'ownerId', 'deletedAt', 'isOffline', 'visibility', 'checksum'])
          .where('id', '=', revision.assetId)
          .forShare()
          .executeTakeFirst();
        const locked = await tx
          .selectFrom('asset_lock')
          .select('assetId')
          .where('assetId', '=', revision.assetId)
          .executeTakeFirst();
        const grant =
          returned.locked && returned.sessionId
            ? await tx
                .selectFrom('session')
                .select('id')
                .where('id', '=', returned.sessionId)
                .where('userId', '=', revision.ownerId)
                .where('pinExpiresAt', '>', sql<Date>`clock_timestamp()`)
                .where((eb) => eb.or([eb('expiresAt', 'is', null), eb('expiresAt', '>', sql<Date>`clock_timestamp()`)]))
                .executeTakeFirst()
            : undefined;
        const current = await sql<{
          id: string;
        }>`SELECT id FROM ${TABLE} WHERE "assetId"=${revision.assetId}::uuid AND "isCurrent"`.execute(tx);
        const error =
          batch.status === 'cancelled' || returned.status === 'cancelled'
            ? 'Batch cancelled'
            : !asset ||
                asset.ownerId !== revision.ownerId ||
                !returned.sourceIdentity ||
                !Buffer.from(asset.checksum).equals(returned.sourceIdentity) ||
                asset.deletedAt ||
                asset.isOffline ||
                asset.visibility === 'hidden' ||
                !!locked !== returned.locked ||
                (returned.locked && !grant)
              ? 'The original is no longer available for this confirmed edit'
              : returned.activationInvalidated || (current.rows[0]?.id ?? null) !== returned.expectedCurrentRevisionId
                ? 'A newer working version was selected after confirmation; this returned version was kept inactive'
                : null;
        await this.update(revision.id, patch);
        if (!error) {
          if ((current.rows[0]?.id ?? null) !== revision.id)
            await this.invalidateBatchConfirmations(tx, revision.assetId, returned.id);
          await sql`UPDATE ${TABLE} SET "isCurrent"=false,"updatedAt"=now() WHERE "assetId"=${revision.assetId}::uuid AND "isCurrent"`.execute(
            tx,
          );
          await sql`UPDATE ${TABLE} SET "isCurrent"=true,"updatedAt"=now() WHERE id=${revision.id}::uuid`.execute(tx);
        }
        await tx
          .updateTable('develop_batch_return')
          .set({
            status: error ? 'conflict' : 'completed',
            error,
            errorCode: error
              ? batch.status === 'cancelled' || returned.status === 'cancelled'
                ? 'batch_cancelled'
                : !asset ||
                    asset.ownerId !== revision.ownerId ||
                    !returned.sourceIdentity ||
                    !Buffer.from(asset.checksum).equals(returned.sourceIdentity) ||
                    asset.deletedAt ||
                    asset.isOffline ||
                    asset.visibility === 'hidden' ||
                    !!locked !== returned.locked ||
                    (returned.locked && !grant)
                  ? 'source_unavailable'
                  : 'current_revision_changed'
              : null,
          })
          .where('id', '=', returned.id)
          .execute();
        return true;
      }),
    );
  }
  /** Marks a revision as wanting to stop; the renderer checks the flag between stages. */
  async requestCancel(id: string): Promise<void> {
    await sql`UPDATE ${TABLE} SET "cancelRequested" = true, "updatedAt" = now() WHERE id = ${id}::uuid`.execute(
      this.db,
    );
  }
  async isCancelRequested(id: string): Promise<boolean> {
    const { rows } = await sql<{
      cancelRequested: boolean;
    }>`
      SELECT "cancelRequested" FROM ${TABLE} WHERE id = ${id}::uuid
    `.execute(this.db);
    return rows[0]?.cancelRequested;
  }
  /** Every rendered file path for an asset, used when the asset itself is deleted. */
  /**
   * Deletes the revisions of assets that no longer exist (of `assetId` only, when given) and queues
   * the deletion of their rendered files in the same transaction, holding those files' path locks
   * (FL-169): a failure to queue keeps the rows for the next attempt, and FileDelete cannot act before
   * the rows are gone. The revisions have no foreign key to the asset. FL-179: nothing is deleted while
   * fork writes are refused (a disabled phase, or a handoff or return reconciliation running), as the
   * asset's removal does; the nightly sweep releases those revisions later. Returns the released files.
   */
  async releaseRemovedAssetRevisions(queue: (files: string[]) => Promise<void>, assetId?: string): Promise<string[]> {
    return this.db.transaction().execute(async (tx) => {
      const { rows } = await sql<{
        ownerId: string;
        batchChargedBytes: number;
        masterPath: string | null;
        previewPath: string | null;
        hdrMasterPath: string | null;
        hdrPreviewPath: string | null;
      }>`
        DELETE FROM ${TABLE} revision
        WHERE NOT EXISTS (SELECT 1 FROM public.asset asset WHERE asset.id = revision."assetId")
        ${assetId ? sql`AND revision."assetId" = ${assetId}::uuid` : sql``}
        RETURNING revision."masterPath", revision."previewPath", revision."hdrMasterPath", revision."hdrPreviewPath",revision."ownerId",revision."batchChargedBytes"
      `.execute(tx);
      for (const row of rows)
        if (Number(row.batchChargedBytes) > 0)
          await tx
            .updateTable('user')
            .set({ quotaUsageInBytes: sql`GREATEST("quotaUsageInBytes"-${row.batchChargedBytes},0)` })
            .where('id', '=', row.ownerId)
            .execute();
      const files = [
        ...new Set(
          rows
            .flatMap((row) => [row.masterPath, row.previewPath, row.hdrMasterPath, row.hdrPreviewPath])
            .filter((path): path is string => !!path),
        ),
      ];
      if (files.length > 0) {
        for (const path of files.toSorted()) {
          await lockFilePath(tx, path);
        }
        await queue(files);
      }
      return files;
    });
  }
  // ------------------------------------------------------------------ develop artifacts (FL-233)
  /** The stored artifacts of an asset among `ids`. */
  async getArtifacts(assetId: string, ids: string[]): Promise<AssetDevelopArtifact[]> {
    if (ids.length === 0) {
      return [];
    }
    const { rows } = await sql<AssetDevelopArtifact>`
      SELECT * FROM ${ARTIFACTS} WHERE "assetId" = ${assetId}::uuid AND id IN (${sql.join(ids)})
    `.execute(this.db);
    return rows.map((row) => ({ ...row, bytes: Number(row.bytes) }));
  }
  /**
   * Record a stored artifact. `true` when it is new; `false` when the asset already had it (the
   * same bitmap uploaded again, which restarts its grace period). Refused while fork writes are.
   *
   * FL-304: a new artifact is counted against the photo's limit and charged to its owner's storage
   * usage in the transaction that inserts it. Uploads for one photo wait for each other, and the
   * owner's usage only rises while it stays within the quota, so uploads sent at the same time can
   * pass neither; a refused one leaves no row.
   */
  async addArtifact(artifact: Omit<AssetDevelopArtifact, 'createdAt'>): Promise<boolean> {
    return this.db.transaction().execute(async (trx) => {
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`asset_develop_artifact:${artifact.assetId}`}, 0))`.execute(
        trx,
      );
      const { rows } = await sql<{
        inserted: boolean;
      }>`
        INSERT INTO ${ARTIFACTS} ("assetId", id, "ownerId", kind, path, bytes, width, height)
        VALUES (
          ${artifact.assetId}::uuid, ${artifact.id}, ${artifact.ownerId}::uuid, ${artifact.kind}, ${artifact.path},
          ${artifact.bytes}, ${artifact.width}, ${artifact.height}
        )
        ON CONFLICT ("assetId", id) DO UPDATE SET "createdAt" = clock_timestamp()
        RETURNING (xmax = 0) AS inserted
      `.execute(trx);
      if (!rows[0]?.inserted) {
        return false;
      }
      const count = await sql<{
        count: string;
      }>`
        SELECT count(*) AS count FROM ${ARTIFACTS} WHERE "assetId" = ${artifact.assetId}::uuid
      `.execute(trx);
      if (Number(count.rows[0].count) > DEVELOP_ARTIFACT_PER_ASSET) {
        throw new BadRequestException({
          message: `This photo has as many edit masks and fills as it may keep (${DEVELOP_ARTIFACT_PER_ASSET}); ones no saved version uses are released a week after their last use`,
          code: 'develop_artifact_limit',
        });
      }
      // the artifact row first, the owner's row second: the order `releaseArtifacts` takes them in
      const charged = await trx
        .updateTable('user')
        .set({ quotaUsageInBytes: sql`"quotaUsageInBytes" + ${artifact.bytes}` })
        .where('id', '=', artifact.ownerId)
        .where(
          sql<boolean>`("quotaSizeInBytes" IS NULL OR "quotaUsageInBytes" + ${artifact.bytes} <= "quotaSizeInBytes")`,
        )
        .returning('id')
        .executeTakeFirst();
      if (!charged) {
        throw new BadRequestException({ message: 'Your storage is full', code: 'develop_artifact_quota' });
      }
      return true;
    });
  }
  /**
   * Release artifacts and queue their files' deletion in the same transaction, holding the files'
   * path locks: those of removed assets (or of `assetId` once it is removed), and those no saved
   * version of their asset references any more after `unreferencedBefore`. Nothing is released while
   * fork writes are refused. FL-304: their bytes leave their owners' storage usage in that
   * transaction too. Returns the released files.
   */
  async releaseArtifacts(
    queue: (files: string[]) => Promise<void>,
    options: {
      assetId?: string;
      unreferencedBefore?: Date;
    },
  ): Promise<string[]> {
    return this.db.transaction().execute(async (tx) => {
      const { rows } = await sql<{
        path: string;
        ownerId: string;
        bytes: string;
      }>`
        DELETE FROM ${ARTIFACTS} artifact
        WHERE (
          NOT EXISTS (SELECT 1 FROM public.asset asset WHERE asset.id = artifact."assetId")
          ${
            options.unreferencedBefore
              ? sql`OR (
                  artifact."createdAt" < ${options.unreferencedBefore}
                  AND NOT EXISTS (
                    SELECT 1 FROM ${TABLE} revision
                    WHERE revision."assetId" = artifact."assetId" AND strpos(revision.recipe::text, artifact.id) > 0
                  )
                )`
              : sql``
          }
        )
        ${options.assetId ? sql`AND artifact."assetId" = ${options.assetId}::uuid` : sql``}
        RETURNING artifact.path, artifact."ownerId", artifact.bytes
      `.execute(tx);
      const released = new Map<string, number>();
      for (const { ownerId, bytes } of rows) {
        released.set(ownerId, (released.get(ownerId) ?? 0) + Number(bytes));
      }
      // one owner at a time in a fixed order; never below zero, as an artifact stored before FL-304
      // was not charged until the nightly usage sync counted it
      for (const [ownerId, bytes] of [...released].toSorted(([a], [b]) => a.localeCompare(b))) {
        await tx
          .updateTable('user')
          .set({ quotaUsageInBytes: sql`GREATEST("quotaUsageInBytes" - ${bytes}, 0)` })
          .where('id', '=', ownerId)
          .execute();
      }
      const files = [...new Set(rows.map(({ path }) => path))];
      if (files.length > 0) {
        for (const path of files.toSorted()) {
          await lockFilePath(tx, path);
        }
        await queue(files);
      }
      return files;
    });
  }
  /**
   * FL-304: recount storage usage (of user `id`, or of every live user) as `UserRepository.syncUsage`
   * does, plus the develop artifacts each owner keeps, in one statement, so an upload committing
   * meanwhile is never counted twice. `false`, having changed nothing, while the fork schema cannot
   * be used (not installed, or a handoff holds it): the caller then recounts the photos alone.
   */
  async syncUsage(id?: string): Promise<boolean> {
    return this.db.transaction().execute(async (tx) => {
      await tx
        .selectFrom('user')
        .select('id')
        .where('deletedAt', 'is', null)
        .$if(id !== undefined, (q) => q.where('id', '=', id!))
        .orderBy('id')
        .forUpdate()
        .execute();
      await sql`
        UPDATE public."user" AS "user"
        SET
          "quotaUsageInBytes" = (
            SELECT COALESCE(sum(exif."fileSizeInByte"), 0)
            FROM public.asset asset
            LEFT JOIN public.asset_exif exif ON exif."assetId" = asset.id
            WHERE asset."libraryId" IS NULL AND asset."ownerId" = "user".id
          ) + (
            SELECT COALESCE(sum(artifact.bytes), 0) FROM ${ARTIFACTS} artifact WHERE artifact."ownerId" = "user".id
          ) + (
            SELECT COALESCE(sum(revision."batchChargedBytes"),0) FROM ${TABLE} revision WHERE revision."ownerId"="user".id
          ),
          "updatedAt" = now()
        WHERE "user"."deletedAt" IS NULL
        ${id ? sql`AND "user".id = ${id}::uuid` : sql``}
      `.execute(tx);
      return true;
    });
  }
}
