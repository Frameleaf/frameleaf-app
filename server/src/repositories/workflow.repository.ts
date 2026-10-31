import { ConflictException, Injectable } from '@nestjs/common';
import { Insertable, Kysely, Updateable, sql } from 'kysely';
import { jsonArrayFrom, jsonObjectFrom } from 'kysely/helpers/postgres';
import { InjectKysely } from 'nestjs-kysely';
import type { WorkflowBatchResponseDto } from 'src/dtos/workflow.dto.js';
import type { WorkflowDefinitionDocument } from 'src/schema/tables/workflow-definition.table.js';
import { columns } from 'src/database.js';
import { DummyValue, GenerateSql } from 'src/decorators.js';
import { WorkflowGetLogsDto, WorkflowSearchDto } from 'src/dtos/workflow.dto.js';
import { AssetMetadataKey, AssetVisibility, WorkflowRunErrorCode } from 'src/enum.js';
import { DB } from 'src/schema/index.js';
import { WorkflowLogTable } from 'src/schema/tables/workflow-log.table.js';
import { WorkflowStepTable } from 'src/schema/tables/workflow-step.table.js';
import { WorkflowTable } from 'src/schema/tables/workflow.table.js';
import { anyUuid, nsfwAssetIdExists, searchAssetBuilder, withTags } from 'src/utils/database.js';
import { effectiveVisibility } from 'src/utils/locked.js';
import { type WorkflowSource, workflowDefinitionHash } from 'src/utils/workflow-source.js';

export type WorkflowBatch = Omit<WorkflowBatchResponseDto, 'createdAt' | 'updatedAt' | 'finishedAt' | 'snapshotAt'> & {
  ownerId: string;
  definition: WorkflowDefinitionDocument;
  source: WorkflowSource;
  embedding: string | null;
  embeddingKey: string | null;
  definitionSha256: string;
  createdAt: Date;
  updatedAt: Date;
  finishedAt: Date | null;
  snapshotAt: Date;
};

/** A runnable step, stored under its definition step id at its definition position. */
export type WorkflowStepUpsert = Omit<Insertable<WorkflowStepTable>, 'workflowId'> & { id: string; order: number };

export type WorkflowRunLog = Insertable<WorkflowLogTable> & {
  attempt: number;
  errorCode?: WorkflowRunErrorCode | null;
  error?: string | null;
};

