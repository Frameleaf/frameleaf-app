import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { cloneDeep, isEqual, omit } from 'lodash-es';
import type { ArgOf } from 'src/repositories/event.repository.js';
import { OnEvent } from 'src/decorators.js';
import {
  AdminConfigDto,
  PublicConfigDto,
  SystemConfig,
  UserConfigDto,
  defaults,
  mapAdminConfig,
  mapPublicConfig,
  mapUserConfig,
} from 'src/dtos/config.dto.js';
import {
  AdminConfigRevisionResponseDto,
  AdminConfigRevisionUpdateDto,
  ImageDescriptionRequeueEstimateDto,
  ImageDescriptionRequeueResponseDto,
  SmartAlbumReevaluateEstimateDto,
  SmartAlbumReevaluateRequestDto,
  SmartAlbumReevaluateResponseDto,
} from 'src/dtos/system-config.dto.js';
import {
  BootstrapEventPriority,
  DatabaseLock,
  JobName,
  MlDestinationKind,
  QueueName,
  SystemMetadataKey,
} from 'src/enum.js';
import {
  MachineLearningHardwareResponse,
  defaultMachineLearningHardware,
} from 'src/repositories/machine-learning.repository.js';
import { BaseService } from 'src/services/base.service.js';
import { SYSTEM_CONFIG_CHANGED_MESSAGE, clearConfigCache, getConfigRevision } from 'src/utils/config.js';
import { isImageDescriptionEnabled } from 'src/utils/misc.js';
import { resolveEndpoint } from 'src/utils/ml-destination.js';
import { toPlainObject } from 'src/utils/object.js';

/** Default per-asset estimate when no telemetry data is available. */
const DEFAULT_SECONDS_PER_ASSET = 1.5;

/**
 * Back-compat-aware mode resolver. Mirrors `RunPodService.effectiveMode`:
 * legacy configs may have `enabled: true` while `mode` is still 'disabled'
 * (the field didn't exist before this PR). Such configs are treated as Pod
 * mode — otherwise the "terminate the pod first" guard would be bypassed and
 * a billable resource orphaned.
 */
const effectiveRunPodMode = (rp: { mode?: string; enabled: boolean }): 'disabled' | 'pod' | 'serverless' =>
  rp.mode && rp.mode !== 'disabled' ? (rp.mode as 'pod' | 'serverless') : rp.enabled ? 'pod' : 'disabled';

@Injectable()
export class SystemConfigService extends BaseService {
  @OnEvent({ name: 'AppBootstrap', priority: BootstrapEventPriority.SystemConfig })
  async onBootstrap() {
    const config = await this.getConfig({ withCache: false });
    await this.eventRepository.emit('ConfigInit', { newConfig: config });
  }

  async getAdminConfig(): Promise<AdminConfigDto> {
    const config = await this.getConfig({ withCache: false });
    return mapAdminConfig(config);
  }

  getAdminConfigDefaults(): AdminConfigDto {
    return mapAdminConfig(defaults);
  }

  async getUserConfig(): Promise<UserConfigDto> {
    const config = await this.getConfig({ withCache: false });
    return mapUserConfig(config);
  }

  getUserConfigDefaults(): UserConfigDto {
    return mapUserConfig(defaults);
  }

  async getPublicConfig(): Promise<PublicConfigDto> {
    const config = await this.getConfig({ withCache: false });
    return mapPublicConfig(config);
  }

  getPublicConfigDefaults(): PublicConfigDto {
    return mapPublicConfig(defaults);
  }

  /**
   * Hardware of one explicit destination. Without an id, the first enabled local
   * destination is probed; if there is none the defaults are returned. A cloud destination
   * is reached only when its id is named (FL-110).
   */
  async getMachineLearningHardware(destinationId?: string): Promise<MachineLearningHardwareResponse> {
    const destination = destinationId
      ? await this.mlDestinationRepository.getById(destinationId)
      : (await this.mlDestinationRepository.getAll()).find(
          (row) => row.kind === MlDestinationKind.Local && row.enabled,
        );
    if (!destination) {
      if (destinationId) {
        throw new NotFoundException(`Machine learning destination ${destinationId} does not exist`);
      }
      return defaultMachineLearningHardware;
    }
    const endpoint = resolveEndpoint(destination, this.machineLearningRepository.getRunPodEndpoint());
    if (!endpoint) {
      return defaultMachineLearningHardware;
    }
    return this.machineLearningRepository.getHardware(endpoint);
  }

