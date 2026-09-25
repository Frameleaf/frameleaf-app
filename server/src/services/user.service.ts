import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Updateable } from 'kysely';
import { cloneDeep, get, isEqual, omit } from 'lodash-es';
import { DateTime } from 'luxon';
import z from 'zod';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import type { ArgOf } from 'src/repositories/event.repository.js';
import type { JobOf, UserMetadataItem } from 'src/types.js';
import { SALT_ROUNDS } from 'src/constants.js';
import { StorageCore } from 'src/cores/storage.core.js';
import { OnEvent, OnJob } from 'src/decorators.js';
import { CalendarHeatmapDto, CalendarHeatmapResponseDto } from 'src/dtos/calendar-heatmap.dto.js';
import { LicenseKeyDto, LicenseResponseDto } from 'src/dtos/license.dto.js';
import { OnboardingDto, OnboardingResponseDto } from 'src/dtos/onboarding.dto.js';
import {
  type PreferencesAudience,
  UserPreferenceHistoryResponseDto,
  UserPreferencesResponseDto,
  UserPreferencesUpdateDto,
  mapPreferences,
} from 'src/dtos/user-preferences.dto.js';
import { CreateProfileImageDto, CreateProfileImageResponseDto } from 'src/dtos/user-profile.dto.js';
import { UserAdminResponseDto, UserResponseDto, UserUpdateMeDto, mapUser, mapUserAdmin } from 'src/dtos/user.dto.js';
import {
  CacheControl,
  JobName,
  JobStatus,
  Permission,
  QueueName,
  StorageFolder,
  UserMetadataKey,
  UserStatus,
} from 'src/enum.js';
import { UserFindOptions } from 'src/repositories/user.repository.js';
import { UserTable } from 'src/schema/tables/user.table.js';
import { BaseService } from 'src/services/base.service.js';
import { getCalendarHeatmap } from 'src/services/shared/user-methods.js';
import { CONFIG_HISTORY_LIMITS, describeObjectChanges } from 'src/utils/config-history.js';
import { ImmichFileResponse } from 'src/utils/file.js';
import { isLockedAsset } from 'src/utils/locked-state.js';
import { getLockedVisibilityOptions } from 'src/utils/locked-visibility.js';
import { mimeTypes } from 'src/utils/mime-types.js';
import { findOrFail } from 'src/utils/misc.js';
import {
  type FrameleafUserPreferences,
  LOCKED_RULES_REQUIRE_UNLOCK_MESSAGE,
  changesLockedRules,
  getPreferences,
  getPreferencesPartial,
  mergePreferences,
} from 'src/utils/preferences.js';
import { generateProfileImage } from 'src/utils/profile-image.js';

/** FL-67: an account sees its own Locked people, pets and tags only while its session is unlocked. */
const preferencesAudience = (auth: AuthDto): PreferencesAudience =>
  auth.session?.hasElevatedPermission ? 'self' : 'locked';

/** At most this many changed preferences per history entry, as the settings history keeps. */
const PREFERENCE_HISTORY_CHANGE_LIMIT = CONFIG_HISTORY_LIMITS.changes;

/** Sections whose Locked-content values never enter the preference history, only that they changed. */
const PROTECTED_PREFERENCE_SECTIONS = ['privacy.suppression', 'savedSearches'] as const;

/**
 * FL-71 (CC-10): what a preferences save changed, for the account's own history. Values come from
 * the view a session without Locked access sees, redacted like the settings history; a Locked
 * change is listed by its section only.
 */
export const describePreferenceChanges = (before: FrameleafUserPreferences, after: FrameleafUserPreferences) => {
  const visibleBefore = omit(mapPreferences(before, 'locked'), 'revision');
  const visibleAfter = omit(mapPreferences(after, 'locked'), 'revision');
  const changes: Array<{ path: string; before: string | null; after: string | null; protected?: boolean }> =
    describeObjectChanges(visibleBefore, visibleAfter).map(({ path, before, after }) => ({ path, before, after }));
  for (const section of PROTECTED_PREFERENCE_SECTIONS) {
    if (
      isEqual(get(visibleBefore, section), get(visibleAfter, section)) &&
      !isEqual(get(before, section), get(after, section))
    ) {
      changes.push({ path: section, before: null, after: null, protected: true });
    }
  }
  return changes;
};

