import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
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
  AdminConfigRevisionResponseDto,
  AdminConfigRevisionUpdateDto,
  ImageDescriptionRequeueEstimateDto,
  ImageDescriptionRequeueResponseDto,
  SmartAlbumReevaluateEstimateDto,
  SmartAlbumReevaluateRequestDto,
  SmartAlbumReevaluateResponseDto,
  SystemConfigHistoryResponseDto,
} from 'src/dtos/system-config.dto.js';
import {
  BootstrapEventPriority,
  ConfigCredential,
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
import { cloudDescriptionDestination } from 'src/utils/cloud-description-batch.js';
import {
  ConfigHistoryKind,
  appendConfigHistory,
  credentialHistoryTitle,
  describeConfigChanges,
  readConfigHistory,
} from 'src/utils/config-history.js';
import { SYSTEM_CONFIG_CHANGED_MESSAGE, clearConfigCache, getConfigRevision } from 'src/utils/config.js';
import { readCloudLink } from 'src/utils/frameleaf-cloud-gateway.js';
import {
  type FrameleafVia,
  frameleafPublicUrl,
  isHomeAddress,
  isRemoteVia,
  signInClient,
} from 'src/utils/frameleaf-sign-in.js';
import { isImageDescriptionEnabled } from 'src/utils/misc.js';
import { resolveEndpoint } from 'src/utils/ml-destination.js';
import { toPlainObject } from 'src/utils/object.js';

/** Default per-asset estimate when no telemetry data is available. */
const DEFAULT_SECONDS_PER_ASSET = 1.5;

/** FL-67: where each write-only credential lives in the system configuration. */
const CREDENTIAL_PATHS: Record<ConfigCredential, string> = {
  [ConfigCredential.SmtpPassword]: 'notifications.smtp.transport.password',
  [ConfigCredential.OAuthClientSecret]: 'oauth.clientSecret',
  [ConfigCredential.CloudBackupS3SecretKey]: 'frameleafCloud.cloudBackup.s3.secretAccessKey',
};

const CONFIG_FILE_IN_USE_MESSAGE = 'Cannot update configuration while IMMICH_CONFIG_FILE is in use';

const readCredential = (config: SystemConfig, name: ConfigCredential): string => {
  const value: unknown = get(config, CREDENTIAL_PATHS[name]);
  return typeof value === 'string' ? value : '';
};

/** Drops the read-only `...Configured` indicators from a configuration sent by a client. */
const stripCredentialFlags = (config: AdminConfigDto) => {
  delete config.notifications?.smtp?.transport?.passwordConfigured;
  delete config.oauth?.clientSecretConfigured;
  delete config.frameleafCloud?.cloudBackup?.s3?.secretAccessKeyConfigured;
};

/** The credentials whose stored value differs between two configurations. Only names leave this function. */
const changedCredentials = (oldConfig: SystemConfig, newConfig: SystemConfig) =>
  Object.values(ConfigCredential).filter((name) => readCredential(oldConfig, name) !== readCredential(newConfig, name));

/**
 * Resolves the write-only credentials of a configuration sent by a client against the stored
 * configuration. Reads redact them to '' (FL-67), so an empty value coming back means "keep the
 * stored secret", but only for the account it belongs to: a new mail host or username, or a new
 * identity provider, never gets the stored secret, which is cleared instead and has to be replaced
 * for the new server. Clearing one explicitly is DELETE /admin/config/credentials/:name. The
 * read-only `...Configured` flags are dropped so they are never stored and never make an unchanged
 * section look changed (an SMTP section that looked changed would be verified on every save).
 *
 * FL-66: a save runs this twice: once to validate, and again under the settings lock against the
 * configuration read there, because credentials are not part of the settings revision (only
 * whether they are set is). A key rotated in between therefore never makes a draft stale, and
 * the draft's "keep" must keep the rotated key rather than the one seen at validation.
 */
const resolveCredentials = (dto: AdminConfigDto, stored: SystemConfig) => {
  stripCredentialFlags(dto);

  const smtpTransport = dto.notifications?.smtp?.transport;
  const storedTransport = stored.notifications.smtp.transport;
  if (smtpTransport?.password === '') {
    const sameAccount =
      smtpTransport.host === storedTransport.host && smtpTransport.username === storedTransport.username;
    smtpTransport.password = sameAccount ? storedTransport.password : '';
  }
  if (dto.oauth?.clientSecret === '') {
    dto.oauth.clientSecret = dto.oauth.issuerUrl === stored.oauth.issuerUrl ? stored.oauth.clientSecret : '';
  }
  // FL-160: the cloud backup bucket's secret is kept only for the same storage address, bucket and
  // access key; pointing the section at another bucket or key clears it.
  const s3 = dto.frameleafCloud?.cloudBackup?.s3;
  const storedS3 = stored.frameleafCloud.cloudBackup.s3;
  if (s3?.secretAccessKey === '') {
    const sameBucket =
      s3.endpoint === storedS3.endpoint && s3.bucket === storedS3.bucket && s3.accessKeyId === storedS3.accessKeyId;
    s3.secretAccessKey = sameBucket ? storedS3.secretAccessKey : '';
  }
};

/** Copies the credential values (where present) from one configuration onto another. */
const copyCredentials = (target: AdminConfigDto, source: AdminConfigDto) => {
  for (const path of Object.values(CREDENTIAL_PATHS)) {
    const value: unknown = get(source, path);
    if (typeof value === 'string') {
      set(target, path, value);
    }
  }
};

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

  /**
   * FL-158: the public configuration, with how Sign in with Frameleaf applies to this visitor. A
   * visitor arriving through remote access (`relay` or `wan`, vouched for by the edge worker) is
   * offered only Sign in with Frameleaf, unless an administrator allowed password sign-in there
   * (FL-161); one who is also on the home network is offered the local address.
   */
  async getPublicConfig(arrival?: { via: FrameleafVia | null; clientIp: string }) {
    const config = await this.getConfig({ withCache: false });
    const env = this.configRepository.getEnv().frameleafCloud;
    const { link, linked } = await readCloudLink({
      configRepository: this.configRepository,
      systemMetadataRepository: this.systemMetadataRepository,
    });
    const via = arrival?.via ?? null;
    const remote = isRemoteVia(via);
    const signInRequired = remote && !config.frameleafCloud.remoteAccess.allowPasswordOverRelay;
    const relayOrigin = link?.services?.relayOrigin;
    let relayHost: string | null;
    try {
      relayHost = typeof relayOrigin === 'string' ? new URL(relayOrigin).host : null;
    } catch {
      relayHost = null;
    }
    const sameNetwork = remote && !!env.localUrl && isHomeAddress(arrival?.clientIp, env.trustedLanCidrs);
    return mapPublicConfig(config, {
      signInAvailable: !!signInClient(link, linked),
      signInRequired,
      via,
      relayHost,
      // the home address is told only to a visitor who is already on the home network
      localUrl: sameNetwork ? env.localUrl : null,
      sameNetwork,
    });
  }

  /**
   * FL-161: `/.well-known/immich`, which apps read to find the API, with what the Frameleaf apps need
   * to find this server again: its instance id and published address while it is linked, and whether
   * Sign in with Frameleaf is available.
   */
  async getWellKnown() {
    const { link, linked } = await readCloudLink({
      configRepository: this.configRepository,
      systemMetadataRepository: this.systemMetadataRepository,
    });
    return {
      api: { endpoint: '/api' },
      frameleaf: {
        instanceId: linked ? (link?.instanceId ?? null) : null,
        publicUrl: linked ? frameleafPublicUrl(link) : null,
        signIn: !!signInClient(link, linked),
      },
    };
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
    const endpoint = resolveEndpoint(destination);
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

    // FL-161: what remote access may carry can only be loosened on a linked server, through any
    // settings path (PUT admin/cloud/remote-access checks the same); turning it back off always works
    const allow = newConfig.frameleafCloud.remoteAccess;
    const before = oldConfig.frameleafCloud?.remoteAccess;
    const loosened =
      (allow.allowOriginalsOverRelay && !before?.allowOriginalsOverRelay) ||
      (allow.allowPasswordOverRelay && !before?.allowPasswordOverRelay);
    if (loosened) {
      const { linked } = await readCloudLink({
        configRepository: this.configRepository,
        systemMetadataRepository: this.systemMetadataRepository,
      });
      if (!linked) {
        throw new Error(
          'Link this server to Frameleaf Cloud before allowing original downloads or password sign-in over remote access.',
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
  async updateAdminConfigWithRevision(
    { config, expectedRevision }: AdminConfigRevisionUpdateDto,
    auth?: AuthDto,
  ): Promise<AdminConfigRevisionResponseDto> {
    const newConfig = await this.saveAdminConfig(config, auth, expectedRevision);
    return { config: mapAdminConfig(newConfig), revision: getConfigRevision(newConfig) };
  }

  async updateAdminConfig(dto: AdminConfigDto, auth?: AuthDto): Promise<AdminConfigDto> {
    return mapAdminConfig(await this.saveAdminConfig(dto, auth));
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
   *    backfill, queue concurrency) are reconciled afterwards by
   *    the ConfigUpdate listeners through their own services; a failure there never rolls the
   *    saved settings back.
   */
  private async saveAdminConfig(dto: AdminConfigDto, auth?: AuthDto, expectedRevision?: string): Promise<SystemConfig> {
    const { configFile } = this.configRepository.getEnv();
    if (configFile) {
      throw new BadRequestException(CONFIG_FILE_IN_USE_MESSAGE);
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

        // Credentials are not part of the revision, so one may have been replaced or cleared since
        // step 1 without the draft becoming stale. Resolve the draft's credentials again against
        // the settings read under the lock, so a "keep" keeps what is stored now.
        const credentials = cloneDeep(incoming);
        resolveCredentials(credentials, current);
        copyCredentials(prepared.config, credentials);

        // The re-queue reminder is not part of the revision and may have moved since step 1.
        const description = prepared.config.machineLearning?.imageDescription;
        if (description) {
          const saved = current.machineLearning.imageDescription;
          description.pendingRequeueAt = saved.pendingRequeueAt;
          if (!prepared.descriptionChanged) {
            description.lastConfigChangeAt = saved.lastConfigChangeAt;
          }
        }

        const saved = await this.updateConfig(prepared.config);
        await this.recordConfigHistory(current, saved, auth, { kind: 'settings' });
        return { oldConfig: current, newConfig: saved };
      },
    );

    await this.eventRepository.emit('ConfigUpdate', { newConfig, oldConfig });

    // A client that still sends a secret through the whole configuration (an older script or a
    // configuration import) is accepted for compatibility, and recorded like the explicit action.
    for (const name of changedCredentials(oldConfig, newConfig)) {
      this.recordCredentialChange(auth, name, readCredential(newConfig, name) ? 'replaced' : 'cleared');
    }

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

    resolveCredentials(dto, oldConfig);

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
      !!dto.machineLearning?.imageDescription && !isEqual(toPlainObject(oldDescription), toPlainObject(newDescription));
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
   * configuration save (so SMTP is verified with the new password), without the value ever passing
   * through a client draft.
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

    // Validators may reach the network (the SMTP check), so the change is validated before the
    // settings lock and written under it (FL-66), starting from the settings read there. When
    // another save landed in between it is checked and validated again against those settings.
    const checked = await this.prepareCredential(name, value, await this.readConfigForUpdate());
    if (!checked) {
      return { name, configured: value !== '' };
    }

    const result = await this.databaseRepository.withLock(DatabaseLock.SystemConfigUpdate, async () => {
      const current = await this.readConfigForUpdate();
      if (getConfigRevision(current) !== checked.revision && !(await this.prepareCredential(name, value, current))) {
        return;
      }
      if (readCredential(current, name) === value) {
        return;
      }

      const newConfig = cloneDeep(current);
      set(newConfig, CREDENTIAL_PATHS[name], value);
      const saved = await this.updateConfig(newConfig);
      // FL-71 (CC-10): the credential's own entry, such as "Updated SMTP password" (CommandCenter.jsx:1447).
      await this.recordConfigHistory(current, saved, auth, {
        kind: 'credential',
        title: credentialHistoryTitle(name, value ? 'replaced' : 'cleared'),
      });
      return { oldConfig: current, newConfig: saved };
    });

    if (!result) {
      return { name, configured: value !== '' };
    }

    const { oldConfig, newConfig: updated } = result;
    await this.eventRepository.emit('ConfigUpdate', { newConfig: updated, oldConfig });
    this.recordCredentialChange(auth, name, value ? 'replaced' : 'cleared');

    return { name, configured: readCredential(updated, name) !== '' };
  }

  /**
   * Checks and validates one credential change against the given settings. Returns nothing when
   * the credential already has that value (nothing to write).
   */
  private async prepareCredential(
    name: ConfigCredential,
    value: string,
    oldConfig: SystemConfig,
  ): Promise<{ revision: string } | undefined> {
    if (readCredential(oldConfig, name) === value) {
      return;
    }

    const newConfig = cloneDeep(oldConfig);
    set(newConfig, CREDENTIAL_PATHS[name], value);

    try {
      await this.eventRepository.emit('ConfigValidate', { newConfig, oldConfig });
    } catch (error) {
      this.logger.warn(`Unable to change the ${name} credential due to a validation error: ${error}`);
      throw new BadRequestException(error instanceof Error ? error.message : error);
    }

    return { revision: getConfigRevision(oldConfig) };
  }

  /** FL-66: the settings change history, newest first. */
  async getConfigHistory(): Promise<SystemConfigHistoryResponseDto> {
    const stored = await this.systemMetadataRepository.get(SystemMetadataKey.SystemConfigHistory);
    return readConfigHistory(stored);
  }

  /**
   * FL-66: adds a saved change to the settings change history. Called under the settings lock
   * right after the write, so entries are appended one at a time in the order the saves landed.
   * Recording never fails or undoes the save it records: if it fails, the save stands and the
   * failure is logged.
   */
  private async recordConfigHistory(
    oldConfig: SystemConfig,
    newConfig: SystemConfig,
    auth: AuthDto | undefined,
    { kind, title }: { kind: ConfigHistoryKind; title?: string },
  ) {
    const changes = describeConfigChanges(oldConfig, newConfig);
    if (changes.length === 0) {
      return;
    }

    try {
      const history = readConfigHistory(await this.systemMetadataRepository.get(SystemMetadataKey.SystemConfigHistory));
      const entry = {
        id: this.cryptoRepository.randomUUID(),
        createdAt: new Date().toISOString(),
        actorId: auth?.user.id ?? null,
        actorName: auth?.user.name ?? null,
        kind,
        ...(title && { title }),
      };
      await this.systemMetadataRepository.set(
        SystemMetadataKey.SystemConfigHistory,
        appendConfigHistory(history, entry, changes),
      );
    } catch (error) {
      this.logger.error(`Unable to record the settings change in the change history: ${error}`);
    }
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

    // FL-163: while cloud processing is on for descriptions routed to Frameleaf Cloud, they are described
    // in batches from Frameleaf Cloud processing, where the estimate comes first, and the queue-all job
    // queues none of them; while it is off, nothing is claimed to go through batches
    if (await cloudDescriptionDestination(this.mlDestinationRepository, null, oldConfig.frameleafCloud.cloudMl)) {
      return { queued: false, cloudBatches: true };
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

    return { queued: !alreadyInFlight, cloudBatches: false };
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