  @OnEvent({ name: 'ConfigInit', priority: -100 })
  onConfigInit({ newConfig: { logging, machineLearning } }: ArgOf<'ConfigInit'>) {
    const { logLevel: envLevel } = this.configRepository.getEnv();
    const configLevel = logging.enabled ? logging.level : false;
    const level = envLevel ?? configLevel;
    this.logger.setLogLevel(level);
    this.logger.log(`LogLevel=${level} ${envLevel ? '(set via IMMICH_LOG_LEVEL)' : '(set via system config)'}`);

    this.machineLearningRepository.setup(machineLearning);
  }

  @OnEvent({ name: 'ConfigUpdate', server: true })
  onConfigUpdate({ newConfig }: ArgOf<'ConfigUpdate'>) {
    this.onConfigInit({ newConfig });
    clearConfigCache();
  }

  @OnEvent({ name: 'ConfigValidate' })
  async onConfigValidate({ newConfig, oldConfig }: ArgOf<'ConfigValidate'>) {
    const { logLevel } = this.configRepository.getEnv();
    if (logLevel && !isEqual(toPlainObject(newConfig.logging), oldConfig.logging)) {
      throw new Error('Logging cannot be changed while the environment variable IMMICH_LOG_LEVEL is set.');
    }

    const { physicalDeduplication } = newConfig;
    if (physicalDeduplication.enabled) {
      if (!physicalDeduplication.masterUserId) {
        throw new Error('Physical deduplication requires a master user.');
      }

      const masterUser = await this.userRepository.get(physicalDeduplication.masterUserId, {});
      if (!masterUser || masterUser.deletedAt) {
        throw new Error('Physical deduplication master user must exist and be active.');
      }
    }

    const oldRunpod = oldConfig.machineLearning.runpod;
    const newRunpod = newConfig.machineLearning.runpod;
    const oldEffective = effectiveRunPodMode(oldRunpod);
    const newEffective = effectiveRunPodMode(newRunpod);
    const sensitiveChange =
      oldRunpod.apiKey !== newRunpod.apiKey ||
      oldRunpod.imageName !== newRunpod.imageName ||
      oldEffective !== newEffective;
    if (sensitiveChange) {
      const runpodState = await this.systemMetadataRepository.get(SystemMetadataKey.RunPodState);
      const inFlight =
        runpodState && ['provisioning', 'starting', 'stopping', 'serverless-provisioning'].includes(runpodState.status);
      if (inFlight) {
        throw new Error(
          `Cannot change RunPod API key, image, or mode while a transition is in flight (status=${runpodState!.status}). Wait for it to settle, then retry.`,
        );
      }
      // Block switching FROM Pod mode WHILE a pod is running. The admin must
      // terminate the pod first — otherwise we'd orphan a billable resource.
      if (
        oldEffective === 'pod' &&
        newEffective !== 'pod' &&
        runpodState &&
        ['running', 'stopped'].includes(runpodState.status)
      ) {
        throw new Error(
          `Terminate the running pod before switching modes (current pod status: ${runpodState.status}).`,
        );
      }
    }
  }

  /** FL-66: the saved settings with the revision the settings editor sends back on save. */
  async getAdminConfigWithRevision(): Promise<AdminConfigRevisionResponseDto> {
    const config = await this.readConfigForUpdate();
    return { config: mapAdminConfig(config), revision: getConfigRevision(config) };
  }

  /**
   * FL-66: save the settings editor's draft only when the saved settings still match the
   * revision it was made against; otherwise nothing changes and the editor keeps the draft (409).
   */
  async updateAdminConfigWithRevision({
    config,
    expectedRevision,
  }: AdminConfigRevisionUpdateDto): Promise<AdminConfigRevisionResponseDto> {
    const newConfig = await this.saveAdminConfig(config, expectedRevision);
    return { config: mapAdminConfig(newConfig), revision: getConfigRevision(newConfig) };
  }