@Injectable()
export class UserService extends BaseService {
  async search(auth: AuthDto): Promise<UserResponseDto[]> {
    const config = await this.getConfig({ withCache: false });

    let users;
    if (auth.user.isAdmin || config.server.publicUsers) {
      users = await this.userRepository.getList({ withDeleted: false });
    } else {
      const authUser = await this.userRepository.get(auth.user.id, {});
      users = authUser ? [authUser] : [];
    }

    return users.map((user) => mapUser(user));
  }

  async getMe(auth: AuthDto): Promise<UserAdminResponseDto> {
    const user = await this.userRepository.get(auth.user.id, {});
    if (!user) {
      throw new BadRequestException('User not found');
    }

    return mapUserAdmin(user);
  }

  getCalendarHeatmap(auth: AuthDto, dto: CalendarHeatmapDto): Promise<CalendarHeatmapResponseDto> {
    // the caller's own Locked media counts only once they have unlocked it
    return getCalendarHeatmap(auth.user.id, dto, { asset: this.assetRepository }, getLockedVisibilityOptions(auth));
  }

  async updateMe({ user }: AuthDto, dto: UserUpdateMeDto): Promise<UserAdminResponseDto> {
    if (dto.email) {
      const duplicate = await this.userRepository.getByEmail(dto.email);
      if (duplicate && duplicate.id !== user.id) {
        this.logger.warn('Email already in use by another account');
        throw new BadRequestException('Email is not available');
      }
    }

    const update: Updateable<UserTable> = {
      email: dto.email,
      name: dto.name,
      avatarColor: dto.avatarColor,
    };

    if (dto.password) {
      const hashedPassword = await this.cryptoRepository.hashBcrypt(dto.password, SALT_ROUNDS);
      update.password = hashedPassword;
      update.shouldChangePassword = false;
    }

    const updatedUser = await this.userRepository.update(user.id, update);

    return mapUserAdmin(updatedUser);
  }

  async getMyPreferences(auth: AuthDto): Promise<UserPreferencesResponseDto> {
    const metadata = await this.userRepository.getMetadata(auth.user.id);
    return mapPreferences(getPreferences(metadata), preferencesAudience(auth));
  }

  /**
   * FL-67: Locked rules change only from an unlocked session, and the whole read, revision check
   * and write happen under the account's preferences lock, so a save made against a revision that
   * another tab or device has since replaced is refused (409) rather than written over it.
   */
  async updateMyPreferences(auth: AuthDto, dto: UserPreferencesUpdateDto) {
    if (changesLockedRules(dto) && !auth.session?.hasElevatedPermission) {
      throw new ForbiddenException(LOCKED_RULES_REQUIRE_UNLOCK_MESSAGE);
    }

    const { previous, updated } = await this.databaseRepository.withUserPreferencesLock(auth.user.id, async (trx) => {
      const metadata = await this.userRepository.getMetadata(auth.user.id, trx);
      const current = getPreferences(metadata);
      // mergePreferences may write into the object it is given; the history needs the values before.
      const previous = cloneDeep(current);
      const merged = mergePreferences(current, dto, 'user', {
        lockedSession: !auth.session?.hasElevatedPermission,
      });
      await this.userRepository.upsertMetadata(
        auth.user.id,
        { key: UserMetadataKey.Preferences, value: getPreferencesPartial(merged) },
        trx,
      );
      return { previous, updated: merged };
    });
    await this.sessionRepository.requestSyncResetForUser(auth.user.id);
    await this.recordPreferenceHistory(auth, previous, updated);

    return mapPreferences(updated, preferencesAudience(auth));
  }

