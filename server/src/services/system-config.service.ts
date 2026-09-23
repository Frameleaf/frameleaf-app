import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { cloneDeep, get, isEqual, omit, set } from 'lodash-es';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import type { ArgOf } from 'src/repositories/event.repository.js';
import { OnEvent } from 'src/decorators.js';
import { ConfigCredentialResponseDto, ConfigCredentialUpdateDto } from 'src/dtos/config-credential.dto.js';
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
  ImageDescriptionRequeueEstimateDto,
  ImageDescriptionRequeueResponseDto,
  SmartAlbumReevaluateEstimateDto,
  SmartAlbumReevaluateRequestDto,
  SmartAlbumReevaluateResponseDto,
} from 'src/dtos/system-config.dto.js';
import {
  BootstrapEventPriority,
  ConfigCredential,
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
import { clearConfigCache } from 'src/utils/config.js';
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

/** FL-67: where each write-only credential lives in the system configuration. */
const CREDENTIAL_PATHS: Record<ConfigCredential, string> = {
  [ConfigCredential.SmtpPassword]: 'notifications.smtp.transport.password',
  [ConfigCredential.OAuthClientSecret]: 'oauth.clientSecret',
  [ConfigCredential.RunPodApiKey]: 'machineLearning.runpod.apiKey',
  [ConfigCredential.HuggingFaceToken]: 'machineLearning.runpod.hfToken',
};

const CONFIG_FILE_IN_USE_MESSAGE = 'Cannot update configuration while IMMICH_CONFIG_FILE is in use';

const readCredential = (config: SystemConfig, name: ConfigCredential): string => {
  const value: unknown = get(config, CREDENTIAL_PATHS[name]);
  return typeof value === 'string' ? value : '';
};

/** The credentials whose stored value differs between two configurations. Only names leave this function. */
const changedCredentials = (oldConfig: SystemConfig, newConfig: SystemConfig) =>
  Object.values(ConfigCredential).filter((name) => readCredential(oldConfig, name) !== readCredential(newConfig, name));

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

  async updateAdminConfig(dto: AdminConfigDto, auth?: AuthDto): Promise<AdminConfigDto> {
    const { configFile } = this.configRepository.getEnv();
    if (configFile) {
      throw new BadRequestException(CONFIG_FILE_IN_USE_MESSAGE);
    }

    const oldConfig = await this.getConfig({ withCache: false });

    // FL-67: the SMTP password and the OAuth client secret are redacted on read like the RunPod
    // key below, so an empty value coming back means "keep the stored secret". Clearing one is an
    // explicit action: DELETE /admin/config/credentials/:name.
    if (dto.notifications?.smtp?.transport?.password === '') {
      dto.notifications.smtp.transport.password = oldConfig.notifications.smtp.transport.password;
    }
    if (dto.oauth?.clientSecret === '') {
      dto.oauth.clientSecret = oldConfig.oauth.clientSecret;
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
    if (
      dto.machineLearning?.imageDescription &&
      !isEqual(toPlainObject(oldDescription), toPlainObject(newDescription))
    ) {
      dto.machineLearning.imageDescription.lastConfigChangeAt = new Date().toISOString();
    }

    try {
      await this.eventRepository.emit('ConfigValidate', { newConfig: toPlainObject(dto), oldConfig });
    } catch (error) {
      this.logger.warn(`Unable to save system config due to a validation error: ${error}`);
      throw new BadRequestException(error instanceof Error ? error.message : error);
    }

    const newConfig: SystemConfig = await this.updateConfig(dto);

    await this.eventRepository.emit('ConfigUpdate', { newConfig, oldConfig });

    // A client that still sends a secret through the whole configuration (an older script or a
    // configuration import) is accepted for compatibility, and recorded like the explicit action.
    for (const name of changedCredentials(oldConfig, newConfig)) {
      this.recordCredentialChange(auth, name, readCredential(newConfig, name) ? 'replaced' : 'cleared');
    }

    return mapAdminConfig(newConfig);
  }

  /** FL-67: whether each write-only credential is stored. Values are never returned. */
  async getCredentials(): Promise<ConfigCredentialResponseDto[]> {
    const config = await this.getConfig({ withCache: false });
    return Object.values(ConfigCredential).map((name) => ({ name, configured: readCredential(config, name) !== '' }));
  }

  /** FL-67: replace one credential. The value is stored as sent and never returned or logged. */
  setCredential(auth: AuthDto, name: ConfigCredential, dto: ConfigCredentialUpdateDto) {
    return this.writeCredential(auth, name, dto.value);
  }

  /** FL-67: clear one credential, so the feature that used it stops authenticating. */
  clearCredential(auth: AuthDto, name: ConfigCredential) {
    return this.writeCredential(auth, name, '');
  }

  /**
   * Changes exactly one credential through the same validation and update events as a whole
   * configuration save (so SMTP is verified with the new password and a RunPod transition in
   * flight still blocks a key change), without the value ever passing through a client draft.
   */
  private async writeCredential(
    auth: AuthDto,
    name: ConfigCredential,
    value: string,
  ): Promise<ConfigCredentialResponseDto> {
    const { configFile } = this.configRepository.getEnv();
    if (configFile) {
      throw new BadRequestException(CONFIG_FILE_IN_USE_MESSAGE);
    }

    const oldConfig = await this.getConfig({ withCache: false });
    if (readCredential(oldConfig, name) === value) {
      return { name, configured: value !== '' };
    }

    // Without its key a running pod or serverless endpoint could no longer be stopped or torn
    // down, and it would keep costing money. RunPod is turned off first.
    if (
      name === ConfigCredential.RunPodApiKey &&
      value === '' &&
      effectiveRunPodMode(oldConfig.machineLearning.runpod) !== 'disabled'
    ) {
      throw new BadRequestException('Turn RunPod off before clearing its API key.');
    }

    const newConfig = cloneDeep(oldConfig);
    set(newConfig, CREDENTIAL_PATHS[name], value);

    try {
      await this.eventRepository.emit('ConfigValidate', { newConfig, oldConfig });
    } catch (error) {
      this.logger.warn(`Unable to change the ${name} credential due to a validation error: ${error}`);
      throw new BadRequestException(error instanceof Error ? error.message : error);
    }

    const updated: SystemConfig = await this.updateConfig(newConfig);
    await this.eventRepository.emit('ConfigUpdate', { newConfig: updated, oldConfig });
    this.recordCredentialChange(auth, name, value ? 'replaced' : 'cleared');

    return { name, configured: readCredential(updated, name) !== '' };
  }

  /**
   * FL-67 audit hook for credential changes: names the credential, the change and the actor, and
   * never the value. FL-76's `admin_audit_event` (branch codex/FL-76-account-history, not on this
   * base) records changes against one account; when it can hold server-scoped events, send these
   * through `BaseService.recordAdminEvents` as well. Until then the server log is the record.
   */
  private recordCredentialChange(auth: AuthDto | undefined, name: ConfigCredential, change: 'replaced' | 'cleared') {
    this.logger.log(`Server credential ${name} ${change}${auth ? ` by ${auth.user.id}` : ''}`);
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
    const oldConfig = await this.getConfig({ withCache: false });
    const newConfig: SystemConfig = {
      ...oldConfig,
      machineLearning: {
        ...oldConfig.machineLearning,
        imageDescription: {
          ...oldConfig.machineLearning.imageDescription,
          ...timestamps,
        },
      },
    };

    const updated = await this.updateConfig(newConfig);
    await this.eventRepository.emit('ConfigUpdate', { newConfig: updated, oldConfig });
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
