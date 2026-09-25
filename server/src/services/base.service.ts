import { BadRequestException, Injectable } from '@nestjs/common';
import { Insertable } from 'kysely';
import { cloneDeep } from 'lodash-es';
import sanitize from 'sanitize-filename';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import type { ClassConstructor } from 'src/types.js';
import { SALT_ROUNDS } from 'src/constants.js';
import { StorageCore } from 'src/cores/storage.core.js';
import { UserAdmin } from 'src/database.js';
import { mapAsset } from 'src/dtos/asset-response.dto.js';
import { SystemConfig } from 'src/dtos/config.dto.js';
import { DatabaseLock } from 'src/enum.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { ActivityRepository } from 'src/repositories/activity.repository.js';
import { AdminAuditRepository } from 'src/repositories/admin-audit.repository.js';
import { AlbumUserRepository } from 'src/repositories/album-user.repository.js';
import { AlbumRepository } from 'src/repositories/album.repository.js';
import { ApiKeyRepository } from 'src/repositories/api-key.repository.js';
import { AppRepository } from 'src/repositories/app.repository.js';
import { AssetEditRepository } from 'src/repositories/asset-edit.repository.js';
import { AssetFileRepository } from 'src/repositories/asset-file.repository.js';
import { AssetJobRepository } from 'src/repositories/asset-job.repository.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { ClassificationRepository } from 'src/repositories/classification.repository.js';
import { ClusterGroupRepository } from 'src/repositories/cluster-group.repository.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { CronRepository } from 'src/repositories/cron.repository.js';
import { CryptoRepository } from 'src/repositories/crypto.repository.js';
import { DatabaseRepository } from 'src/repositories/database.repository.js';
import { DownloadRepository } from 'src/repositories/download.repository.js';
import { DuplicateRepository } from 'src/repositories/duplicate.repository.js';
import { EmailRepository } from 'src/repositories/email.repository.js';
import { EventRepository } from 'src/repositories/event.repository.js';
import { ForkSchemaRepository } from 'src/repositories/fork-schema.repository.js';
import { FrameleafAccountRepository } from 'src/repositories/frameleaf-account.repository.js';
import { FrameleafCloudMlRepository } from 'src/repositories/frameleaf-cloud-ml.repository.js';
import { FrameleafCloudRepository } from 'src/repositories/frameleaf-cloud.repository.js';
import { FrameleafConsentRepository } from 'src/repositories/frameleaf-consent.repository.js';
import { FrameleafUserLicenseRepository } from 'src/repositories/frameleaf-user-license.repository.js';
import { InstanceIdentityRepository } from 'src/repositories/instance-identity.repository.js';
import { IntegrityRepository } from 'src/repositories/integrity.repository.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { LibraryRepository } from 'src/repositories/library.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MachineLearningRepository } from 'src/repositories/machine-learning.repository.js';
import { MapRepository } from 'src/repositories/map.repository.js';
import { MediaOperationRepository } from 'src/repositories/media-operation.repository.js';
import { MediaRepository } from 'src/repositories/media.repository.js';
import { MemoryRepository } from 'src/repositories/memory.repository.js';
import { MetadataRepository } from 'src/repositories/metadata.repository.js';
import { MlDestinationRepository } from 'src/repositories/ml-destination.repository.js';
import { MoveRepository } from 'src/repositories/move.repository.js';
import { NotificationRepository } from 'src/repositories/notification.repository.js';
import { OAuthRepository } from 'src/repositories/oauth.repository.js';
import { OcrRepository } from 'src/repositories/ocr.repository.js';
import { PartnerRepository } from 'src/repositories/partner.repository.js';
import { PersonRepository } from 'src/repositories/person.repository.js';
import { PhysicalFileRepository } from 'src/repositories/physical-file.repository.js';
import { PluginRepository } from 'src/repositories/plugin.repository.js';
import { ProcessRepository } from 'src/repositories/process.repository.js';
import { RenderWorkerRepository } from 'src/repositories/render-worker.repository.js';
import { SearchRepository } from 'src/repositories/search.repository.js';
import { ServerInfoRepository } from 'src/repositories/server-info.repository.js';
import { SessionRepository } from 'src/repositories/session.repository.js';
import { SharedLinkAssetRepository } from 'src/repositories/shared-link-asset.repository.js';
import { SharedLinkRepository } from 'src/repositories/shared-link.repository.js';
import { SmartAlbumRepository } from 'src/repositories/smart-album.repository.js';
import { StackRepository } from 'src/repositories/stack.repository.js';
import { StorageRepository } from 'src/repositories/storage.repository.js';
import { SyncCheckpointRepository } from 'src/repositories/sync-checkpoint.repository.js';
import { SyncRepository } from 'src/repositories/sync.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { TagRepository } from 'src/repositories/tag.repository.js';
import { TrashRepository } from 'src/repositories/trash.repository.js';
import { UserRepository } from 'src/repositories/user.repository.js';
import { VersionHistoryRepository } from 'src/repositories/version-history.repository.js';
import { VideoStreamRepository } from 'src/repositories/video-stream.repository.js';
import { ViewRepository } from 'src/repositories/view-repository.js';
import { WebsocketRepository } from 'src/repositories/websocket.repository.js';
import { WorkflowRepository } from 'src/repositories/workflow.repository.js';
import { AdminAuditEventTable } from 'src/schema/tables/admin-audit-event.table.js';
import { UserTable } from 'src/schema/tables/user.table.js';
import { AccessRequest, checkAccess, requireAccess } from 'src/utils/access.js';
import { getConfig, readConfig, updateConfig } from 'src/utils/config.js';
import { queueReleasedPersonThumbnails } from 'src/utils/cover-references.js';
import { MlSelectionRequest, routedMlDestinationId, selectMlDestination } from 'src/utils/ml-destination.js';
import { replaceLockedProfileImages } from 'src/utils/profile-image.js';