  /** FL-71 (CC-10): the signed-in account's own preference history, newest first. */
  async getMyPreferenceHistory(auth: AuthDto): Promise<UserPreferenceHistoryResponseDto> {
    const rows = await this.userRepository.getPreferenceHistory(auth.user.id);
    return {
      entries: rows.map((row) => ({
        id: row.id,
        createdAt: new Date(row.createdAt).toISOString(),
        deviceLabel: row.deviceLabel,
        changes: row.changes,
        omittedChanges: row.omittedChanges,
      })),
    };
  }

  /**
   * Records a preferences save in the account's own history with the device that saved it. A
   * failure is logged and never undoes the save.
   */
  private async recordPreferenceHistory(
    auth: AuthDto,
    before: FrameleafUserPreferences,
    after: FrameleafUserPreferences,
  ) {
    const changes = describePreferenceChanges(before, after);
    if (changes.length === 0) {
      return;
    }
    try {
      let deviceLabel: string | null = null;
      if (auth.session) {
        const session = (await this.sessionRepository.getByUserId(auth.user.id)).find(
          ({ id }) => id === auth.session?.id,
        );
        deviceLabel = [session?.deviceOS, session?.deviceType].filter(Boolean).join(' · ') || null;
      }
      const kept = changes.slice(0, PREFERENCE_HISTORY_CHANGE_LIMIT);
      const written = await this.userRepository.addPreferenceHistory({
        userId: auth.user.id,
        deviceLabel,
        changes: kept,
        omittedChanges: changes.length - kept.length,
      });
      if (!written) {
        this.logger.warn(
          `Preference history not recorded for user ${auth.user.id}: the fork schema is not writable (database handoff)`,
        );
      }
    } catch (error) {
      this.logger.error(`Unable to record the preferences change in the history: ${error}`);
    }
  }

  async get(id: string): Promise<UserResponseDto> {
    const user = await this.findOrFail(id, { withDeleted: false });
    return mapUser(user);
  }

  async createProfileImage(
    auth: AuthDto,
    file: Express.Multer.File,
    dto: Partial<CreateProfileImageDto> = {},
  ): Promise<CreateProfileImageResponseDto> {
    const { profileImagePath: oldPath } = await this.findOrFail(auth.user.id, { withDeleted: false });
    const profileImageAssetId = await this.resolveProfileImageSource(auth, file, dto.assetId);
    // A new crop of the current picture keeps the photo it came from, so a later Lock still replaces it.
    const keepSource = !dto.assetId && (dto.keepSource === true || dto.keepSource === 'true');

    let profileImagePath: string;
    try {
      const config = await this.getConfig({ withCache: true });
      profileImagePath = await generateProfileImage(
        { media: this.mediaRepository, crypto: this.cryptoRepository, storageCore: this.storageCore },
        config,
        auth.user.id,
        file.path,
      );
    } catch (error) {
      await this.jobRepository.queue({ name: JobName.FileDelete, data: { files: [file.path] } });
      throw new BadRequestException('Unable to process profile image', { cause: error });
    }

    const user = await this.userRepository.update(auth.user.id, {
      profileImagePath,
      ...(!keepSource && { profileImageAssetId }),
      profileChangedAt: new Date(),
    });

    const toDelete = [file.path, ...(oldPath ? [oldPath] : [])];
    await this.jobRepository.queue({ name: JobName.FileDelete, data: { files: toDelete } });

    return {
      userId: user.id,
      profileImagePath: user.profileImagePath,
      profileChangedAt: user.profileChangedAt,
    };
  }

  async deleteProfileImage(auth: AuthDto): Promise<void> {
    const user = await this.findOrFail(auth.user.id, { withDeleted: false });
    if (user.profileImagePath === '') {
      throw new BadRequestException("Can't delete a missing profile Image");
    }
    await this.userRepository.update(auth.user.id, {
      profileImagePath: '',
      profileImageAssetId: null,
      profileChangedAt: new Date(),
    });
    await this.jobRepository.queue({ name: JobName.FileDelete, data: { files: [user.profileImagePath] } });
  }

