import { WorkflowTrigger } from '@frameleaf/plugin-sdk';
import { BadRequestException, Injectable } from '@nestjs/common';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import type { WorkflowBatch, WorkflowRepository, WorkflowStepUpsert } from 'src/repositories/workflow.repository.js';
import type { WorkflowDefinitionDocument } from 'src/schema/tables/workflow-definition.table.js';
import { mapTemplate } from 'src/dtos/plugin.dto.js';
import {
  LegacyWorkflowTriggerResponseDto,
  WorkflowBatchResponseDto,
  WorkflowCapabilitiesDto,
  WorkflowCreateDto,
  WorkflowDiscoveryResponseDto,
  WorkflowGetLogsDto,
  WorkflowLogEntryDto,
  WorkflowPreviewDto,
  WorkflowPreviewResponseDto,
  WorkflowResponseDto,
  WorkflowSearchDto,
  WorkflowShareResponseDto,
  WorkflowUpdateDto,
  mapWorkflow,
  mapWorkflowShare,
} from 'src/dtos/workflow.dto.js';
import { JobName, LegacyWorkflowTriggerSchema, Permission, WorkflowRunErrorCode } from 'src/enum.js';
import { BaseService } from 'src/services/base.service.js';
import { getLockedOwnerId } from 'src/utils/locked-visibility.js';
import { findOrFail, isSmartSearchEnabled } from 'src/utils/misc.js';
import { collectFilterIds } from 'src/utils/search-filter.js';
import {
  WorkflowDefinitionInput,
  WorkflowMethodDefinition,
  definitionFromSteps,
  isKnownTrigger,
  resolveDefinitionMethod,
  restoreCredentials,
  toDefinition,
  workflowIssues,
} from 'src/utils/workflow-definition.js';
import {
  type WorkflowSource,
  nextWorkflowOccurrence,
  resolveWorkflowSource,
  workflowDefinitionHash,
} from 'src/utils/workflow-source.js';
import { getWorkflowTriggers, isMethodCompatible } from 'src/utils/workflow.js';

type StoredWorkflow = NonNullable<Awaited<ReturnType<WorkflowRepository['get']>>>;

/**
 * Workflows (FL-82). A workflow's complete definition is stored as written — unknown methods,
 * parameters and additional fields included — so import, edit and export never lose anything. Only
 * the steps an enabled, installed plugin provides are written as runnable steps, and a workflow can be
 * enabled only while its whole definition can run here. Credentials in step parameters and additional fields are kept on
 * the server and never returned.
 */
@Injectable()
export class WorkflowService extends BaseService {
  async capabilities(): Promise<WorkflowCapabilitiesDto> {
    const { server } = await this.getConfig({ withCache: true });
    return {
      version: 1,
      sourceFilters: true,
      semanticThreshold: true,
      rollingDates: true,
      assetChanged: true,
      schedules: true,
      batchRuns: true,
      timezone: server.timeZone || new Intl.DateTimeFormat().resolvedOptions().timeZone,
    };
  }