@Injectable()
export class WorkflowRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {}

  /** Serialize scheduler passes on a reserved connection; process death releases ownership. */
  async withRuntimeLock(run: (assertOwned: () => Promise<void>) => Promise<void>): Promise<void> {
    await this.db.connection().execute(async (connection) => {
      const {
        rows: [row],
      } = await sql<{
        locked: boolean;
      }>`SELECT pg_try_advisory_lock(17819,1) AS locked`.execute(connection);
      if (!row?.locked) return;
      try {
        await run(async () => {
          const {
            rows: [held],
          } = await sql<{
            held: boolean;
          }>`SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND pid=pg_backend_pid() AND classid=17819 AND objid=1 AND objsubid=2 AND granted) AS held`.execute(
            connection,
          );
          if (!held?.held) throw new Error('Workflow scheduler lost ownership');
        });
      } finally {
        await sql`SELECT pg_advisory_unlock(17819,1)`.execute(connection);
      }
    });
  }

  private sourceQuery(
    ownerId: string,
    source: WorkflowSource,
    embedding?: string | null,
    db = this.db,
    requireEnrichment = false,
  ) {
    const options = {
      filter: source.filter,
      imageEnrichment: source.imageEnrichment,
      excludeNsfw: true,
      othersRulesViewerId: null,
      withStacked: true,
    };
    let query = searchAssetBuilder(db, options, {
      userIds: [ownerId],
      lockedOwnerId: ownerId,
      viewingUserId: ownerId,
      lockedMotion: {},
    })
      .where('asset.ownerId', '=', ownerId)
      .where('asset.deletedAt', 'is', null)
      .where(effectiveVisibility('asset'), 'not in', [AssetVisibility.Hidden, AssetVisibility.Locked]);
    if (requireEnrichment)
      query = query.where(
        sql<boolean>`EXISTS(SELECT 1 FROM asset_metadata WHERE "assetId"=asset.id AND key=${AssetMetadataKey.MlEnrichment})`,
      );
    if (source.semantic) {
      if (!embedding) throw new Error('Semantic workflow source requires an embedding');
      query = query.where(
        sql<boolean>`EXISTS(SELECT 1 FROM smart_search WHERE "assetId"=asset.id AND (embedding <=> ${embedding}) <= ${source.semantic.maxDistance})`,
      );
    }
    return query;
  }

  async previewSource(ownerId: string, source: WorkflowSource, embedding?: string | null, requireEnrichment = false) {
    const query = this.sourceQuery(ownerId, source, embedding, this.db, requireEnrichment);
    const [count, examples] = await Promise.all([
      query.select(sql<number>`count(*)::integer`.as('count')).executeTakeFirstOrThrow(),
      query.select('asset.id').orderBy('asset.id').limit(12).execute(),
    ]);
    return { count: count.count, exampleAssetIds: examples.map(({ id }) => id) };
  }
  async getAssetIdForFace(id: string) {
    return (await this.db.selectFrom('asset_face').select('assetId').where('id', '=', id).executeTakeFirst())?.assetId;
  }

  async matchesSource(
    ownerId: string,
    assetId: string,
    source: WorkflowSource,
    embedding?: string | null,
  ): Promise<boolean> {
    return !!(await this.sourceQuery(ownerId, source, embedding)
      .select('asset.id')
      .where('asset.id', '=', assetId)
      .executeTakeFirst());
  }

  async createBatch(input: {
    workflowId: string;
    ownerId: string;
    definition: WorkflowDefinitionDocument;
    source: WorkflowSource;
    embedding?: string | null;
    embeddingKey?: string;
    definitionSha256: string;
    reason: 'manual' | 'schedule';
    snapshotAt: Date;
    requireEnrichment?: boolean;
  }) {
    return this.db.transaction().execute(async (tx) => {
      const current = await tx
        .selectFrom('workflow')
        .select(['id', 'ownerId', 'enabled'])
        .where('id', '=', input.workflowId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      const stored = await tx
        .selectFrom('workflow_definition')
        .select('definition')
        .where('workflowId', '=', input.workflowId)
        .executeTakeFirst();
      if (
        !current.enabled ||
        current.ownerId !== input.ownerId ||
        (stored && workflowDefinitionHash(stored.definition) !== input.definitionSha256)
      )
        throw new ConflictException('Workflow changed before the batch snapshot');
      const existing =
        await sql<WorkflowBatch>`SELECT * FROM workflow_batch WHERE "workflowId"=${input.workflowId}::uuid AND status IN ('pending','running')`.execute(
          tx,
        );
      if (existing.rows[0]) return existing.rows[0];
      const {
        rows: [batch],
      } =
        await sql<WorkflowBatch>`INSERT INTO workflow_batch("workflowId","ownerId",definition,source,embedding,"embeddingKey","definitionSha256",reason,"snapshotAt")
        VALUES(${input.workflowId}::uuid,${input.ownerId}::uuid,${input.definition}::jsonb,${input.source}::jsonb,${input.embedding ?? null},${input.embeddingKey ?? null},${input.definitionSha256},${input.reason},${input.snapshotAt}) RETURNING *`.execute(
          tx,
        );
      const matches = this.sourceQuery(
        input.ownerId,
        input.source,
        input.embedding,
        tx,
        input.requireEnrichment,
      ).select('asset.id');
      await sql`INSERT INTO workflow_batch_item("batchId","assetId") SELECT ${batch!.id}::uuid, id FROM (${matches}) AS matched ON CONFLICT DO NOTHING`.execute(
        tx,
      );
      const {
        rows: [result],
      } =
        await sql<WorkflowBatch>`UPDATE workflow_batch SET total=(SELECT count(*) FROM workflow_batch_item WHERE "batchId"=${batch!.id}::uuid) WHERE id=${batch!.id}::uuid RETURNING *`.execute(
          tx,
        );
      return result!;
    });
  }
  async getBatches(workflowId: string, batchId?: string) {
    const { rows } =
      await sql<WorkflowBatch>`SELECT * FROM workflow_batch WHERE "workflowId"=${workflowId}::uuid ${batchId ? sql`AND id=${batchId}::uuid` : sql``} ORDER BY "createdAt" DESC LIMIT 50`.execute(
        this.db,
      );
    return rows;
  }
  async cancelBatches(workflowId: string, batchId?: string) {
    await sql`UPDATE workflow_batch SET status='cancelled',"updatedAt"=now(),"finishedAt"=now() WHERE "workflowId"=${workflowId}::uuid AND status IN ('pending','running') ${batchId ? sql`AND id=${batchId}::uuid` : sql``}`.execute(
      this.db,
    );
  }
  async pendingBatches() {
    return (
      await sql<WorkflowBatch>`SELECT * FROM workflow_batch WHERE status IN ('pending','running') ORDER BY "createdAt"`.execute(
        this.db,
      )
    ).rows;
  }
  async nextBatchItem(batchId: string) {
    const { rows } = await sql<{
      id: string;
      assetId: string;
      attempt: number;
      fromStepId: string | null;
    }>`SELECT i.id,i."assetId",i.attempt,i."fromStepId" FROM workflow_batch_item i JOIN workflow_batch b ON b.id=i."batchId" WHERE b.id=${batchId}::uuid AND b.status IN ('pending','running') AND i.status='pending' ORDER BY i.id LIMIT 1`.execute(
      this.db,
    );
    return rows[0];
  }
  async retryBatchItem(batchId: string, itemId: string, fromStepId: string) {
    await sql`UPDATE workflow_batch_item SET attempt=1,"fromStepId"=${fromStepId}::uuid WHERE "batchId"=${batchId}::uuid AND id=${itemId}::uuid AND attempt=0`.execute(
      this.db,
    );
  }
  async isBatchActive(batchId: string) {
    return (
      (
        await sql`SELECT 1 FROM workflow_batch WHERE id=${batchId}::uuid AND status IN ('pending','running')`.execute(
          this.db,
        )
      ).rows.length > 0
    );
  }
  async finishBatchItem(batchId: string, itemId: string, status: 'completed' | 'skipped' | 'failed') {
    await this.db.transaction().execute(async (tx) => {
      await sql`UPDATE workflow_batch_item SET status=${status} WHERE id=${itemId}::uuid AND "batchId"=${batchId}::uuid`.execute(
        tx,
      );
      await sql`UPDATE workflow_batch SET status=CASE WHEN status='pending' THEN 'running' ELSE status END,"updatedAt"=now(),
        completed=(SELECT count(*) FROM workflow_batch_item WHERE "batchId"=${batchId}::uuid AND status='completed'),
        skipped=(SELECT count(*) FROM workflow_batch_item WHERE "batchId"=${batchId}::uuid AND status='skipped'),
        failed=(SELECT count(*) FROM workflow_batch_item WHERE "batchId"=${batchId}::uuid AND status='failed') WHERE id=${batchId}::uuid`.execute(
        tx,
      );
    });
  }
  async finishBatch(batchId: string) {
    await sql`UPDATE workflow_batch SET status=CASE WHEN failed>0 THEN 'failed' ELSE 'completed' END,"updatedAt"=now(),"finishedAt"=now() WHERE id=${batchId}::uuid AND status IN ('pending','running') AND NOT EXISTS(SELECT 1 FROM workflow_batch_item WHERE "batchId"=${batchId}::uuid AND status='pending')`.execute(
      this.db,
    );
  }
  async syncSchedule(workflowId: string, hash: string, nextAt: Date) {
    await sql`INSERT INTO workflow_schedule("workflowId","definitionSha256","nextAt") VALUES(${workflowId}::uuid,${hash},${nextAt}) ON CONFLICT("workflowId") DO UPDATE SET "definitionSha256"=excluded."definitionSha256","nextAt"=excluded."nextAt" WHERE workflow_schedule."definitionSha256"<>excluded."definitionSha256"`.execute(
      this.db,
    );
  }
  async getSchedule(workflowId: string) {
    return (
      await sql<{
        nextAt: Date;
        lastAt: Date | null;
      }>`SELECT "nextAt","lastAt" FROM workflow_schedule WHERE "workflowId"=${workflowId}::uuid`.execute(this.db)
    ).rows[0];
  }
  async advanceSchedule(workflowId: string, due: Date, nextAt: Date) {
    await sql`UPDATE workflow_schedule SET "lastAt"=${due},"nextAt"=${nextAt} WHERE "workflowId"=${workflowId}::uuid AND "nextAt"=${due}`.execute(
      this.db,
    );
  }

  private queryBuilder(db?: Kysely<DB>) {
    return (db ?? this.db)
      .selectFrom('workflow')
      .leftJoin('workflow_definition', 'workflow_definition.workflowId', 'workflow.id')
      .select('workflow_definition.definition')
      .select([
        'workflow.id',
        'workflow.ownerId',
        'workflow.name',
        'workflow.description',
        'workflow.trigger',
        'workflow.enabled',
        'workflow.createdAt',
        'workflow.updatedAt',
        'workflow.logging',
      ])
      .select((eb) => [
        jsonArrayFrom(
          eb
            .selectFrom('workflow_step')
            .innerJoin('plugin_method', 'plugin_method.id', 'workflow_step.pluginMethodId')
            .innerJoin('plugin', 'plugin.id', 'plugin_method.pluginId')
            .whereRef('workflow.id', '=', 'workflow_step.workflowId')
            .select([
              'workflow_step.id',
              'plugin.name as pluginName',
              'plugin_method.name as methodName',
              'workflow_step.config',
              'workflow_step.enabled',
            ])
            .orderBy('workflow_step.order', 'asc'),
        ).as('steps'),
      ]);
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  search(dto: WorkflowSearchDto & { userId?: string }) {
    return this.queryBuilder()
      .$if(!!dto.id, (qb) => qb.where('workflow.id', '=', dto.id!))
      .$if(!!dto.userId, (qb) => qb.where('workflow.ownerId', '=', dto.userId!))
      .$if(!!dto.trigger, (qb) => qb.where('workflow.trigger', '=', dto.trigger!))
      .$if(dto.enabled !== undefined, (qb) => qb.where('workflow.enabled', '=', dto.enabled!))
      .orderBy('workflow.createdAt', 'desc')
      .execute();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  get(id: string) {
    return this.queryBuilder().where('workflow.id', '=', id).executeTakeFirst();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  async getForWorkflowRun(id: string) {
    return this.db
      .selectFrom('workflow')
      .leftJoin('workflow_definition', 'workflow_definition.workflowId', 'workflow.id')
      .select([
        'workflow.id',
        'workflow.ownerId',
        'workflow.name',
        'workflow.trigger',
        'workflow.logging',
        'workflow_definition.definition',
      ])
      .select((eb) => [
        jsonArrayFrom(
          eb
            .selectFrom('workflow_step')
            .innerJoin('plugin_method', 'plugin_method.id', 'workflow_step.pluginMethodId')
            .innerJoin('plugin', 'plugin.id', 'plugin_method.pluginId')
            .whereRef('workflow_step.workflowId', '=', 'workflow.id')
            .where('workflow_step.enabled', '=', true)
            .select([
              'workflow_step.id',
              'workflow_step.config',
              'workflow_step.order',
              'plugin_method.pluginId as pluginId',
              'plugin.name as pluginName',
              'plugin.enabled as pluginEnabled',
              'plugin_method.name as methodName',
              'plugin_method.types as types',
              'plugin_method.hostFunctions',
              'plugin_method.allowedHosts',
            ])
            // run in the order the owner put the steps in
            .orderBy('workflow_step.order', 'asc'),
        ).as('steps'),
      ])
      .where('workflow.id', '=', id)
      .where('workflow.enabled', '=', true)
      .executeTakeFirst();
  }

  create(dto: Insertable<WorkflowTable>, definition: WorkflowDefinitionDocument, steps: WorkflowStepUpsert[]) {
    return this.db.transaction().execute(async (tx) => {
      const { id } = await tx.insertInto('workflow').values(dto).returning(['id']).executeTakeFirstOrThrow();
      return this.replaceAndReturn(tx, id, { definition, steps });
    });
  }

  /**
   * Updates a workflow, and when a definition is given replaces its steps with the runnable ones and
   * stores the complete definition beside them, in one transaction.
   */
  update(
    id: string,
    dto: Updateable<WorkflowTable>,
    replacement?: { definition: WorkflowDefinitionDocument; steps: WorkflowStepUpsert[] },
  ) {
    return this.db.transaction().execute(async (tx) => {
      await tx.selectFrom('workflow').select('id').where('id', '=', id).forUpdate().execute();
      if (replacement || dto.enabled === false) {
        await sql`UPDATE workflow_batch SET status='cancelled',"updatedAt"=now(),"finishedAt"=now() WHERE "workflowId"=${id}::uuid AND status IN ('pending','running')`.execute(
          tx,
        );
        await sql`DELETE FROM workflow_schedule WHERE "workflowId"=${id}::uuid`.execute(tx);
      }
      if (dto.logging === false) {
        await tx.deleteFrom('workflow_log_detail').where('workflowId', '=', id).execute();
        await tx.deleteFrom('workflow_log').where('workflowId', '=', id).execute();
      }
      if (Object.values(dto).some((prop) => prop !== undefined)) {
        await tx.updateTable('workflow').set(dto).where('id', '=', id).executeTakeFirstOrThrow();
      }
      return this.replaceAndReturn(tx, id, replacement);
    });
  }

  @GenerateSql({ params: [DummyValue.UUID, { result: undefined }] })
  getLogs(id: string, dto: WorkflowGetLogsDto) {
    return this.db
      .selectFrom('workflow_log')
      .select([
        'workflow_log.id',
        'workflow_log.createdAt',
        'workflow_log.result',
        'workflow_log.workflowId',
        'workflow_log.workflowStepId',
        'workflow_log.triggerDataId',
      ])
      .leftJoin('workflow_log_detail', 'workflow_log_detail.logId', 'workflow_log.id')
      .select([
        'workflow_log.runId',
        'workflow_log_detail.attempt',
        'workflow_log_detail.errorCode',
        'workflow_log_detail.error',
      ])
      .where('workflow_log.workflowId', '=', id)
      .select((eb) => [
        jsonObjectFrom(
          eb
            .selectFrom('workflow_step')
            .whereRef('workflow_step.id', '=', 'workflow_log.workflowStepId')
            .innerJoin('plugin_method', 'plugin_method.id', 'workflow_step.pluginMethodId')
            .select(['plugin_method.pluginId', 'plugin_method.name as methodName', 'workflow_step.order']),
        ).as('step'),
      ])
      .$if(dto.result !== undefined, (qb) => qb.where('workflow_log.result', '=', dto.result!))
      .$if(dto.before !== undefined, (qb) => qb.where('workflow_log.createdAt', '<', dto.before!))
      .orderBy('workflow_log.createdAt', 'desc')
      .limit(dto.limit)
      .execute();
  }

  /** Records one run attempt: the shared log entry and what it cannot hold (attempt, failure). */
  log({ attempt, errorCode, error, ...dto }: WorkflowRunLog) {
    return this.db.transaction().execute(async (tx) => {
      const { id } = await tx.insertInto('workflow_log').values(dto).returning('id').executeTakeFirstOrThrow();
      await tx
        .insertInto('workflow_log_detail')
        .values({ logId: id, workflowId: dto.workflowId, attempt, errorCode: errorCode ?? null, error: error ?? null })
        .execute();
      return id;
    });
  }

  /**
   * The steps a queued run has already completed (FL-179), by the job's `executionId`, and whether one
   * of them stopped the run. A replay of the same job skips them.
   */
  async getCompletedSteps(executionId: string): Promise<Map<string, { halted: boolean }>> {
    const rows = await this.db
      .selectFrom('workflow_run_step')
      .select(['stepId', 'halted'])
      .where('executionId', '=', executionId)
      .execute();
    return new Map(rows.map(({ stepId, halted }) => [stepId, { halted }]));
  }

  /** Records that a queued run completed a step (FL-179); recording it again changes nothing. */
  async completeStep(step: { executionId: string; workflowId: string; stepId: string; halted: boolean }) {
    await this.db
      .insertInto('workflow_run_step')
      .values(step)
      .onConflict((oc) => oc.columns(['executionId', 'stepId']).doNothing())
      .execute();
  }

  /** Forgets completed steps recorded before `before`; no replay of those runs can still happen. */
  async deleteCompletedStepsBefore(before: Date): Promise<number> {
    const result = await this.db
      .deleteFrom('workflow_run_step')
      .where('createdAt', '<', before)
      .where(
        sql<boolean>`NOT EXISTS(SELECT 1 FROM workflow_batch b WHERE b."workflowId"=workflow_run_step."workflowId" AND b.status IN ('pending','running'))`,
      )
      .executeTakeFirst();
    return Number(result.numDeletedRows);
  }

  /** The newest logged attempt of one run, for a manual retry. */
  @GenerateSql({ params: [DummyValue.UUID, DummyValue.UUID] })
  getLatestRunAttempt(workflowId: string, runId: string) {
    return this.db
      .selectFrom('workflow_log')
      .leftJoin('workflow_log_detail', 'workflow_log_detail.logId', 'workflow_log.id')
      .select([
        'workflow_log.runId',
        'workflow_log.triggerDataId',
        'workflow_log.result',
        'workflow_log_detail.attempt',
      ])
      .where('workflow_log.workflowId', '=', workflowId)
      .where('workflow_log.runId', '=', runId)
      .orderBy('workflow_log.createdAt', 'desc')
      .limit(1)
      .executeTakeFirst();
  }

  /**
   * Keeps what a plugin asked to remember in its step, in both the runnable step and the stored
   * definition, so an edit of the workflow later does not bring back the old configuration.
   */
  async updateStepConfig(
    workflowId: string,
    stepId: string,
    config: Record<string, unknown>,
    fence?: { expectedHash: string; batchId: string },
  ) {
    await this.db.transaction().execute(async (tx) => {
      await tx.selectFrom('workflow').select('id').where('id', '=', workflowId).forUpdate().execute();
      const row = await tx
        .selectFrom('workflow_definition')
        .select('definition')
        .where('workflowId', '=', workflowId)
        .forUpdate()
        .executeTakeFirst();
      if (fence) {
        const batch = await tx
          .selectFrom('workflow_batch')
          .select('status')
          .where('id', '=', fence.batchId)
          .executeTakeFirst();
        if (
          !row ||
          workflowDefinitionHash(row.definition) !== fence.expectedHash ||
          !batch ||
          !['pending', 'running'].includes(batch.status)
        )
          throw new ConflictException('Workflow changed before plugin state could be saved');
      }
      await tx
        .updateTable('workflow_step')
        .where('id', '=', stepId)
        .where('workflowId', '=', workflowId)
        .set({ config: config as any })
        .execute();
      if (!row) return;
      const definition = row.definition as WorkflowDefinitionDocument;
      const updated = {
        ...definition,
        steps: definition.steps.map((step) => (step.id === stepId ? { ...step, config } : step)),
      };
      await tx
        .updateTable('workflow_definition')
        .set({ definition: updated as any, updatedAt: new Date() })
        .where('workflowId', '=', workflowId)
        .execute();
      if (fence)
        await tx
          .updateTable('workflow_batch')
          .set({ definition: updated, definitionSha256: workflowDefinitionHash(updated), updatedAt: new Date() })
          .where('id', '=', fence.batchId)
          .execute();
    });
  }

  async claimCausation(chainId: string, workflowId: string, assetId: string, runId: string): Promise<boolean> {
    await sql`INSERT INTO workflow_causation("chainId","workflowId","assetId","runId") VALUES(${chainId}::uuid,${workflowId}::uuid,${assetId}::uuid,${runId}::uuid) ON CONFLICT DO NOTHING`.execute(
      this.db,
    );
    const {
      rows: [row],
    } = await sql<{
      runId: string;
    }>`SELECT "runId" FROM workflow_causation WHERE "chainId"=${chainId}::uuid AND "workflowId"=${workflowId}::uuid AND "assetId"=${assetId}::uuid`.execute(
      this.db,
    );
    return row?.runId === runId;
  }
  async getAssetOwner(assetId: string) {
    return (await this.db.selectFrom('asset').select('ownerId').where('id', '=', assetId).executeTakeFirst())?.ownerId;
  }

  getAssetOwners(assetIds: string[]) {
    return this.db.selectFrom('asset').select(['id', 'ownerId']).where('id', '=', anyUuid(assetIds)).execute();
  }

  private async replaceAndReturn(
    tx: Kysely<DB>,
    workflowId: string,
    replacement?: { definition: WorkflowDefinitionDocument; steps: WorkflowStepUpsert[] },
  ) {
    if (replacement) {
      const { definition, steps } = replacement;
      await tx.deleteFrom('workflow_step').where('workflowId', '=', workflowId).execute();
      if (steps.length > 0) {
        await tx
          .insertInto('workflow_step')
          .values(
            steps.map((step) => ({
              id: step.id,
              workflowId,
              enabled: step.enabled ?? true,
              pluginMethodId: step.pluginMethodId,
              config: step.config,
              order: step.order,
            })),
          )
          .execute();
      }
      await tx
        .insertInto('workflow_definition')
        .values({ workflowId, definition: definition as any })
        .onConflict((oc) =>
          oc.column('workflowId').doUpdateSet({ definition: definition as any, updatedAt: new Date() }),
        )
        .execute();
    }

    return this.queryBuilder(tx).where('workflow.id', '=', workflowId).executeTakeFirstOrThrow();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  async delete(id: string) {
    await this.db.deleteFrom('workflow').where('id', '=', id).execute();
  }

  /**
   * Privacy gate for workflow execution. Fail-closed: returns false unless
   * the asset is provably safe to expose to plugins.
   *
   * @param requireEnrichment When true, also requires that image enrichment
   *   metadata exists for the asset — used when NSFW detection is enabled so
   *   plugins never see assets whose classification has not yet completed.
   */
  async isWorkflowEligible(assetId: string, { requireEnrichment }: { requireEnrichment: boolean }): Promise<boolean> {
    const row = await this.db
      .selectFrom('asset')
      .select((eb) => [
        // `locked` for a locked asset (FL-34): plugins never see locked media
        effectiveVisibility('asset').as('visibility'),
        // The shared predicate reads sensitive evidence from `public.asset.is_nsfw`.
        nsfwAssetIdExists(sql.ref('asset.id')).as('isNsfw'),
        eb
          .exists(
            eb
              .selectFrom('asset_metadata')
              .select('asset_metadata.assetId')
              .whereRef('asset_metadata.assetId', '=', 'asset.id')
              .where('asset_metadata.key', '=', AssetMetadataKey.MlEnrichment),
          )
          .as('hasEnrichment'),
      ])
      .where('asset.id', '=', assetId)
      .where('asset.deletedAt', 'is', null)
      .executeTakeFirst();

    if (!row) {
      return false;
    }

    if (row.visibility === AssetVisibility.Hidden || row.visibility === AssetVisibility.Locked) {
      return false;
    }

    if (row.isNsfw) {
      return false;
    }

    if (requireEnrichment && !row.hasEnrichment) {
      return false;
    }

    return true;
  }

  getForAssetV1(assetId: string) {
    return this.db
      .selectFrom('asset')
      .select((eb) => [
        ...columns.workflowAssetV1,
        withTags,
        jsonObjectFrom(
          eb
            .selectFrom('asset_exif')
            .select([
              'asset_exif.make',
              'asset_exif.model',
              'asset_exif.orientation',
              'asset_exif.dateTimeOriginal',
              'asset_exif.modifyDate',
              'asset_exif.exifImageWidth',
              'asset_exif.exifImageHeight',
              'asset_exif.fileSizeInByte',
              'asset_exif.lensModel',
              'asset_exif.fNumber',
              'asset_exif.focalLength',
              'asset_exif.iso',
              'asset_exif.latitude',
              'asset_exif.longitude',
              'asset_exif.city',
              'asset_exif.state',
              'asset_exif.country',
              'asset_exif.description',
              'asset_exif.fps',
              'asset_exif.exposureTime',
              'asset_exif.livePhotoCID',
              'asset_exif.timeZone',
              'asset_exif.projectionType',
              'asset_exif.profileDescription',
              'asset_exif.colorspace',
              'asset_exif.bitsPerSample',
              'asset_exif.autoStackId',
              'asset_exif.rating',
              'asset_exif.tags',
              'asset_exif.updatedAt',
            ])
            .whereRef('asset_exif.assetId', '=', 'asset.id'),
        ).as('exifInfo'),
      ])
      .where('id', '=', assetId)
      .executeTakeFirstOrThrow();
  }
}