  /**
   * The photo a new profile picture was copied from, when the client names one (FL-53): one of the
   * caller's own photos that is not Locked. Profile pictures are shown to every account on the server,
   * so a partner's or shared photo is refused. It is recorded so the picture can be replaced if that photo
   * becomes Locked later. The uploaded file is removed when the photo is refused.
   */
  private async resolveProfileImageSource(
    auth: AuthDto,
    file: Express.Multer.File,
    assetId: string | undefined,
  ): Promise<string | null> {
    if (!assetId) {
      return null;
    }

    try {
      if (!z.uuid().safeParse(assetId).success) {
        throw new BadRequestException('Invalid profile picture source');
      }

      await this.requireAccess({ auth, permission: Permission.AssetRead, ids: [assetId] });
      const asset = await this.assetRepository.getById(assetId);
      if (!asset) {
        throw new BadRequestException('Invalid profile picture source');
      }
      if (asset.ownerId !== auth.user.id) {
        throw new BadRequestException('Only your own photo can be a profile picture');
      }
      if (isLockedAsset(asset)) {
        throw new BadRequestException('A Locked photo cannot be a profile picture');
      }

      return asset.id;
    } catch (error) {
      await this.jobRepository.queue({ name: JobName.FileDelete, data: { files: [file.path] } });
      throw error;
    }
  }

  async getProfileImage(id: string): Promise<ImmichFileResponse> {
    const user = await this.userRepository.get(id, {});
    if (!user || !user.profileImagePath) {
      this.logger.debug('User or profile image not found');
      throw new NotFoundException();
    }

    // a picture copied from a photo that became Locked is never served; it is being replaced (FL-53)
    if (await this.userRepository.hasLockedProfileImageSource(id)) {
      this.logger.debug('Profile image was copied from a Locked photo');
      throw new NotFoundException();
    }

    return new ImmichFileResponse({
      path: user.profileImagePath,
      contentType: mimeTypes.lookup(user.profileImagePath),
      cacheControl: CacheControl.None,
    });
  }

  async getLicense(auth: AuthDto): Promise<LicenseResponseDto> {
    const metadata = await this.userRepository.getMetadata(auth.user.id);

    const license = metadata.find(
      (item): item is UserMetadataItem<UserMetadataKey.License> => item.key === UserMetadataKey.License,
    );
    if (!license) {
      throw new NotFoundException();
    }
    return { ...license.value, activatedAt: new Date(license.value.activatedAt) };
  }

  async deleteLicense({ user }: AuthDto): Promise<void> {
    await this.userRepository.deleteMetadata(user.id, UserMetadataKey.License);
  }

  async setLicense(auth: AuthDto, license: LicenseKeyDto): Promise<LicenseResponseDto> {
    if (!license.licenseKey.startsWith('IMCL-') && !license.licenseKey.startsWith('IMSV-')) {
      throw new BadRequestException('Invalid license key');
    }

    const { licensePublicKey } = this.configRepository.getEnv();

    const isClientLicenseValid = this.cryptoRepository.verifySha256(
      license.licenseKey,
      license.activationKey,
      licensePublicKey.client,
    );

    const isServerLicenseValid = this.cryptoRepository.verifySha256(
      license.licenseKey,
      license.activationKey,
      licensePublicKey.server,
    );

    if (!isClientLicenseValid && !isServerLicenseValid) {
      throw new BadRequestException('Invalid license key');
    }

    const activatedAt = new Date();

    await this.userRepository.upsertMetadata(auth.user.id, {
      key: UserMetadataKey.License,
      value: { ...license, activatedAt: activatedAt.toISOString() },
    });

    return { ...license, activatedAt };
  }

