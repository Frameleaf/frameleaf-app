import { WorkflowTrigger } from '@immich/plugin-sdk';
import { BadRequestException, Injectable } from '@nestjs/common';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import type { WorkflowRepository, WorkflowStepUpsert } from 'src/repositories/workflow.repository.js';
import type { WorkflowDefinitionDocument } from 'src/schema/tables/workflow-definition.table.js';
import {
  WorkflowCreateDto,
  WorkflowGetLogsDto,
  WorkflowLogEntryDto,
  WorkflowResponseDto,
  WorkflowSearchDto,
  WorkflowShareResponseDto,
  WorkflowTriggerResponseDto,
  WorkflowUpdateDto,
  mapWorkflow,
  mapWorkflowShare,
} from 'src/dtos/workflow.dto.js';
import { JobName, Permission, WorkflowRunErrorCode } from 'src/enum.js';
import { BaseService } from 'src/services/base.service.js';
import { getLockedOwnerId } from 'src/utils/locked-visibility.js';
import { findOrFail } from 'src/utils/misc.js';
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
  getTriggers(): WorkflowTriggerResponseDto[] {
    return getWorkflowTriggers();
  }

  async search(auth: AuthDto, dto: WorkflowSearchDto): Promise<WorkflowResponseDto[]> {
    const [workflows, methods] = await Promise.all([
      this.workflowRepository.search({ ...dto, userId: auth.user.id }),
      this.pluginRepository.getForValidation(),
    ]);
    return workflows.map((workflow) => this.map(workflow, methods));
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
    const { steps, extra, trigger, ...workflowDto } = dto;
    const definition = this.parseDefinition({ trigger, extra, steps: steps ?? [] });
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

    const { steps, extra, trigger, ...workflowDto } = dto;
    const current = await this.findOrFail(id);
    const stored = this.definitionOf(current);
    const methods = await this.pluginRepository.getForValidation();

    const changesDefinition = steps !== undefined || extra !== undefined || trigger !== undefined;
    const definition = changesDefinition
      ? this.parseDefinition({
          trigger: trigger ?? stored.trigger,
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

  private map(workflow: StoredWorkflow, methods: WorkflowMethodDefinition[]) {
    const definition = this.definitionOf(workflow);
    return mapWorkflow(workflow, definition, workflowIssues(definition, methods));
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