  async validateSource(source: WorkflowSource, ownerId: string, embeddingKey?: string) {
    if (embeddingKey) {
      const { machineLearning } = await this.getConfig({ withCache: true });
      if ((await this.machineLearningRepository.clipCacheKey(machineLearning.clip.modelName)) !== embeddingKey)
        throw new BadRequestException('The semantic index changed; start a new workflow run');
    }
    const auth = { user: { id: ownerId }, hideNsfwAssets: true } as AuthDto;
    const ids = collectFilterIds(source.filter, 'albumIds');
    if (ids.length > 0) await this.requireAccess({ auth, permission: Permission.AlbumRead, ids });
    if (source.semantic?.queryAssetId)
      await this.requireAccess({ auth, permission: Permission.AssetRead, ids: [source.semantic.queryAssetId] });
  }
  async prepareSource(source: WorkflowSource, at: Date, ownerId: string) {
    await this.validateSource(source, ownerId);
    const resolved = resolveWorkflowSource(source, at);
    let embedding: string | undefined;
    let embeddingKey: string | undefined;
    const { machineLearning } = await this.getConfig({ withCache: true });
    const requireEnrichment = machineLearning.nsfwDetection.enabled || machineLearning.imageDescription.enabled;
    if (resolved.semantic) {
      if (!isSmartSearchEnabled(machineLearning)) throw new BadRequestException('Smart search is not enabled');
      const read = await this.machineLearningRepository.captureClipRead();
      embeddingKey = await this.machineLearningRepository.clipCacheKey(machineLearning.clip.modelName);
      if (resolved.semantic.queryAssetId) {
        const reference = await this.workflowRepository.getForAssetV1(resolved.semantic.queryAssetId);
        if (
          reference.ownerId !== ownerId ||
          !(await this.workflowRepository.isWorkflowEligible(reference.id, {
            requireEnrichment: machineLearning.nsfwDetection.enabled || machineLearning.imageDescription.enabled,
          }))
        )
          throw new BadRequestException('Reference photo is unavailable');
        embedding = (await this.searchRepository.getEmbedding(reference.id))?.embedding;
        if (!embedding) throw new BadRequestException('Reference photo has not been indexed');
      } else
        embedding = await this.machineLearningRepository.encodeText(
          await this.selectClipTextDestination(),
          resolved.semantic.query!,
          { modelName: machineLearning.clip.modelName },
        );
      await read.assertCurrent();
    }
    return { source: resolved, embedding, embeddingKey, requireEnrichment };
  }

  async preview(auth: AuthDto, dto: WorkflowPreviewDto): Promise<WorkflowPreviewResponseDto> {
    let steps: WorkflowDefinitionInput['steps'] = dto.steps ?? [];
    if (dto.workflowId) {
      await this.requireAccess({ auth, permission: Permission.WorkflowRead, ids: [dto.workflowId] });
      const stored = this.definitionOf(await this.findOrFail(dto.workflowId));
      steps = this.withStoredCredentials(steps, stored);
    }
    const definition = this.parseDefinition({ ...dto, steps });
    const issues = workflowIssues(definition, await this.pluginRepository.getForValidation());
    const at = new Date();
    const { source, embedding, embeddingKey, requireEnrichment } = await this.prepareSource(
      definition.source ?? { filter: {} },
      at,
      auth.user.id,
    );
    const result = await this.workflowRepository.previewSource(auth.user.id, source, embedding, requireEnrichment);
    await this.validateSource(source, auth.user.id, embeddingKey);
    return {
      ...result,
      evaluatedAt: at.toISOString(),
      issues,
      actions: definition.steps.filter((step) => step.enabled).map((step) => step.method),
    };
  }