  async getOnboarding(auth: AuthDto): Promise<OnboardingResponseDto> {
    const metadata = await this.userRepository.getMetadata(auth.user.id);

    const onboardingData = metadata.find(
      (item): item is UserMetadataItem<UserMetadataKey.Onboarding> => item.key === UserMetadataKey.Onboarding,
    )?.value;

    if (!onboardingData) {
      return { isOnboarded: false };
    }

    return {
      isOnboarded: onboardingData.isOnboarded,
    };
  }

  async deleteOnboarding({ user }: AuthDto): Promise<void> {
    await this.userRepository.deleteMetadata(user.id, UserMetadataKey.Onboarding);
  }

  async setOnboarding(auth: AuthDto, onboarding: OnboardingDto): Promise<OnboardingResponseDto> {
    await this.userRepository.upsertMetadata(auth.user.id, {
      key: UserMetadataKey.Onboarding,
      value: {
        isOnboarded: onboarding.isOnboarded,
      },
    });

    return {
      isOnboarded: onboarding.isOnboarded,
    };
  }

  @OnEvent({ name: 'AssetCreate' })
  async onAssetCreate({ asset, file }: ArgOf<'AssetCreate'>) {
    if (file) {
      await this.userRepository.updateUsage(asset.ownerId, file.size);
    }
  }

  @OnJob({ name: JobName.UserSyncUsage, queue: QueueName.BackgroundTask })
  async handleUserSyncUsage(): Promise<JobStatus> {
    await this.userRepository.syncUsage();
    return JobStatus.Success;
  }

  @OnJob({ name: JobName.UserDeleteCheck, queue: QueueName.BackgroundTask })
  async handleUserDeleteCheck(): Promise<JobStatus> {
    const config = await this.getConfig({ withCache: false });
    const users = await this.userRepository.getDeletedAfter(DateTime.now().minus({ days: config.user.deleteDelay }));
    await this.jobRepository.queueAll(users.map((user) => ({ name: JobName.UserDelete, data: { id: user.id } })));

    // FL-71, FL-55: fork rows of accounts removed while the fork schema was not writable.
    const swept = await this.userRepository.sweepRemovedAccountForkRows();
    if (swept === undefined) {
      this.logger.warn('Removed-account fork rows not swept: the fork schema is not writable (database handoff)');
    } else if (
      swept.preferenceHistory +
        swept.recipientGroups +
        swept.memoryShowLess +
        swept.memoryCurations +
        swept.peopleAndPets +
        swept.workspaceLayouts >
      0
    ) {
      this.logger.log(
        `Swept fork rows of removed accounts: ${swept.preferenceHistory} preference history entries, ${swept.recipientGroups} recipient groups, ${swept.memoryShowLess} memory show-less rules, ${swept.memoryCurations} memory curations, ${swept.peopleAndPets} face correction, merge answer and pet recognition rows, ${swept.workspaceLayouts} Studio workspace layouts`,
      );
    }
    return JobStatus.Success;
  }