  async updateAdminConfig(dto: AdminConfigDto): Promise<AdminConfigDto> {
    return mapAdminConfig(await this.saveAdminConfig(dto));
  }

  /**
   * One settings save (FL-66). The transaction boundary is the configuration itself.
   *
   * 1. The save is prepared and validated against the saved settings. Validators may reach the
   *    network (the SMTP check), so this happens before the lock; a draft made against older
   *    settings is refused here already.
   * 2. Under the settings lock, which every writer of the configuration holds, the saved settings
   *    are read again straight from storage. If they changed since step 1 a revisioned save is
   *    refused (409, nothing written); an unconditional save (older clients) is prepared and
   *    validated again against them. The write itself is one database transaction
   *    (ForkSchemaRepository.persistConfig). Two saves can never both pass the check.
   * 3. Resources that follow from settings (local machine learning destinations, smart album
   *    backfill, the RunPod serverless endpoint, queue concurrency) are reconciled afterwards by
   *    the ConfigUpdate listeners through their own services; a failure there never rolls the
   *    saved settings back.
   */
  private async saveAdminConfig(dto: AdminConfigDto, expectedRevision?: string): Promise<SystemConfig> {
    const { configFile } = this.configRepository.getEnv();
    if (configFile) {
      throw new BadRequestException('Cannot update configuration while IMMICH_CONFIG_FILE is in use');
    }

    const incoming = cloneDeep(toPlainObject(dto));
    let prepared = await this.prepareAdminConfig(cloneDeep(incoming), expectedRevision);

    const { oldConfig, newConfig } = await this.databaseRepository.withLock(
      DatabaseLock.SystemConfigUpdate,
      async () => {
        const current = await this.readConfigForUpdate();
        if (getConfigRevision(current) !== prepared.revision) {
          if (expectedRevision !== undefined) {
            throw new ConflictException(SYSTEM_CONFIG_CHANGED_MESSAGE);
          }
          prepared = await this.prepareAdminConfig(cloneDeep(incoming), undefined, current);
        }

        // The re-queue reminder is not part of the revision and may have moved since step 1.
        const description = prepared.config.machineLearning?.imageDescription;
        if (description) {
          const saved = current.machineLearning.imageDescription;
          description.pendingRequeueAt = saved.pendingRequeueAt;
          if (!prepared.descriptionChanged) {
            description.lastConfigChangeAt = saved.lastConfigChangeAt;
          }
        }

        return { oldConfig: current, newConfig: await this.updateConfig(prepared.config) };
      },
    );

    await this.eventRepository.emit('ConfigUpdate', { newConfig, oldConfig });

    return newConfig;
  }