  async runBatch(
    auth: AuthDto,
    id: string,
    reason: 'manual' | 'schedule' = 'manual',
  ): Promise<WorkflowBatchResponseDto> {
    await this.requireAccess({ auth, permission: Permission.WorkflowUpdate, ids: [id] });
    const workflow = await this.findOrFail(id);
    if (!workflow.enabled) throw new BadRequestException('Enable this workflow before running it');
    const definition = this.definitionOf(workflow);
    this.assertCanEnable(true, definition, await this.pluginRepository.getForValidation());
    const snapshotAt = new Date();
    const prepared = await this.prepareSource(definition.source ?? { filter: {} }, snapshotAt, auth.user.id);
    const batch = await this.workflowRepository.createBatch({
      workflowId: id,
      ownerId: auth.user.id,
      definition,
      ...prepared,
      definitionSha256: workflowDefinitionHash(definition),
      reason,
      snapshotAt,
    });
    return this.mapBatch(batch);
  }
  async getBatches(auth: AuthDto, id: string): Promise<WorkflowBatchResponseDto[]> {
    await this.requireAccess({ auth, permission: Permission.WorkflowRead, ids: [id] });
    return (await this.workflowRepository.getBatches(id)).map((batch) => this.mapBatch(batch));
  }
  async getBatch(auth: AuthDto, id: string, batchId: string): Promise<WorkflowBatchResponseDto> {
    await this.requireAccess({ auth, permission: Permission.WorkflowRead, ids: [id] });
    const batch = (await this.workflowRepository.getBatches(id, batchId))[0];
    if (!batch) throw new BadRequestException('Workflow batch not found');
    return this.mapBatch(batch);
  }
  async cancelBatch(auth: AuthDto, id: string, batchId: string): Promise<WorkflowBatchResponseDto> {
    await this.requireAccess({ auth, permission: Permission.WorkflowUpdate, ids: [id] });
    await this.workflowRepository.cancelBatches(id, batchId);
    return this.getBatch(auth, id, batchId);
  }
  private mapBatch(batch: WorkflowBatch): WorkflowBatchResponseDto {
    const { id, workflowId, status, reason, total, completed, skipped, failed, error } = batch;
    return {
      id,
      workflowId,
      status,
      reason,
      total,
      completed,
      skipped,
      failed,
      error,
      createdAt: batch.createdAt.toISOString(),
      updatedAt: batch.updatedAt.toISOString(),
      finishedAt: batch.finishedAt?.toISOString() ?? null,
      snapshotAt: batch.snapshotAt.toISOString(),
    };
  }

  getTriggers(): LegacyWorkflowTriggerResponseDto[] {
    return getWorkflowTriggers().filter(
      (entry): entry is LegacyWorkflowTriggerResponseDto =>
        LegacyWorkflowTriggerSchema.safeParse(entry.trigger).success,
    );
  }

  async discovery(): Promise<WorkflowDiscoveryResponseDto> {
    const plugins = await this.pluginRepository.search({ enabled: true });
    return {
      triggers: getWorkflowTriggers(),
      templates: plugins.flatMap((plugin) => plugin.templates.map((template) => mapTemplate(plugin, template))),
    };
  }

  async search(auth: AuthDto, dto: WorkflowSearchDto): Promise<WorkflowResponseDto[]> {
    const [workflows, methods] = await Promise.all([
      this.workflowRepository.search({ ...dto, userId: auth.user.id }),
      this.pluginRepository.getForValidation(),
    ]);
    return Promise.all(workflows.map((workflow) => this.map(workflow, methods)));
  }

  async get(auth: AuthDto, id: string): Promise<WorkflowResponseDto> {
    await this.requireAccess({ auth, permission: Permission.WorkflowRead, ids: [id] });
    const [workflow, methods] = await Promise.all([this.findOrFail(id), this.pluginRepository.getForValidation()]);
    return this.map(workflow, methods);
  }

  async share(auth: AuthDto, id: string): Promise<WorkflowShareResponseDto> {
    await this.requireAccess({ auth, permission: Permission.WorkflowRead, ids: [id] });
    const workflow = await this.findOrFail(id);
    return mapWorkflowShare(workflow, this.definitionOf(workflow));
  }

  async create(auth: AuthDto, dto: WorkflowCreateDto): Promise<WorkflowResponseDto> {
    const { steps, extra, trigger, source, schedule, ...workflowDto } = dto;
    const definition = this.parseDefinition({ trigger, extra, source, schedule, steps: steps ?? [] });
    const methods = await this.pluginRepository.getForValidation();
    const enabled = workflowDto.enabled ?? true;
    this.assertCanEnable(enabled, definition, methods);

    const workflow = await this.workflowRepository.create(
      { ...workflowDto, enabled, trigger: this.storedTrigger(definition), ownerId: auth.user.id },
      definition,
      this.runnableSteps(definition, methods),
    );
    return this.map(workflow, methods);
  }

