import { CurrentPlugin } from '@extism/extism';
import {
  WorkflowChanges,
  WorkflowEventData,
  WorkflowEventPayload,
  WorkflowResponse,
  WorkflowTrigger,
} from '@immich/plugin-sdk';
import { HttpException, UnauthorizedException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import type { ArgOf } from 'src/repositories/event.repository.js';
import type { WorkflowRepository, WorkflowRunLog } from 'src/repositories/workflow.repository.js';
import type { JobOf } from 'src/types.js';
import { DummyValue, OnEvent, OnJob } from 'src/decorators.js';
import { AlbumsAddAssetsDto, CreateAlbumDto, GetAlbumsDto } from 'src/dtos/album.dto.js';
import { BulkIdsDto } from 'src/dtos/asset-ids.response.dto.js';
import { PluginManifestDto } from 'src/dtos/plugin-manifest.dto.js';
import { TagBulkAssetsDto } from 'src/dtos/tag.dto.js';
import {
  BootstrapEventPriority,
  DatabaseLock,
  ImmichEnvironment,
  ImmichWorker,
  JobName,
  JobStatus,
  QueueName,
  WorkflowResult,
  WorkflowRunErrorCode,
  WorkflowType,
} from 'src/enum.js';
import { AlbumService } from 'src/services/album.service.js';
import { AssetService } from 'src/services/asset.service.js';
import { BaseService } from 'src/services/base.service.js';
import { TagService } from 'src/services/tag.service.js';
import { definitionFromSteps, redactRunError, workflowIssues } from 'src/utils/workflow-definition.js';

const dummy = () => {
  throw new Error(
    `Calling host functions is not allowed without setting methods[].hostFunctions=true in the plugin manifest`,
  );
};

type ExecuteOptions<T extends WorkflowType> = {
  read: (type: T) => Promise<{ authUserId: string; data: WorkflowEventData<T>; entityId?: string }>;
  write: (auth: AuthDto, changes: WorkflowChanges<T>) => Promise<void>;
};

type AssetTrigger = { userId: string; assetId: string; trigger: WorkflowTrigger };

type RunnableWorkflow = NonNullable<Awaited<ReturnType<WorkflowRepository['getForWorkflowRun']>>>;

const definitionOf = (workflow: RunnableWorkflow) =>
  workflow.definition ??
  definitionFromSteps(
    workflow.trigger,
    workflow.steps.map((step) => ({ ...step, enabled: true })),
  );

const definitionSha256 = (definition: ReturnType<typeof definitionFromSteps>) =>
  createHash('sha256')
    .update(
      JSON.stringify(definition, (_key, value: unknown) =>
        value && typeof value === 'object' && !Array.isArray(value)
          ? Object.fromEntries(
              Object.entries(value).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
            )
          : value,
      ),
    )
    .digest('hex');

type HostContext = {
  allowedHosts: string[];
};

/** FL-179: how long a queued run's completed steps are kept for a replay of its job. */
const WORKFLOW_RUN_STEP_RETENTION_DAYS = 7;

export class WorkflowExecutionService extends BaseService {
  private jwtSecret!: string;

  @OnEvent({ name: 'AppBootstrap', priority: BootstrapEventPriority.PluginSync, workers: [ImmichWorker.Microservices] })
  async onPluginSync() {
    await this.databaseRepository.withLock(DatabaseLock.PluginImport, async () => {
      // TODO avoid importing plugins in each worker
      // Can this use system metadata similar to geocoding?

      const { environment, resourcePaths, plugins } = this.configRepository.getEnv();
      await this.importFolder(resourcePaths.corePlugin, { force: environment === ImmichEnvironment.Development });

      if (plugins.external.allow && plugins.external.installFolder) {
        await this.importFolders(plugins.external.installFolder);
      }
    });
  }

  @OnEvent({ name: 'AppBootstrap', priority: BootstrapEventPriority.PluginLoad, workers: [ImmichWorker.Microservices] })
  async onPluginLoad() {
    this.jwtSecret = this.cryptoRepository.randomBytesAsText(32);

    const albumService = BaseService.create(AlbumService, this);
    const tagService = BaseService.create(TagService, this);

    const searchAlbums = this.wrap<[dto: GetAlbumsDto]>((authDto, ctx, args) => albumService.getAll(authDto, ...args));
    const createAlbum = this.wrap<[dto: CreateAlbumDto]>((authDto, ctx, args) => albumService.create(authDto, ...args));
    const addAssetsToAlbum = this.wrap<[id: string, dto: BulkIdsDto]>((authDto, ctx, args) =>
      albumService.addAssets(authDto, ...args),
    );
    // ponytail: legacy host-function name — the packages/plugin-core wasm still imports
    // albumAddAssets, and wasm instantiation fails (hanging plugin load) if any import is
    // missing. Drop when plugin-core/plugin-sdk are ported to the upstream host API.
    const albumAddAssets = addAssetsToAlbum;
    const addAssetsToAlbums = this.wrap<[dto: AlbumsAddAssetsDto]>((authDto, ctx, args) =>
      albumService.addAssetsToAlbums(authDto, ...args),
    );
    const httpRequest = this.wrap<
      [
        url: string,
        options?: {
          method?: string;
          headers?: Record<string, string>;
          body?: string;
        },
      ]
    >(async (authDto, context, args) => {
      const allowedHosts = context.allowedHosts.map(
        (pattern) =>
          new RegExp(
            `^${pattern
              .split('*')
              .map((part) => part.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`))
              .join('.*')}$`,
            'i',
          ),
      );
      let url = new URL(args[0]);
      const headers = new Headers(args[1]?.headers);
      const options: RequestInit = { ...args[1], headers, redirect: 'manual' };

      for (let redirects = 0; redirects <= 20; redirects++) {
        if (allowedHosts.every((pattern) => !pattern.test(url.hostname))) {
          throw new Error('Hostname did not match any listed in methods[].allowedHosts in the plugin manifest');
        }
        const res = await fetch(url.href, options);
        const location = res.headers.get('location');
        if (![301, 302, 303, 307, 308].includes(res.status) || !location) {
          return { ok: res.ok, status: res.status, body: await res.text() };
        }
        await res.body?.cancel();
        const next = new URL(location, url);
        if (next.origin !== url.origin) {
          headers.delete('authorization');
          headers.delete('proxy-authorization');
          headers.delete('cookie');
        }
        const method = (options.method ?? 'GET').toUpperCase();
        if (
          (res.status === 303 && method !== 'GET' && method !== 'HEAD') ||
          ((res.status === 301 || res.status === 302) && method === 'POST')
        ) {
          options.method = 'GET';
          options.body = undefined;
          headers.delete('content-type');
          headers.delete('content-length');
        }
        url = next;
      }
      throw new Error('Too many plugin HTTP redirects');
    });
    const bulkTagAssets = this.wrap<[dto: TagBulkAssetsDto]>((authDto, ctx, args) =>
      tagService.bulkTagAssets(authDto, ...args),
    );

    const functions = {
      searchAlbums,
      createAlbum,
      addAssetsToAlbum,
      albumAddAssets,
      addAssetsToAlbums,
      httpRequest,
      bulkTagAssets,
    };

    const stubs: typeof functions = {
      searchAlbums: dummy,
      createAlbum: dummy,
      addAssetsToAlbum: dummy,
      albumAddAssets: dummy,
      addAssetsToAlbums: dummy,
      httpRequest: dummy,
      bulkTagAssets: dummy,
    };

    const plugins = await this.pluginRepository.getForLoad();
    for (const { id, name, version, wasmBytes, methods } of plugins) {
      const isMethod = methods.some(({ hostFunctions }) => !hostFunctions);
      if (isMethod) {
        const label = `${name}@${version}`;
        const key = this.getPluginKey({ id, hostFunctions: false });
        try {
          await this.pluginRepository.load({ key, label, wasmBytes }, { runInWorker: false, functions: stubs });
          this.logger.log(`Loaded plugin: ${label}`);
        } catch (error) {
          this.logger.error(`Unable to load plugin ${label} (${id})`, error);
        }
      }

      const isMethodWithFunction = methods.some(({ hostFunctions }) => hostFunctions);
      if (isMethodWithFunction) {
        const label = `${name}@${version}/worker`;
        const key = this.getPluginKey({ id, hostFunctions: true });
        try {
          await this.pluginRepository.load({ key, label, wasmBytes }, { runInWorker: true, functions });
          this.logger.log(`Loaded plugin with host functions: ${label}`);
        } catch (error) {
          this.logger.error(`Unable to load plugin with host functions ${label} (${id})`, error);
        }
      }
    }
  }

  private getPluginKey({ id, hostFunctions }: { id: string; hostFunctions: boolean }) {
    return id + (hostFunctions ? '/worker' : '');
  }

  private wrap<T>(fn: (authDto: AuthDto, context: HostContext, args: T) => Promise<unknown>) {
    return async (plugin: CurrentPlugin, offset: bigint) => {
      try {
        const handle = plugin.read(offset);
        if (!handle) {
          return plugin.store(
            JSON.stringify({ success: false, status: 400, message: 'Called host function without input' }),
          );
        }

        const { authToken, args } = handle.json() as { authToken: string; args: T };
        if (!authToken) {
          throw new Error('authToken is required');
        }

        const context = plugin.hostContext<HostContext>();
        const authDto = this.validate(authToken);
        const response = await fn(authDto, context, args);

        return plugin.store(JSON.stringify({ success: true, response }));
      } catch (error: any) {
        if (error instanceof HttpException) {
          this.logger.error(`Plugin host exception: ${error}`);
          return plugin.store(
            JSON.stringify({ success: false, status: error.getStatus(), message: error.getResponse() }),
          );
        }

        this.logger.error(`Plugin host exception: ${error}`, error?.stack);

        return plugin.store(
          JSON.stringify({
            success: false,
            status: 500,
            message: `Internal server error: ${error}`,
          }),
        );
      }
    };
  }

  private async importFolders(installFolder: string): Promise<void> {
    try {
      const entries = await this.storageRepository.readdirWithTypes(installFolder);
      for (const entry of entries) {
        if (!entry.isDirectory()) {
          continue;
        }

        await this.importFolder(join(installFolder, entry.name));
      }
    } catch (error) {
      this.logger.error(`Failed to import plugins folder ${installFolder}:`, error);
    }
  }

  private async importFolder(folder: string, options?: { force?: boolean }) {
    try {
      const manifestPath = join(folder, 'manifest.json');
      const bytes = await this.storageRepository.readFile(manifestPath);
      const contents = bytes.toString('utf8');
      const dto = JSON.parse(contents);
      const result = PluginManifestDto.schema.safeParse(dto);
      if (!result.success) {
        const issues = result.error.issues.map((issue) => `  - [${issue.path.join('.')}] ${issue.message}`).join('\n');
        this.logger.warn(`Invalid plugin manifest at ${manifestPath}:\n${issues}`);
        return;
      }
      const manifest = result.data;

      const existing = await this.pluginRepository.getByName(manifest.name);
      const wasmPath = `${folder}/${manifest.wasmPath}`;
      const wasmBytes = await this.storageRepository.readFile(wasmPath);
      // Keep the bundled API version compatible while detecting changes to its implementation.
      const sha256hash = this.cryptoRepository.hashSha256(`${contents}\0${wasmBytes.toString('base64')}`) as Buffer;

      if (!options?.force) {
        const match = await this.pluginRepository.getByHash(sha256hash);
        if (match) {
          this.logger.log(`Plugin up to date (name=${match.name}@${match.version}, hash=${sha256hash.toString('hex')}`);
          return;
        }
      }

      const plugin = await this.pluginRepository.upsert(
        {
          // NOTE: new properties here need to be added to the on conflict clause in the repository
          enabled: true,
          name: manifest.name,
          title: manifest.title,
          description: manifest.description,
          author: manifest.author,
          version: manifest.version,
          templates: manifest.templates,
          wasmBytes,
          sha256hash,
        },
        manifest.methods,
      );

      if (existing) {
        this.logger.log(
          `Upgraded plugin ${manifest.name} (${plugin.methods.length} methods) from ${existing.version} to ${manifest.version} `,
        );
      } else {
        this.logger.log(
          `Imported plugin ${manifest.name}@${manifest.version} (${plugin.methods.length} methods) from ${folder}`,
        );
      }

      return manifest;
    } catch {
      this.logger.warn(`Failed to import plugin from ${folder}:`);
    }
  }

  private validate(authToken: string): AuthDto {
    try {
      const jwt = this.cryptoRepository.verifyJwt<{ userId: string }>(authToken, this.jwtSecret);
      if (!jwt.userId) {
        throw new UnauthorizedException('Invalid token: missing userId');
      }

      // Synthesized plugin auth always denies access to suppressed content.
      // Without this, host functions like albumAddAssets would let a plugin
      // move an owner's NSFW/hidden asset into a shared album, bypassing the
      // per-job workflow eligibility gate.
      return {
        user: {
          id: jwt.userId,
        },
        hideNsfwAssets: true,
      } as AuthDto;
    } catch (error) {
      this.logger.error('Token validation failed:', error);
      throw new UnauthorizedException('Invalid token');
    }
  }

  private sign(userId: string) {
    return this.cryptoRepository.signJwt({ userId }, this.jwtSecret);
  }

  /**
   * Workflows trigger off `AssetMetadataExtracted` rather than `AssetCreate`.
   * `AssetCreate` fires before metadata extraction and (when NSFW detection is
   * configured) before classification. Triggering at extraction time avoids a
   * fail-open window where a freshly-uploaded NSFW asset could reach plugins
   * before its `asset_metadata.MlEnrichment` row exists. Both the AssetCreate
   * and AssetMetadataExtraction workflow triggers therefore fire here, behind
   * the same eligibility gate.
   */
  @OnEvent({ name: 'AssetMetadataExtracted' })
  async onAssetMetadataExtracted({ userId, assetId, source }: ArgOf<'AssetMetadataExtracted'>) {
    // prevent loops
    // TODO loop detection in job service directly
    if (source === 'sidecar-write') {
      return;
    }

    // Either NSFW detection OR image-description can flag an asset as NSFW
    // (description.safety.is_nsfw_likely flows through nsfwAssetIdExists). If
    // EITHER is enabled, require the asset to be enriched so the workflow gate
    // never fires before the NSFW signal lands.
    const { machineLearning } = await this.getConfig({ withCache: true });
    const requireEnrichment = machineLearning.nsfwDetection.enabled || machineLearning.imageDescription.enabled;
    if (!(await this.workflowRepository.isWorkflowEligible(assetId, { requireEnrichment }))) {
      return;
    }

    await this.onAssetTrigger({ userId, assetId, trigger: WorkflowTrigger.AssetCreate });
    await this.onAssetTrigger({ userId, assetId, trigger: WorkflowTrigger.AssetMetadataExtraction });
  }

  @OnEvent({ name: 'AssetTag' })
  onAssetTagged({ assetId, userId }: ArgOf<'AssetTag'>) {
    return this.onAssetTrigger({ userId, assetId, trigger: WorkflowTrigger.AssetTagged });
  }

  private async onAssetTrigger({ userId, assetId, trigger }: AssetTrigger) {
    // paused workflows get no job at all; one paused after this still skips at run time
    const items = await this.workflowRepository.search({ userId, trigger, enabled: true });
    await this.jobRepository.queueAll(
      items.map((workflow) => ({
        name: JobName.WorkflowAssetTrigger,
        // FL-179: fixed when queued, so a replay of this job continues the same run and its completed steps
        data: { workflowId: workflow.id, assetId, runId: crypto.randomUUID(), executionId: crypto.randomUUID() },
      })),
    );
  }

  /**
   * FL-179: completed steps are kept long enough for a stalled job to be replayed, then forgotten
   * as part of the nightly database cleanup. A failure waits for the next night.
   */
  @OnEvent({ name: 'NightlyDatabaseCleanup' })
  async onNightlyDatabaseCleanup() {
    try {
      const before = new Date(Date.now() - WORKFLOW_RUN_STEP_RETENTION_DAYS * 24 * 60 * 60 * 1000);
      const deleted = await this.workflowRepository.deleteCompletedStepsBefore(before);
      if (deleted > 0) {
        this.logger.debug(`Forgot ${deleted} completed workflow steps no replay can need`);
      }
    } catch (error: any) {
      this.logger.warn(`Workflow step cleanup deferred: ${error}`);
    }
  }

  @OnJob({ name: JobName.WorkflowAssetTrigger, queue: QueueName.Workflow })
  handleAssetTrigger(job: JobOf<JobName.WorkflowAssetTrigger>) {
    const { assetId } = job;
    return this.execute(job, [assetId], (type) => {
      const assetService = BaseService.create(AssetService, this);

      switch (type) {
        case WorkflowType.AssetV1: {
          return {
            read: async () => {
              const asset = await this.workflowRepository.getForAssetV1(assetId);
              // Kysely returns timestamp columns from `jsonObjectFrom` as ISO strings,
              // but the SDK declares them as Date. The runtime contract is fine for
              // plugin authors (Date constructors accept ISO strings); this cast just
              // bridges the type mismatch in upstream's `AssetV1` declaration.
              return {
                data: { asset } as unknown as WorkflowEventData<typeof type>,
                authUserId: asset.ownerId,
                entityId: asset.id,
              };
            },
            write: async (auth, changes) => {
              const asset = changes.asset;
              if (!asset) {
                return;
              }

              await assetService.update(auth, assetId, {
                isFavorite: asset.isFavorite,
                visibility: asset.visibility,
                dateTimeOriginal: asset.exifInfo?.dateTimeOriginal ?? undefined,
                // TODO allow setting to null
                longitude: asset.exifInfo?.longitude ?? undefined,
                // TODO allow setting to null
                latitude: asset.exifInfo?.latitude ?? undefined,
                // TODO allow setting to null
                description: asset.exifInfo?.description ?? undefined,
                rating: asset.exifInfo?.rating,
              });
            },
          } satisfies ExecuteOptions<typeof type>;
        }
      }
    });
  }

  /**
   * Why a stored workflow cannot run completely on this server right now, if it cannot (FL-82).
   *
   * Every step of the definition must be provided by an enabled plugin, fit the trigger and have
   * valid parameters, and every enabled step must be present as a runnable step. A plugin upgrade
   * that drops a method deletes its runnable steps; without this check the rest of the workflow
   * would run without them — an action without the filter meant to limit it.
   */
  private async getRunProblem(workflow: RunnableWorkflow): Promise<string | undefined> {
    const methods = await this.pluginRepository.getForValidation();
    const definition =
      workflow.definition ??
      definitionFromSteps(
        workflow.trigger,
        workflow.steps.map((step) => ({ ...step, enabled: true })),
      );
    const [issue] = workflowIssues(definition, methods);
    if (issue) {
      return issue.message;
    }
    const expected = definition.steps.filter((step) => step.enabled).map((step) => step.id);
    const runnable = workflow.steps.map((step) => step.id);
    if (expected.length !== runnable.length || expected.some((id, index) => id !== runnable[index])) {
      return 'Some steps are not ready to run. Open this workflow and save it again.';
    }
  }

  /**
   * Central choke point for every workflow trigger handler. Any new
   * `WorkflowTrigger` value with an `@OnJob` handler MUST route through here,
   * passing the set of asset ids whose data will be exposed to the plugin.
   * The privacy gate (`isWorkflowEligible`) runs once per asset before any
   * read/write callback is invoked, so individual handlers can't forget it.
   *
   * A run is one durable job. A failed step gets one automatic retry, starting at that step (the
   * steps before it already applied), then only manual retries. Pausing or deleting the workflow
   * cancels runs that have not started, including a pending retry; a step already running finishes.
   * Once a step has run, the job never throws (FL-169), so "Retry failed" cannot replay applied steps.
   *
   * FL-179: a job whose worker stopped is replayed with the same data. Each completed step is recorded
   * under the job's `executionId`, outside the job data, and a replay skips the recorded steps (and
   * stops where a recorded step stopped the run). An automatic or manual retry is a newly queued job
   * with its own `executionId`: a manual retry from run history runs every step again.
   */
  private async execute<T extends WorkflowType>(
    job: JobOf<JobName.WorkflowAssetTrigger>,
    assetIds: string[],
    getHandler: (type: T) => ExecuteOptions<T> | undefined,
  ): Promise<JobStatus | undefined> {
    const { workflowId, assetId } = job;
    const workflow = await this.workflowRepository.getForWorkflowRun(workflowId);
    if (!workflow) {
      return;
    }

    const { machineLearning } = await this.getConfig({ withCache: true });
    // Match `onAssetMetadataExtracted` — either NSFW OR description can flag NSFW.
    const requireEnrichment = machineLearning.nsfwDetection.enabled || machineLearning.imageDescription.enabled;
    for (const id of assetIds) {
      if (!(await this.workflowRepository.isWorkflowEligible(id, { requireEnrichment }))) {
        return JobStatus.Skipped;
      }
    }

    const runId = job.runId ?? crypto.randomUUID();
    const attempt = job.attempt ?? 0;
    type RunLogEntry = Omit<WorkflowRunLog, 'workflowId' | 'runId' | 'attempt' | 'triggerDataId'>;
    const log = async (entry: RunLogEntry) => {
      if (workflow.logging) {
        await this.workflowRepository.log({ ...entry, workflowId, runId, attempt, triggerDataId: assetId });
      }
    };
    // FL-169: once a step has run, its changes are applied while the job's data still starts the run
    // over. From then on nothing may throw out of the job: a thrown error records it as failed, and
    // "Retry failed" in the Job manager would run the applied steps again. Run history written after
    // that point is therefore logged, not rethrown, when it cannot be saved.
    const record = async (entry: RunLogEntry) => {
      try {
        await log(entry);
      } catch (error: any) {
        this.logger.error(
          `Unable to save the ${entry.result} result of workflow ${workflowId} run ${runId} (attempt ${attempt}): ${error}`,
          error?.stack,
        );
      }
    };

    const problem = await this.getRunProblem(workflow);
    if (problem) {
      this.logger.warn(`Workflow ${workflowId} was not run: ${problem}`);
      await log({ result: WorkflowResult.Error, errorCode: WorkflowRunErrorCode.Unsupported, error: problem });
      return JobStatus.Skipped;
    }

    // Track only configuration this run successfully persisted. Reloading the latest definition here
    // would also trust an owner's intervening edit and could skip a newly restrictive filter.
    const expectedDefinition = structuredClone(definitionOf(workflow));
    let steps = workflow.steps;
    if (job.fromStepId) {
      if (!job.definitionSha256 || job.definitionSha256 !== definitionSha256(expectedDefinition)) {
        await log({
          result: WorkflowResult.Error,
          errorCode: WorkflowRunErrorCode.Unsupported,
          error: 'The workflow changed before its retry, so the retry was not run.',
        });
        return JobStatus.Skipped;
      }
      const index = steps.findIndex((step) => step.id === job.fromStepId);
      if (index === -1) {
        await log({
          result: WorkflowResult.Error,
          errorCode: WorkflowRunErrorCode.Unsupported,
          error: 'The workflow changed before its retry, so the retry was not run.',
        });
        return JobStatus.Skipped;
      }
      steps = steps.slice(index);
    }

    // TODO infer from steps
    let type: T | undefined;
    for (const targetType of Object.values(WorkflowType)) {
      const isMissing = workflow.steps.some((step) => !step.types.includes(targetType));
      if (!isMissing) {
        type = targetType as unknown as T;
        break;
      }
    }

    if (!type) {
      throw new Error('Unable to infer workflow event type from steps');
    }

    const handler = getHandler(type);
    if (!handler) {
      this.logger.error(`Misconfigured workflow ${workflowId}: no handler for type ${type}`);
      return;
    }

    // FL-179: the steps an earlier run of this same job completed before its worker stopped
    const { executionId } = job;
    const completedSteps = executionId
      ? await this.workflowRepository.getCompletedSteps(executionId)
      : new Map<string, { halted: boolean }>();

    const { read, write } = handler;
    const readResult = await read(type);
    let data = readResult.data;

    let haltedStepId: string | undefined;
    for (const [index, step] of steps.entries()) {
      const definitionStep = expectedDefinition.steps.find((item) => item.id === step.id);
      const completed = completedSteps.get(step.id);
      if (completed) {
        this.logger.debug(`Workflow ${workflowId} run ${runId} already completed step ${step.id}; skipping it`);
        if (completed.halted) {
          haltedStepId = step.id;
          break;
        }
        continue;
      }
      // FL-169: set once the step's changes are written; a later failure in the step must not run it again
      let applied = false;
      let halts = false;
      try {
        const payload: WorkflowEventPayload<typeof type> = {
          trigger: workflow.trigger,
          type,
          config: step.config ?? {},
          workflow: {
            id: workflowId,
            authToken: this.sign(readResult.authUserId),
            stepId: step.id,
          },
          data,
        };
        const context: HostContext = {
          allowedHosts: step.allowedHosts,
        };

        if (step.methodName.startsWith('noop')) {
          continue;
        }

        const result = await this.pluginRepository.callMethod<WorkflowResponse<T>>(
          {
            pluginKey: this.getPluginKey({ id: step.pluginId, hostFunctions: step.hostFunctions }),
            methodName: step.methodName,
          },
          payload,
          context,
        );
        halts = !(result?.workflow?.continue ?? true);
        if (result?.changes) {
          await write(
            {
              user: {
                id: readResult.authUserId,
              },
              session: {
                id: DummyValue.UUID,
                hasElevatedPermission: true,
              },
            } as AuthDto,
            result.changes,
          );
        }
        // The step has run and its changes are written. Reading the data back and saving the step's
        // own config can still fail; the automatic retry then resumes after this step.
        applied = true;
        // FL-179: recorded outside the job, so a replay of this job does not run the step again
        if (executionId) {
          await this.workflowRepository.completeStep({ executionId, workflowId, stepId: step.id, halted: halts });
        }
        if (result?.changes) {
          ({ data } = await read(type));
        }

        if (result?.config) {
          await this.workflowRepository.updateStepConfig(workflowId, step.id, result.config);
          if (definitionStep) {
            definitionStep.config = structuredClone(result.config);
          }
        }

        // The halt is recorded after the loop: in here, a record that failed to save would be taken
        // for a failed step, and the automatic retry would run this finished step again.
        if (halts) {
          haltedStepId = step.id;
          break;
        }
      } catch (error) {
        this.logger.error(`Error executing workflow ${workflowId} run ${runId} (attempt ${attempt}):`, error);

        // Imported definitions keep fields this server does not use; a credential can sit there as
        // well as in the step's parameters, so both are scrubbed from what run history keeps.
        const message = redactRunError(error instanceof Error ? error.message : String(error), {
          config: step.config ?? null,
          stepExtra: definitionStep?.extra ?? null,
          workflowExtra: expectedDefinition.extra ?? null,
        });
        await record({
          result: WorkflowResult.Error,
          workflowStepId: step.id,
          errorCode: WorkflowRunErrorCode.StepFailed,
          error: message,
        });

        // A step that failed before its changes were written runs again. One whose changes were written
        // is not repeated: the retry resumes at the next step, and there is none when this step was the
        // last or asked the run to stop.
        let retryFromStepId: string | undefined = step.id;
        if (applied) {
          retryFromStepId = halts ? undefined : steps[index + 1]?.id;
        }
        if (attempt === 0 && !job.manual && retryFromStepId) {
          try {
            await this.jobRepository.queue({
              name: JobName.WorkflowAssetTrigger,
              data: {
                workflowId,
                assetId,
                runId,
                attempt: 1,
                fromStepId: retryFromStepId,
                definitionSha256: definitionSha256(expectedDefinition),
                executionId: crypto.randomUUID(),
              },
            });
          } catch (queueError: any) {
            // Without its automatic retry the run stays failed; the owner can retry it from run history.
            this.logger.error(
              `Unable to queue the automatic retry of workflow ${workflowId} run ${runId} from step ${retryFromStepId}: ${queueError}`,
              queueError?.stack,
            );
          }
        }

        return JobStatus.Failed;
      }
    }

    if (haltedStepId) {
      await record({ result: WorkflowResult.Halted, workflowStepId: haltedStepId });
      this.logger.debug(`Workflow ${workflowId} run ${runId} stopped on step ${haltedStepId}`);
      return;
    }

    await record({ result: WorkflowResult.Completed });
    this.logger.debug(`Workflow ${workflowId} run ${runId} executed successfully`);
  }
}