export const BASE_SERVICE_DEPENDENCIES = [
  LoggingRepository,
  AccessRepository,
  ActivityRepository,
  AdminAuditRepository,
  AlbumRepository,
  AlbumUserRepository,
  ApiKeyRepository,
  AppRepository,
  AssetRepository,
  AssetEditRepository,
  AssetFileRepository,
  AssetJobRepository,
  ClassificationRepository,
  ClusterGroupRepository,
  ConfigRepository,
  CronRepository,
  CryptoRepository,
  DatabaseRepository,
  DownloadRepository,
  DuplicateRepository,
  EmailRepository,
  EventRepository,
  ForkSchemaRepository,
  IntegrityRepository,
  JobRepository,
  LibraryRepository,
  MachineLearningRepository,
  MapRepository,
  MediaRepository,
  MediaOperationRepository,
  MemoryRepository,
  MetadataRepository,
  MlDestinationRepository,
  MoveRepository,
  NotificationRepository,
  OAuthRepository,
  OcrRepository,
  PartnerRepository,
  PersonRepository,
  PhysicalFileRepository,
  PluginRepository,
  ProcessRepository,
  RenderWorkerRepository,
  FrameleafCloudRepository,
  FrameleafCloudMlRepository,
  FrameleafConsentRepository,
  FrameleafUserLicenseRepository,
  FrameleafAccountRepository,
  InstanceIdentityRepository,
  SearchRepository,
  ServerInfoRepository,
  SmartAlbumRepository,
  SessionRepository,
  SharedLinkRepository,
  SharedLinkAssetRepository,
  StackRepository,
  StorageRepository,
  SyncRepository,
  SyncCheckpointRepository,
  SystemMetadataRepository,
  TagRepository,
  TrashRepository,
  UserRepository,
  VersionHistoryRepository,
  VideoStreamRepository,
  ViewRepository,
  WebsocketRepository,
  WorkflowRepository,
] as const;

@Injectable()
export class BaseService {
  protected storageCore: StorageCore;