  async update(auth: AuthDto, id: string, dto: WorkflowUpdateDto): Promise<WorkflowResponseDto> {
    await this.requireAccess({ auth, permission: Permission.WorkflowUpdate, ids: [id] });

    const { steps, extra, trigger, source, schedule, ...workflowDto } = dto;
    const current = await this.findOrFail(id);
    const stored = this.definitionOf(current);
    const methods = await this.pluginRepository.getForValidation();

    const changesDefinition =
      steps !== undefined ||
      extra !== undefined ||
      trigger !== undefined ||
      source !== undefined ||
      schedule !== undefined;
    const definition = changesDefinition
      ? this.parseDefinition({
          trigger: trigger ?? stored.trigger,
          source: source === undefined ? stored.source : source,
          schedule: schedule === undefined ? stored.schedule : schedule,
          extra: extra === undefined ? stored.extra : this.withStoredExtraCredentials(extra, stored.extra),
          steps: steps ? this.withStoredCredentials(steps, stored) : stored.steps,
        })
      : stored;
    this.assertCanEnable(workflowDto.enabled ?? current.enabled, definition, methods);

    const workflow = await this.workflowRepository.update(
      id,
      { ...workflowDto, ...(changesDefinition && { trigger: this.storedTrigger(definition) }) },
      changesDefinition ? { definition, steps: this.runnableSteps(definition, methods) } : undefined,
    );
    return this.map(workflow, methods);
  }

  async delete(auth: AuthDto, id: string): Promise<void> {
    await this.requireAccess({ auth, permission: Permission.WorkflowDelete, ids: [id] });
    await this.workflowRepository.delete(id);
  }

  async getLogs(auth: AuthDto, id: string, dto: WorkflowGetLogsDto): Promise<WorkflowLogEntryDto[]> {
    await this.requireAccess({ auth, permission: Permission.WorkflowLogs, ids: [id] });
    const logs = await this.workflowRepository.getLogs(id, dto);
    // a log keeps the id that triggered it; one that is Locked media now is named only to an elevated
    // session (FL-34)
    const triggerIds = logs
      .map(({ triggerDataId }) => triggerDataId)
      .filter((triggerId): triggerId is string => !!triggerId);
    const lockedIds =
      getLockedOwnerId(auth) || triggerIds.length === 0
        ? new Set<string>()
        : await this.assetRepository.getLockedAssetIds(triggerIds);
    return logs.map((entry) => ({
      id: entry.id,
      at: entry.createdAt,
      result: entry.result,
      runId: entry.runId,
      attempt: entry.attempt ?? 0,
      errorCode: (entry.errorCode as WorkflowRunErrorCode | null) ?? undefined,
      error: entry.error ?? undefined,
      triggerDataId: entry.triggerDataId && !lockedIds.has(entry.triggerDataId) ? entry.triggerDataId : undefined,
      lastStep: entry.step
        ? {
            index: entry.step.order,
            method: `${entry.step.pluginId}#${entry.step.methodName}`,
          }
        : undefined,
    }));
  }

  /**
   * Runs a logged run again for the photo that started it, as a new attempt of the same run. Only an
   * enabled workflow whose whole definition can run is retried; the privacy gate applies again when
   * the job runs.
   */
  async retryRun(auth: AuthDto, id: string, runId: string): Promise<void> {
    await this.requireAccess({ auth, permission: Permission.WorkflowUpdate, ids: [id] });
    const [workflow, methods, run] = await Promise.all([
      this.findOrFail(id),
      this.pluginRepository.getForValidation(),
      this.workflowRepository.getLatestRunAttempt(id, runId),
    ]);
    if (!run?.triggerDataId) {
      throw new BadRequestException('This run cannot be retried');
    }
    if (!workflow.enabled) {
      throw new BadRequestException('Enable this workflow before retrying a run');
    }
    const [issue] = workflowIssues(this.definitionOf(workflow), methods);
    if (issue) {
      throw new BadRequestException(issue.message);
    }
    await this.jobRepository.queue({
      name: JobName.WorkflowAssetTrigger,
      // FL-179: its own execution id, so the retry runs every step again, whatever an earlier attempt completed
      data: {
        workflowId: id,
        assetId: run.triggerDataId,
        runId,
        attempt: (run.attempt ?? 0) + 1,
        manual: true,
        executionId: crypto.randomUUID(),
      },
    });
  }

