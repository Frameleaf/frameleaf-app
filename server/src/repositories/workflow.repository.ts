import { Injectable } from '@nestjs/common';
import { Insertable, Kysely, Updateable, sql } from 'kysely';
import { jsonArrayFrom, jsonObjectFrom } from 'kysely/helpers/postgres';
import { InjectKysely } from 'nestjs-kysely';
import type { WorkflowDefinitionDocument } from 'src/schema/tables/workflow-definition.table.js';
import { columns } from 'src/database.js';
import { DummyValue, GenerateSql } from 'src/decorators.js';
import { WorkflowGetLogsDto, WorkflowSearchDto } from 'src/dtos/workflow.dto.js';
import { AssetMetadataKey, AssetVisibility, WorkflowRunErrorCode } from 'src/enum.js';
import { DB } from 'src/schema/index.js';
import { WorkflowLogTable } from 'src/schema/tables/workflow-log.table.js';
import { WorkflowStepTable } from 'src/schema/tables/workflow-step.table.js';
import { WorkflowTable } from 'src/schema/tables/workflow.table.js';
import { nsfwAssetIdExists, withTags } from 'src/utils/database.js';
import { effectiveVisibility } from 'src/utils/locked.js';

/** A runnable step, stored under its definition step id at its definition position. */
export type WorkflowStepUpsert = Omit<Insertable<WorkflowStepTable>, 'workflowId'> & { id: string; order: number };

export type WorkflowRunLog = Insertable<WorkflowLogTable> & {
  attempt: number;
  errorCode?: WorkflowRunErrorCode | null;
  error?: string | null;
};

@Injectable()
export class WorkflowRepository {
  private allowedHostsColumn: Promise<boolean> | undefined;
  private runStepTable: Promise<boolean> | undefined;
  constructor(@InjectKysely() private db: Kysely<DB>) {}

  /**
   * FL-179: whether `workflow_run_step` exists. A database past its handoff cutover does not receive
   * new Frameleaf public migrations, so the table can be missing; then no step is recorded or skipped
   * and a stalled replay runs every step again, as before the table existed. Checked once and cached;
   * `resetRunStepTable` (after the startup migrations) checks again.
   */
  hasRunStepTable(): Promise<boolean> {
    return (this.runStepTable ??= sql<{ table: string | null }>`
      SELECT to_regclass('public.workflow_run_step')::text AS "table"
    `
      .execute(this.db)
      .then(({ rows }) => !!rows[0]?.table)
      .catch((error: unknown) => {
        // a failed check is not remembered
        this.runStepTable = undefined;
        throw error;
      }));
  }

  resetRunStepTable() {
    this.runStepTable = undefined;
  }

  private queryBuilder(db?: Kysely<DB>) {
    return (db ?? this.db)
      .selectFrom('workflow')
      .leftJoin('workflow_definition', 'workflow_definition.workflowId', 'workflow.id')
      .select('workflow_definition.definition')
      .select([
        'workflow.id',
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
    const hasAllowedHosts = await this.hasAllowedHostsColumn();
    return this.db
      .selectFrom('workflow')
      .leftJoin('workflow_definition', 'workflow_definition.workflowId', 'workflow.id')
      .select([
        'workflow.id',
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
            .select((eb) => [
              'workflow_step.id',
              'workflow_step.config',
              'workflow_step.order',
              'plugin_method.pluginId as pluginId',
              'plugin.name as pluginName',
              'plugin.enabled as pluginEnabled',
              'plugin_method.name as methodName',
              'plugin_method.types as types',
              'plugin_method.hostFunctions',
              hasAllowedHosts
                ? eb.ref('plugin_method.allowedHosts').as('allowedHosts')
                : sql<string[]>`ARRAY[]::character varying[]`.as('allowedHosts'),
            ])
            // run in the order the owner put the steps in
            .orderBy('workflow_step.order', 'asc'),
        ).as('steps'),
      ])
      .where('workflow.id', '=', id)
      .where('workflow.enabled', '=', true)
      .executeTakeFirst();
  }

  private hasAllowedHostsColumn(): Promise<boolean> {
    return (this.allowedHostsColumn ??= sql<{ exists: boolean }>`
      SELECT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'plugin_method'
          AND column_name = 'allowedHosts'
      ) AS "exists"
    `
      .execute(this.db)
      .then(({ rows }) => rows[0]?.exists));
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
    if (!(await this.hasRunStepTable())) {
      return new Map();
    }
    const rows = await this.db
      .selectFrom('workflow_run_step')
      .select(['stepId', 'halted'])
      .where('executionId', '=', executionId)
      .execute();
    return new Map(rows.map(({ stepId, halted }) => [stepId, { halted }]));
  }

  /** Records that a queued run completed a step (FL-179); recording it again changes nothing. */
  async completeStep(step: { executionId: string; workflowId: string; stepId: string; halted: boolean }) {
    if (!(await this.hasRunStepTable())) {
      return;
    }
    await this.db
      .insertInto('workflow_run_step')
      .values(step)
      .onConflict((oc) => oc.columns(['executionId', 'stepId']).doNothing())
      .execute();
  }

  /** Forgets completed steps recorded before `before`; no replay of those runs can still happen. */
  async deleteCompletedStepsBefore(before: Date): Promise<number> {
    if (!(await this.hasRunStepTable())) {
      return 0;
    }
    const result = await this.db.deleteFrom('workflow_run_step').where('createdAt', '<', before).executeTakeFirst();
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
  async updateStepConfig(workflowId: string, stepId: string, config: Record<string, unknown>) {
    await this.db.transaction().execute(async (tx) => {
      await tx
        .updateTable('workflow_step')
        .where('workflow_step.id', '=', stepId)
        .set({ config: config as any })
        .execute();
      const row = await tx
        .selectFrom('workflow_definition')
        .select('definition')
        .where('workflowId', '=', workflowId)
        .forUpdate()
        .executeTakeFirst();
      if (!row) {
        return;
      }
      const definition = row.definition as WorkflowDefinitionDocument;
      const steps = definition.steps.map((step) => (step.id === stepId ? { ...step, config } : step));
      await tx
        .updateTable('workflow_definition')
        .set({ definition: { ...definition, steps } as any, updatedAt: new Date() })
        .where('workflowId', '=', workflowId)
        .execute();
    });
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
   * Fork privacy gate for workflow execution. Fail-closed: returns false unless
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
        // The shared phase-aware predicate uses legacy state during legacy and
        // dual-write, then switches exclusively to the fork privacy sidecar.
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