  constructor(
    protected logger: LoggingRepository,
    protected accessRepository: AccessRepository,
    protected activityRepository: ActivityRepository,
    protected adminAuditRepository: AdminAuditRepository,
    protected albumRepository: AlbumRepository,
    protected albumUserRepository: AlbumUserRepository,
    protected apiKeyRepository: ApiKeyRepository,
    protected appRepository: AppRepository,
    protected assetRepository: AssetRepository,
    protected assetEditRepository: AssetEditRepository,
    protected assetFileRepository: AssetFileRepository,
    protected assetJobRepository: AssetJobRepository,
    protected classificationRepository: ClassificationRepository,
    protected clusterGroupRepository: ClusterGroupRepository,
    protected configRepository: ConfigRepository,
    protected cronRepository: CronRepository,
    protected cryptoRepository: CryptoRepository,
    protected databaseRepository: DatabaseRepository,
    protected downloadRepository: DownloadRepository,
    protected duplicateRepository: DuplicateRepository,
    protected emailRepository: EmailRepository,
    protected eventRepository: EventRepository,
    protected forkSchemaRepository: ForkSchemaRepository,
    protected integrityRepository: IntegrityRepository,
    protected jobRepository: JobRepository,
    protected libraryRepository: LibraryRepository,
    protected machineLearningRepository: MachineLearningRepository,
    protected mapRepository: MapRepository,
    protected mediaRepository: MediaRepository,
    protected mediaOperationRepository: MediaOperationRepository,
    protected memoryRepository: MemoryRepository,
    protected metadataRepository: MetadataRepository,
    protected mlDestinationRepository: MlDestinationRepository,
    protected moveRepository: MoveRepository,
    protected notificationRepository: NotificationRepository,
    protected oauthRepository: OAuthRepository,
    protected ocrRepository: OcrRepository,
    protected partnerRepository: PartnerRepository,
    protected personRepository: PersonRepository,
    protected physicalFileRepository: PhysicalFileRepository,
    protected pluginRepository: PluginRepository,
    protected processRepository: ProcessRepository,
    protected renderWorkerRepository: RenderWorkerRepository,
    protected frameleafCloudRepository: FrameleafCloudRepository,
    protected frameleafCloudMlRepository: FrameleafCloudMlRepository,
    protected frameleafConsentRepository: FrameleafConsentRepository,
    protected frameleafUserLicenseRepository: FrameleafUserLicenseRepository,
    protected frameleafAccountRepository: FrameleafAccountRepository,
    protected instanceIdentityRepository: InstanceIdentityRepository,
    protected searchRepository: SearchRepository,
    protected serverInfoRepository: ServerInfoRepository,
    protected smartAlbumRepository: SmartAlbumRepository,
    protected sessionRepository: SessionRepository,
    protected sharedLinkRepository: SharedLinkRepository,
    protected sharedLinkAssetRepository: SharedLinkAssetRepository,
    protected stackRepository: StackRepository,
    protected storageRepository: StorageRepository,
    protected syncRepository: SyncRepository,
    protected syncCheckpointRepository: SyncCheckpointRepository,
    protected systemMetadataRepository: SystemMetadataRepository,
    protected tagRepository: TagRepository,
    protected trashRepository: TrashRepository,
    protected userRepository: UserRepository,
    protected versionRepository: VersionHistoryRepository,
    protected videoStreamRepository: VideoStreamRepository,
    protected viewRepository: ViewRepository,
    protected websocketRepository: WebsocketRepository,
    protected workflowRepository: WorkflowRepository,
  ) {
    this.logger.setContext(this.constructor.name);
    this.storageCore = StorageCore.create(
      assetRepository,
      configRepository,
      cryptoRepository,
      moveRepository,
      personRepository,
      storageRepository,
      systemMetadataRepository,
      this.logger,
    );
  }