  private async map(workflow: StoredWorkflow, methods: WorkflowMethodDefinition[]) {
    const definition = this.definitionOf(workflow);
    const response = mapWorkflow(workflow, definition, workflowIssues(definition, methods));
    if (definition.schedule && workflow.enabled && response.issues.length === 0) {
      const { timezone } = await this.capabilities();
      response.nextRunAt =
        (await this.workflowRepository.getSchedule(workflow.id))?.nextAt.toISOString() ??
        nextWorkflowOccurrence(definition.schedule, new Date(), timezone).toISOString();
    }
    return response;
  }

  /** The stored definition, or for a workflow stored before definitions were kept, its steps. */
  private definitionOf(workflow: StoredWorkflow): WorkflowDefinitionDocument {
    return workflow.definition ?? definitionFromSteps(workflow.trigger, workflow.steps);
  }

  private parseDefinition(input: WorkflowDefinitionInput) {
    try {
      return toDefinition(input);
    } catch (error) {
      throw new BadRequestException((error as Error).message);
    }
  }

  /** An edited step without a credential keeps the stored one, when it is the same step and method. */
  private withStoredCredentials(steps: WorkflowDefinitionInput['steps'], stored: WorkflowDefinitionDocument) {
    const byId = new Map(stored.steps.map((step) => [step.id, step]));
    const seen = new Set<string>();
    return steps.map((step) => {
      const previous = step.id && !seen.has(step.id) ? byId.get(step.id) : undefined;
      if (step.id) {
        seen.add(step.id);
      }
      try {
        return previous && previous.method === step.method
          ? {
              ...step,
              config: restoreCredentials(step.config, previous.config),
              // additional fields left out are kept as stored; sent ones keep the stored credentials they omit
              extra:
                step.extra === undefined
                  ? previous.extra
                  : (restoreCredentials(step.extra, previous.extra) ?? undefined),
            }
          : step;
      } catch (error) {
        throw new BadRequestException((error as Error).message);
      }
    });
  }

  /** Workflow-level additional fields are returned without credentials, so a saved copy keeps the stored ones. */
  private withStoredExtraCredentials(extra: WorkflowDefinitionInput['extra'], stored: Record<string, unknown>) {
    try {
      return restoreCredentials(extra ?? null, stored);
    } catch (error) {
      throw new BadRequestException((error as Error).message);
    }
  }

  private assertCanEnable(
    enabled: boolean,
    definition: WorkflowDefinitionDocument,
    methods: WorkflowMethodDefinition[],
  ) {
    if (!enabled) {
      return;
    }
    const [issue] = workflowIssues(definition, methods);
    if (issue) {
      throw new BadRequestException(`Pause this workflow before saving. ${issue.message}`);
    }
  }

  /** The shared workflow table only holds triggers this server offers; an unavailable one is kept in the definition. */
  private storedTrigger(definition: WorkflowDefinitionDocument): WorkflowTrigger {
    return isKnownTrigger(definition.trigger) ? definition.trigger : WorkflowTrigger.AssetCreate;
  }

  /** The steps an installed plugin can run for this trigger, at their positions in the definition. */
  private runnableSteps(
    definition: WorkflowDefinitionDocument,
    methods: WorkflowMethodDefinition[],
  ): WorkflowStepUpsert[] {
    const trigger = isKnownTrigger(definition.trigger) ? definition.trigger : undefined;
    return definition.steps.flatMap((step, order) => {
      const method = resolveDefinitionMethod(methods, step.method);
      if (!method || !trigger || !isMethodCompatible(method, trigger)) {
        return [];
      }
      return [{ id: step.id, order, enabled: step.enabled, config: step.config as any, pluginMethodId: method.id }];
    });
  }

  private findOrFail(id: string) {
    return findOrFail(() => this.workflowRepository.get(id), 'Workflow');
  }
}