  private async prepareAdminConfig(
    dto: AdminConfigDto,
    expectedRevision?: string,
    saved?: SystemConfig,
  ): Promise<{ config: AdminConfigDto; revision: string; descriptionChanged: boolean }> {
    const oldConfig = saved ?? (await this.readConfigForUpdate());
    const revision = getConfigRevision(oldConfig);
    if (expectedRevision !== undefined && revision !== expectedRevision) {
      throw new ConflictException(SYSTEM_CONFIG_CHANGED_MESSAGE);
    }

    // mapConfig redacts machineLearning.runpod.apiKey to '' on read. Mirror
    // the convention on write: an empty incoming apiKey means "preserve the
    // existing value" (the user didn't intend to rotate the key), not "wipe
    // the stored key". The user can clear the key by toggling RunPod off, or
    // by sending a different non-empty placeholder; sending the redacted
    // sentinel back unchanged must not destroy the real secret.
    const incomingRunpodKey = dto.machineLearning?.runpod?.apiKey;
    if (incomingRunpodKey === '' && oldConfig.machineLearning.runpod.apiKey !== '') {
      dto.machineLearning.runpod.apiKey = oldConfig.machineLearning.runpod.apiKey;
    }

    // Same preserve-on-empty semantics for the HuggingFace token forwarded to
    // the ML worker. mapConfig redacts it to '' on read; an empty incoming
    // value here means "keep the stored token" rather than "wipe it".
    const incomingHfToken = dto.machineLearning?.runpod?.hfToken;
    if (incomingHfToken === '' && oldConfig.machineLearning.runpod.hfToken !== '') {
      dto.machineLearning.runpod.hfToken = oldConfig.machineLearning.runpod.hfToken;
    }

    // The two timestamp fields below are server-managed (set by this service,
    // by the cost modal's defer endpoint, or by the re-queue trigger).
    // Inbound writes must not be allowed to clobber them — always overwrite
    // whatever the client sent with the stored values BEFORE comparing the
    // imageDescription block, then maybe bump lastConfigChangeAt below.
    if (dto.machineLearning?.imageDescription) {
      dto.machineLearning.imageDescription.pendingRequeueAt =
        oldConfig.machineLearning.imageDescription.pendingRequeueAt;
      dto.machineLearning.imageDescription.lastConfigChangeAt =
        oldConfig.machineLearning.imageDescription.lastConfigChangeAt;
    }

    // Bump lastConfigChangeAt when the imageDescription block changed, ignoring
    // the two server-managed timestamp fields themselves (otherwise we'd ratchet
    // the timestamp on every save). The bump happens BEFORE updateConfig() so
    // the new timestamp is persisted along with the rest of the config in a
    // single round-trip.
    const oldDescription = omit(oldConfig.machineLearning.imageDescription, ['pendingRequeueAt', 'lastConfigChangeAt']);
    const newDescription = omit(dto.machineLearning?.imageDescription ?? {}, [
      'pendingRequeueAt',
      'lastConfigChangeAt',
    ]);
    const descriptionChanged =
      !!dto.machineLearning?.imageDescription &&
      !isEqual(toPlainObject(oldDescription), toPlainObject(newDescription));
    if (descriptionChanged) {
      dto.machineLearning.imageDescription.lastConfigChangeAt = new Date().toISOString();
    }

    try {
      await this.eventRepository.emit('ConfigValidate', { newConfig: toPlainObject(dto), oldConfig });
    } catch (error) {
      this.logger.warn(`Unable to save system config due to a validation error: ${error}`);
      throw new BadRequestException(error instanceof Error ? error.message : error);
    }

    return { config: dto, revision, descriptionChanged };
  }

  async getCustomCss(): Promise<string> {
    const { theme } = await this.getConfig({ withCache: false });
    return theme.customCss;
  }

  async estimateDescriptionRequeue(): Promise<ImageDescriptionRequeueEstimateDto> {
    const { machineLearning } = await this.getConfig({ withCache: false });
    const stats = await this.assetRepository.getDescriptionStats();

    // Real per-job rolling-average duration, populated by the BullMQ Worker
    // `completed` listener in JobRepository. Resets on process restart; falls
    // back to the conservative default when the buffer is empty (cold start
    // or no completions yet). This reflects the user's actual hardware/model,
    // unlike the prior hardcoded 1.5s.
    const avgMs = this.jobRepository.getRollingAvgMs(JobName.ImageDescription);
    const rollingAvgSeconds = avgMs === null ? DEFAULT_SECONDS_PER_ASSET : avgMs / 1000;
    const estimatedTotalSeconds = stats.totalAssets * rollingAvgSeconds;

    return {
      totalAssets: stats.totalAssets,
      withDescription: stats.withDescription,
      withoutDescription: stats.withoutDescription,
      rollingAvgSeconds,
      estimatedTotalSeconds,
      activeBackend: machineLearning.imageDescription.acceleration,
      activeModel: machineLearning.imageDescription.modelName,
    };
  }