  static create<T extends ClassConstructor<typeof BaseService>>(Service: T, ctx: BaseService) {
    const service = new Service(
      LoggingRepository.create(),
      ctx.accessRepository,
      ctx.activityRepository,
      ctx.adminAuditRepository,
      ctx.albumRepository,
      ctx.albumUserRepository,
      ctx.apiKeyRepository,
      ctx.appRepository,
      ctx.assetRepository,
      ctx.assetEditRepository,
      ctx.assetFileRepository,
      ctx.assetJobRepository,
      ctx.classificationRepository,
      ctx.clusterGroupRepository,
      ctx.configRepository,
      ctx.cronRepository,
      ctx.cryptoRepository,
      ctx.databaseRepository,
      ctx.downloadRepository,
      ctx.duplicateRepository,
      ctx.emailRepository,
      ctx.eventRepository,
      ctx.forkSchemaRepository,
      ctx.integrityRepository,
      ctx.jobRepository,
      ctx.libraryRepository,
      ctx.machineLearningRepository,
      ctx.mapRepository,
      ctx.mediaRepository,
      ctx.mediaOperationRepository,
      ctx.memoryRepository,
      ctx.metadataRepository,
      ctx.mlDestinationRepository,
      ctx.moveRepository,
      ctx.notificationRepository,
      ctx.oauthRepository,
      ctx.ocrRepository,
      ctx.partnerRepository,
      ctx.personRepository,
      ctx.physicalFileRepository,
      ctx.pluginRepository,
      ctx.processRepository,
      ctx.renderWorkerRepository,
      ctx.frameleafCloudRepository,
      ctx.frameleafCloudMlRepository,
      ctx.frameleafConsentRepository,
      ctx.frameleafUserLicenseRepository,
      ctx.frameleafAccountRepository,
      ctx.instanceIdentityRepository,
      ctx.searchRepository,
      ctx.serverInfoRepository,
      ctx.smartAlbumRepository,
      ctx.sessionRepository,
      ctx.sharedLinkRepository,
      ctx.sharedLinkAssetRepository,
      ctx.stackRepository,
      ctx.storageRepository,
      ctx.syncRepository,
      ctx.syncCheckpointRepository,
      ctx.systemMetadataRepository,
      ctx.tagRepository,
      ctx.trashRepository,
      ctx.userRepository,
      ctx.versionRepository,
      ctx.videoStreamRepository,
      ctx.viewRepository,
      ctx.websocketRepository,
      ctx.workflowRepository,
    );

    service.logger.setContext(BaseService.name);

    return service as InstanceType<T>;
  }

  get worker() {
    return this.configRepository.getWorker();
  }

  private get configRepos() {
    return {
      configRepo: this.configRepository,
      metadataRepo: this.systemMetadataRepository,
      logger: this.logger,
      forkSchemaRepo: this.forkSchemaRepository,
    };
  }

  getConfig(options: { withCache: boolean }) {
    return getConfig(this.configRepos, options);
  }

  updateConfig(newConfig: SystemConfig) {
    return updateConfig(this.configRepos, newConfig);
  }

  /** FL-66: the saved configuration straight from storage, for revision checks and updates. */
  readConfigForUpdate() {
    return readConfig(this.configRepos);
  }

  /**
   * FL-66: change the saved system configuration as one step. It holds the settings lock that
   * every administrator save holds, and starts from the configuration read straight from storage
   * under it, so neither this change nor an administrator's save can overwrite the other.
   */
  updateConfigExclusively(change: (config: SystemConfig) => void) {
    return this.databaseRepository.withLock(DatabaseLock.SystemConfigUpdate, async () => {
      const oldConfig = await this.readConfigForUpdate();
      const next = cloneDeep(oldConfig);
      change(next);
      const newConfig = await this.updateConfig(next);
      return { oldConfig, newConfig };
    });
  }

  /**
   * Admit one machine-learning request against the destination the caller names (FL-110).
   * Refuses when the destination is missing, disabled, unconsented, over budget, unhealthy or
   * does not serve the workload; never substitutes another destination.
   */
  protected selectMlDestination(request: MlSelectionRequest) {
    return selectMlDestination(
      {
        mlDestinationRepository: this.mlDestinationRepository,
        machineLearningRepository: this.machineLearningRepository,
      },
      request,
    );
  }

  /**
   * Admit a library workload against the destination the administrator routed it to. The
   * route is explicit configuration; a workload without one is refused, not sent anywhere.
   */
  protected async selectRoutedMlDestination(request: Omit<MlSelectionRequest, 'destinationId'>) {
    const destinationId = await routedMlDestinationId(this.mlDestinationRepository, request.workload);
    return this.selectMlDestination({ ...request, destinationId });
  }

  /**
   * Once a move of `assetIds` into the Locked folder is committed (FL-53): the people whose featured
   * face was on them, or on another photo of their stacks, get a thumbnail from the face that replaced
   * it, and profile pictures copied from a photo now Locked are replaced.
   */
  protected async afterAssetsLocked(assetIds: string[]): Promise<void> {
    await queueReleasedPersonThumbnails({ person: this.personRepository, job: this.jobRepository }, assetIds);
    await this.replaceLockedProfileImages();
    // FL-90: Studio previews of the newly Locked sources stop now rather than at their next read.
    await this.eventRepository.emit('AssetLocked', { assetIds });
  }