  @OnJob({ name: JobName.UserDelete, queue: QueueName.BackgroundTask })
  async handleUserDelete({ id, force }: JobOf<JobName.UserDelete>) {
    const config = await this.getConfig({ withCache: false });
    const user = await this.userRepository.get(id, { withDeleted: true });
    if (!user) {
      return;
    }

    // FL-71: checked against the account as it is now, since a failed deletion can be retried after
    // the account was restored. A forced removal (UserAdminService.delete) marks it Removing.
    const ready = force
      ? !!user.deletedAt && user.status === UserStatus.Removing
      : this.isReadyForDeletion(user, config.user.deleteDelay);
    if (!ready) {
      this.logger.warn(`Skipped user that was not ready for deletion: id=${id}`);
      return;
    }

    // FL-44 (FN-304): the account physical deduplication retains originals in holds files other
    // accounts point at; it stays until another account is chosen (UserAdminService refuses too).
    if (config.physicalDeduplication.masterUserId === user.id) {
      this.logger.error(
        `Skipped deleting user ${user.id}: it retains the originals shared by physical deduplication; choose another account first`,
      );
      return;
    }

    this.logger.log(`Deleting user: ${user.id}`);

    this.logger.warn(`Removing user from database: ${user.id}`);
    const removedAssets = (await this.assetRepository.deleteAll(user.id)) ?? [];
    const originalFiles = removedAssets
      .filter(({ libraryId, isOffline }) => !libraryId && !isOffline)
      .flatMap(({ originalPath, reservationTemporaryPath }) =>
        reservationTemporaryPath ? [originalPath, reservationTemporaryPath] : [originalPath],
      );
    if (originalFiles.length > 0) {
      await this.jobRepository.queue({ name: JobName.FileDelete, data: { files: originalFiles } });
    }

    // FL-44 (FN-304): media folders can hold files other accounts still reference — a deduplicated
    // original or derivative, a fork mapping's upstream path, a retained render. Each file goes
    // through the same reference-guarded delete as FileDelete, and only emptied folders are removed.
    const sharedFolders = [
      StorageCore.getLibraryFolder(user),
      StorageCore.getFolderLocation(StorageFolder.Upload, user.id),
      StorageCore.getFolderLocation(StorageFolder.Thumbnails, user.id),
      StorageCore.getFolderLocation(StorageFolder.EncodedVideo, user.id),
    ];
    for (const folder of sharedFolders) {
      this.logger.warn(`Removing user from filesystem: ${folder}`);
      await this.removeUnreferencedFiles(folder);
    }

    const privateFolders = [
      StorageCore.getFolderLocation(StorageFolder.Profile, user.id),
      // Owner-private export artefacts: bundles, uploads and staged Studio renders (FL-62, FL-91, FL-106).
      StorageCore.getFolderLocation(StorageFolder.Exports, user.id),
    ];
    for (const folder of privateFolders) {
      this.logger.warn(`Removing user from filesystem: ${folder}`);
      await this.storageRepository.unlinkDir(folder, { recursive: true, force: true });
    }

    await this.albumRepository.deleteAll(user.id);
    await this.albumUserRepository.forgetRecipient(user.id);
    // FL-71 (CC-10): the account's own preference history goes with it. While the fork schema is
    // not writable it stays behind and the next user cleanup sweeps it (handleUserDeleteCheck).
    if (!(await this.userRepository.deletePreferenceHistory(user.id))) {
      this.logger.warn(`Preference history of user ${user.id} kept until the fork schema is writable again`);
    }
    await this.userRepository.delete(user, true);

    await this.eventRepository.emit('UserDelete', user);
  }

  /**
   * Deletes every file under `folder` that nothing references any more, then the folders left empty.
   * A file another account still references is kept, and so is the folder holding it.
   */
  private async removeUnreferencedFiles(folder: string) {
    let kept = 0;
    for await (const file of this.storageRepository.walkFiles(folder)) {
      const { deleted } = await this.physicalFileRepository.deleteUnreferencedPath(file, () =>
        this.storageRepository.unlink(file),
      );
      if (!deleted) {
        kept++;
      }
    }
    if (kept > 0) {
      this.logger.warn(`Kept ${kept} file(s) in ${folder} that other accounts still reference`);
    }
    try {
      await this.storageRepository.removeEmptyDirs(folder, true);
    } catch (error: any) {
      if (error?.code !== 'ENOENT') {
        throw error;
      }
    }
  }

  private isReadyForDeletion(user: { id: string; deletedAt?: Date | null }, delayUntilDeletion: number): boolean {
    if (!user.deletedAt) {
      return false;
    }

    return DateTime.now().minus({ days: delayUntilDeletion }) > DateTime.fromJSDate(user.deletedAt);
  }

  private findOrFail(id: string, options: UserFindOptions) {
    return findOrFail(() => this.userRepository.get(id, options), 'User');
  }
}