  async triggerDescriptionRequeue(): Promise<ImageDescriptionRequeueResponseDto> {
    const oldConfig = await this.getConfig({ withCache: false });
    const { machineLearning } = oldConfig;
    if (!isImageDescriptionEnabled(machineLearning)) {
      throw new BadRequestException('Image description is not enabled');
    }

    // BullMQ deduplication (set up in job.repository.ts) prevents double-enqueueing
    // the queue-all job. We surface the result to the caller so the UI can react.
    const counts = await this.jobRepository.getJobCounts(QueueName.ImageDescription);
    const alreadyInFlight = (counts.active ?? 0) + (counts.waiting ?? 0) > 0;

    if (!alreadyInFlight) {
      await this.jobRepository.queue({ name: JobName.ImageDescriptionQueueAll, data: { force: true } });

      // The deferred re-queue (if any) has now actually run. Clear the marker
      // so the persistent banner disappears. Direct metadata write — no event
      // emission, since this is a server-side bookkeeping bump that doesn't
      // change any user-visible config field.
      if (machineLearning.imageDescription.pendingRequeueAt) {
        await this.writeImageDescriptionTimestamps({ pendingRequeueAt: null });
      }
    }

    return { queued: !alreadyInFlight };
  }

  /**
   * Set pendingRequeueAt to "now" so the persistent banner can remind the
   * admin to re-queue later. Called by the cost modal's "Re-queue later"
   * button — a lightweight write that doesn't go through the full
   * updateSystemConfig path.
   */
  async deferDescriptionRequeue(): Promise<void> {
    const { machineLearning } = await this.getConfig({ withCache: false });
    if (!isImageDescriptionEnabled(machineLearning)) {
      throw new BadRequestException('Image description is not enabled');
    }

    await this.writeImageDescriptionTimestamps({ pendingRequeueAt: new Date().toISOString() });
  }

  /**
   * Direct write of one or both server-managed timestamps in the
   * imageDescription block, bypassing the validation-heavy full-config update
   * path. Used by:
   *   - deferDescriptionRequeue() — sets pendingRequeueAt
   *   - triggerDescriptionRequeue() — clears pendingRequeueAt on successful enqueue
   *
   * Re-emits ConfigUpdate so any caches (clearConfigCache) and listeners stay
   * in sync.
   */
  private async writeImageDescriptionTimestamps(timestamps: {
    pendingRequeueAt?: string | null;
    lastConfigChangeAt?: string | null;
  }): Promise<void> {
    // FL-66: under the settings lock, from the saved settings, so an administrator's save made in
    // between is never written back over.
    const { oldConfig, newConfig } = await this.updateConfigExclusively((config) => {
      Object.assign(config.machineLearning.imageDescription, timestamps);
    });
    await this.eventRepository.emit('ConfigUpdate', { newConfig, oldConfig });
  }

  async estimateSmartAlbumReevaluate(): Promise<SmartAlbumReevaluateEstimateDto> {
    const stats = await this.assetRepository.getDescriptionStats();
    return { totalAssets: stats.withDescription, withDescription: stats.withDescription };
  }

  async triggerSmartAlbumReevaluate(
    dto: SmartAlbumReevaluateRequestDto = {},
  ): Promise<SmartAlbumReevaluateResponseDto> {
    const { smartAlbums } = await this.getConfig({ withCache: false });
    if (!smartAlbums.enabled) {
      throw new BadRequestException('Smart albums are not enabled');
    }

    const kind = dto.kind;
    if (kind && !(kind in smartAlbums.builtIn)) {
      // Defensive — the zod enum should catch this at the controller, but a
      // belt-and-braces check guards against drift if config kinds expand
      // faster than the request schema.
      throw new BadRequestException(`Unknown smart-album kind: ${kind}`);
    }

    // The re-evaluate-all job runs on the shared BackgroundTask queue, so
    // getJobCounts would over-report. Instead, look up the BullMQ dedup id
    // directly to detect an in-flight job. Matching dedup id is set in
    // job.repository.ts getJobOptions() — kind-scoped dispatches have their
    // own namespace so they don't collide with each other or with all-kinds.
    const dedupId = kind ? `${JobName.SmartAlbumReevaluateAll}:${kind}` : JobName.SmartAlbumReevaluateAll;
    const alreadyInFlight = await this.jobRepository.hasDedupJob(QueueName.BackgroundTask, dedupId);

    if (!alreadyInFlight) {
      await this.jobRepository.queue({ name: JobName.SmartAlbumReevaluateAll, data: kind ? { kind } : undefined });
    }

    return { queued: !alreadyInFlight };
  }
}