  /**
   * Pushes the current state of `assetIds` to `ownerId`'s other open sessions over the websocket
   * (`on_asset_update`). Used so a move into or out of the Locked folder — including the rest of a
   * stack a direct move carries along (FL-53, `locked-stacks.ts`) — is reflected in every open web
   * client at once, not only in the tab that made the change and not only for the asset named directly.
   */
  protected async notifyAssetsUpdated(assetIds: string[], ownerId: string): Promise<void> {
    if (assetIds.length === 0) {
      return;
    }

    const assets = (await this.assetRepository.getByIdsWithAllRelationsButStacks(assetIds, ownerId)) ?? [];
    for (const asset of assets) {
      this.websocketRepository.clientSend(
        'on_asset_update',
        ownerId,
        mapAsset(asset, { auth: { user: { id: ownerId } } as AuthDto }),
      );
    }
  }

  /** Gives another profile picture to every user whose picture was copied from a now Locked photo. */
  protected async replaceLockedProfileImages(): Promise<void> {
    await replaceLockedProfileImages(
      {
        media: this.mediaRepository,
        crypto: this.cryptoRepository,
        storageCore: this.storageCore,
        user: this.userRepository,
        job: this.jobRepository,
        logger: this.logger,
      },
      () => this.getConfig({ withCache: true }),
    );
  }

  /**
   * FL-76: add to the administrator audit trail behind the account detail's Activity tab. Called by
   * the service that made the change, after it succeeded. Recording never undoes or fails the change
   * it records: if the insert fails, the change stands and the failure is logged.
   */
  protected async recordAdminEvents(events: Insertable<AdminAuditEventTable>[]): Promise<void> {
    if (events.length === 0) {
      return;
    }

    try {
      await this.adminAuditRepository.create(events);
    } catch (error) {
      const actions = events.map(({ action }) => action).join(', ');
      this.logger.error(`Unable to record administrator activity (${actions}): ${error}`);
    }
  }

  requireAccess(request: AccessRequest) {
    return requireAccess(this.accessRepository, request);
  }

  checkAccess(request: AccessRequest) {
    return checkAccess(this.accessRepository, request);
  }

  async isSetupAvailable(): Promise<boolean> {
    const { setup } = this.configRepository.getEnv();
    return setup.allow && !(await this.userRepository.hasAdmin());
  }

  async requireSetupAvailable(): Promise<void> {
    if (!(await this.isSetupAvailable())) {
      throw new BadRequestException('Admin setup is not available');
    }
  }

  async createUser(dto: Omit<Insertable<UserTable>, 'clusterGroupId'> & { email: string }): Promise<UserAdmin> {
    const exists = await this.userRepository.getByEmail(dto.email);
    if (exists) {
      this.logger.debug('User creation rejected: user already exists');
      throw new BadRequestException('Email is not available');
    }

    if (!dto.isAdmin) {
      const localAdmin = await this.userRepository.getAdmin();
      if (!localAdmin) {
        throw new BadRequestException('The first registered account must the administrator.');
      }
    }

    const payload: Omit<Insertable<UserTable>, 'clusterGroupId'> = { ...dto };
    if (payload.password) {
      payload.password = await this.cryptoRepository.hashBcrypt(payload.password, SALT_ROUNDS);
    }
    /*
     * FL-76: `UserAdminCreateDto` accepts `pinCode`, so an administrator could supply one
     * at creation, and before this it reached `user.pinCode` verbatim while
     * `UserAdminService.update` hashed it. A clear-text PIN there never
     * verifies against `validateSecret`, which compares with bcrypt, so the account's
     * Locked content could not be unlocked with the PIN it was created with, and the
     * secret sat in the database and in every backup in the clear. Hash it on the same
     * path as the password so a stored PIN is always a bcrypt hash.
     */
    if (payload.pinCode) {
      payload.pinCode = await this.cryptoRepository.hashBcrypt(payload.pinCode, SALT_ROUNDS);
    }
    if (payload.storageLabel) {
      payload.storageLabel = sanitize(payload.storageLabel.replaceAll('.', ''));
      // FL-76: the label is unique, as on update; refuse a duplicate before the insert fails on it
      if (await this.userRepository.getByStorageLabel(payload.storageLabel, true)) {
        throw new BadRequestException('Storage label already in use by another account');
      }
    }

    const clusterGroup = await this.clusterGroupRepository.create();
    const user = await this.userRepository.create({ ...payload, clusterGroupId: clusterGroup.id });

    await this.eventRepository.emit('UserCreate', user);

    return user;
  }
}
