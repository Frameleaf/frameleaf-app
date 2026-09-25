import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { UserAdmin } from 'src/database.js';
import { AssetVisibility, CacheControl, CalendarHeatmapType, JobName, UserMetadataKey, UserStatus } from 'src/enum.js';
import { UserService, describePreferenceChanges } from 'src/services/user.service.js';
import { UserMetadataItem } from 'src/types.js';
import { ImmichFileResponse } from 'src/utils/file.js';
import { getPreferences, getPreferencesRevision } from 'src/utils/preferences.js';
import { AssetFactory } from 'test/factories/asset.factory.js';
import { AuthFactory } from 'test/factories/auth.factory.js';
import { UserFactory } from 'test/factories/user.factory.js';
import { authStub } from 'test/fixtures/auth.stub.js';
import { systemConfigStub } from 'test/fixtures/system-config.stub.js';
import { userStub } from 'test/fixtures/user.stub.js';
import { ServiceMocks, newTestService } from 'test/utils.js';

const makeDeletedAt = (daysAgo: number) => {
  const deletedAt = new Date();
  deletedAt.setDate(deletedAt.getDate() - daysAgo);
  return deletedAt;
};

describe(UserService.name, () => {
  let sut: UserService;
  let mocks: ServiceMocks;

  beforeEach(() => {
    ({ sut, mocks } = newTestService(UserService));
    mocks.user.get.mockImplementation((userId) =>
      Promise.resolve([userStub.admin, userStub.user1].find((user) => user.id === userId) ?? undefined),
    );
  });

  describe('getAll', () => {
    it('admin should get all users', async () => {
      const user = UserFactory.create();
      const auth = AuthFactory.create(user);

      mocks.user.getList.mockResolvedValue([user]);

      await expect(sut.search(auth)).resolves.toEqual([expect.objectContaining({ id: user.id, email: user.email })]);

      expect(mocks.user.getList).toHaveBeenCalledWith({ withDeleted: false });
    });

    it('non-admin should get all users when publicUsers enabled', async () => {
      const user = UserFactory.create();
      const auth = AuthFactory.create(user);

      mocks.user.getList.mockResolvedValue([user]);

      await expect(sut.search(auth)).resolves.toEqual([expect.objectContaining({ id: user.id, email: user.email })]);

      expect(mocks.user.getList).toHaveBeenCalledWith({ withDeleted: false });
    });

    it('non-admin user should only receive itself when publicUsers is disabled', async () => {
      mocks.user.getList.mockResolvedValue([userStub.user1]);
      mocks.systemMetadata.get.mockResolvedValue(systemConfigStub.publicUsersDisabled);

      await expect(sut.search(authStub.user1)).resolves.toEqual([
        expect.objectContaining({
          id: authStub.user1.user.id,
          email: authStub.user1.user.email,
        }),
      ]);

      expect(mocks.user.getList).not.toHaveBeenCalledWith({ withDeleted: false });
    });
  });

  describe('get', () => {
    it('should get a user by id', async () => {
      mocks.user.get.mockResolvedValue(userStub.admin);

      await sut.get(authStub.admin.user.id);

      expect(mocks.user.get).toHaveBeenCalledWith(authStub.admin.user.id, { withDeleted: false });
    });

    it('should throw an error if a user is not found', async () => {
      mocks.user.get.mockResolvedValue(void 0);

      await expect(sut.get(authStub.admin.user.id)).rejects.toBeInstanceOf(BadRequestException);

      expect(mocks.user.get).toHaveBeenCalledWith(authStub.admin.user.id, { withDeleted: false });
    });
  });

  describe('getMe', () => {
    it("should get the auth user's info", async () => {
      const user = authStub.admin.user;

      await expect(sut.getMe(authStub.admin)).resolves.toMatchObject({
        id: user.id,
        email: user.email,
      });
    });
  });

  describe('getCalendarHeatmap', () => {
    it('should leave Locked media out of an ordinary session', async () => {
      const auth = AuthFactory.create();
      mocks.asset.getCalendarHeatmap.mockResolvedValue([]);

      await sut.getCalendarHeatmap(auth, { type: CalendarHeatmapType.Upload });

      expect(mocks.asset.getCalendarHeatmap).toHaveBeenCalledWith(
        auth.user.id,
        expect.not.objectContaining({ lockedOwnerId: expect.anything() }),
      );
    });

    it("should count the caller's own Locked media only in an elevated session", async () => {
      const auth = AuthFactory.from().session({ hasElevatedPermission: true }).build();
      mocks.asset.getCalendarHeatmap.mockResolvedValue([]);

      await sut.getCalendarHeatmap(auth, { type: CalendarHeatmapType.Upload });

      expect(mocks.asset.getCalendarHeatmap).toHaveBeenCalledWith(
        auth.user.id,
        expect.objectContaining({ lockedOwnerId: auth.user.id }),
      );
    });
  });

  describe('createProfileImage', () => {
    it('should throw an error if the user does not exist', async () => {
      const file = { path: '/profile/path' } as Express.Multer.File;

      mocks.user.get.mockResolvedValue(void 0);
      mocks.user.update.mockResolvedValue({ ...userStub.admin, profileImagePath: file.path });

      await expect(sut.createProfileImage(authStub.admin, file)).rejects.toThrowError(BadRequestException);
    });

    it('should throw an error if the user profile could not be updated with the new image', async () => {
      const file = { path: '/profile/path' } as Express.Multer.File;
      const user = UserFactory.create({ profileImagePath: '/path/to/profile.jpg' });
      mocks.user.get.mockResolvedValue(user);
      mocks.user.update.mockRejectedValue(new InternalServerErrorException('mocked error'));

      await expect(sut.createProfileImage(authStub.admin, file)).rejects.toThrowError(InternalServerErrorException);
    });

    it('should throw BadRequestException and clean up raw upload when thumbnail processing fails', async () => {
      const file = { path: '/profile/path' } as Express.Multer.File;
      const user = UserFactory.create({ profileImagePath: '/path/to/profile.jpg' });

      mocks.user.get.mockResolvedValue(user);
      mocks.media.generateThumbnail.mockRejectedValue(new Error('not an image'));

      await expect(sut.createProfileImage(authStub.admin, file)).rejects.toThrowError(BadRequestException);

      expect(mocks.user.update).not.toHaveBeenCalled();
      expect(mocks.job.queue.mock.calls).toEqual([[{ name: JobName.FileDelete, data: { files: [file.path] } }]]);
    });

    it('should delete the raw upload and the previous profile image', async () => {
      const user = UserFactory.create({ profileImagePath: '/path/to/profile.jpg' });
      const file = { path: '/profile/path' } as Express.Multer.File;

      mocks.user.get.mockResolvedValue(user);
      mocks.user.update.mockResolvedValue({ ...userStub.admin, profileImagePath: file.path });

      await sut.createProfileImage(authStub.admin, file);

      expect(mocks.job.queue.mock.calls).toEqual([
        [{ name: JobName.FileDelete, data: { files: [file.path, user.profileImagePath] } }],
      ]);
    });

    it('should delete only the raw upload if no previous profile image is set', async () => {
      const file = { path: '/profile/path' } as Express.Multer.File;

      mocks.user.get.mockResolvedValue(userStub.admin);
      mocks.user.update.mockResolvedValue({ ...userStub.admin, profileImagePath: file.path });

      await sut.createProfileImage(authStub.admin, file);

      expect(mocks.job.queue.mock.calls).toEqual([[{ name: JobName.FileDelete, data: { files: [file.path] } }]]);
      expect(mocks.job.queueAll).not.toHaveBeenCalled();
    });

    it('records nothing as the source of an uploaded picture', async () => {
      const file = { path: '/profile/path' } as Express.Multer.File;
      mocks.user.get.mockResolvedValue(userStub.admin);
      mocks.user.update.mockResolvedValue({ ...userStub.admin, profileImagePath: file.path });

      await sut.createProfileImage(authStub.admin, file);

      expect(mocks.user.update).toHaveBeenCalledWith(
        authStub.admin.user.id,
        expect.objectContaining({ profileImageAssetId: null }),
      );
    });

    it('records the photo a picture was copied from (FL-53)', async () => {
      const file = { path: '/profile/path' } as Express.Multer.File;
      const asset = AssetFactory.create({ ownerId: authStub.admin.user.id });
      mocks.user.get.mockResolvedValue(userStub.admin);
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([asset.id]));
      mocks.asset.getById.mockResolvedValue(asset as never);
      mocks.user.update.mockResolvedValue({ ...userStub.admin, profileImagePath: file.path });

      await sut.createProfileImage(authStub.admin, file, { assetId: asset.id });

      expect(mocks.user.update).toHaveBeenCalledWith(
        authStub.admin.user.id,
        expect.objectContaining({ profileImageAssetId: asset.id }),
      );
    });

    it('refuses a Locked photo as the source and removes the upload (FL-53)', async () => {
      const file = { path: '/profile/path' } as Express.Multer.File;
      const asset = AssetFactory.create({ ownerId: authStub.admin.user.id, visibility: AssetVisibility.Locked });
      mocks.user.get.mockResolvedValue(userStub.admin);
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([asset.id]));
      mocks.asset.getById.mockResolvedValue(asset as never);

      await expect(sut.createProfileImage(authStub.admin, file, { assetId: asset.id })).rejects.toThrow(
        'A Locked photo cannot be a profile picture',
      );

      expect(mocks.media.generateThumbnail).not.toHaveBeenCalled();
      expect(mocks.user.update).not.toHaveBeenCalled();
      expect(mocks.job.queue.mock.calls).toEqual([[{ name: JobName.FileDelete, data: { files: [file.path] } }]]);
    });

    it('refuses a source photo the caller may not read and removes the upload (FL-53)', async () => {
      const file = { path: '/profile/path' } as Express.Multer.File;
      const asset = AssetFactory.create();
      mocks.user.get.mockResolvedValue(userStub.admin);

      await expect(sut.createProfileImage(authStub.admin, file, { assetId: asset.id })).rejects.toBeInstanceOf(
        BadRequestException,
      );

      expect(mocks.user.update).not.toHaveBeenCalled();
      expect(mocks.job.queue.mock.calls).toEqual([[{ name: JobName.FileDelete, data: { files: [file.path] } }]]);
    });

    it("refuses another account's photo as the source and removes the upload", async () => {
      const file = { path: '/profile/path' } as Express.Multer.File;
      const asset = AssetFactory.create({ ownerId: 'partner-id' });
      mocks.user.get.mockResolvedValue(userStub.admin);
      mocks.access.asset.checkPartnerAccess.mockResolvedValue(new Set([asset.id]));
      mocks.asset.getById.mockResolvedValue(asset as never);

      await expect(sut.createProfileImage(authStub.admin, file, { assetId: asset.id })).rejects.toThrow(
        'Only your own photo can be a profile picture',
      );

      expect(mocks.user.update).not.toHaveBeenCalled();
      expect(mocks.job.queue.mock.calls).toEqual([[{ name: JobName.FileDelete, data: { files: [file.path] } }]]);
    });

    it('keeps the recorded source when re-cropping the current picture', async () => {
      const file = { path: '/profile/path' } as Express.Multer.File;
      mocks.user.get.mockResolvedValue(userStub.admin);
      mocks.user.update.mockResolvedValue({ ...userStub.admin, profileImagePath: file.path });

      await sut.createProfileImage(authStub.admin, file, { keepSource: 'true' });

      expect(mocks.user.update).toHaveBeenCalledWith(
        authStub.admin.user.id,
        expect.not.objectContaining({ profileImageAssetId: expect.anything() }),
      );
      expect(mocks.user.update.mock.calls[0][1]).not.toHaveProperty('profileImageAssetId');
    });

    it('refuses a source that is not an id and removes the upload (FL-53)', async () => {
      const file = { path: '/profile/path' } as Express.Multer.File;
      mocks.user.get.mockResolvedValue(userStub.admin);

      await expect(sut.createProfileImage(authStub.admin, file, { assetId: 'not-an-id' })).rejects.toThrow(
        'Invalid profile picture source',
      );

      expect(mocks.access.asset.checkOwnerAccess).not.toHaveBeenCalled();
      expect(mocks.job.queue.mock.calls).toEqual([[{ name: JobName.FileDelete, data: { files: [file.path] } }]]);
    });
  });

  describe('deleteProfileImage', () => {
    it('should send an http error has no profile image', async () => {
      mocks.user.get.mockResolvedValue(userStub.admin);

      await expect(sut.deleteProfileImage(authStub.admin)).rejects.toBeInstanceOf(BadRequestException);

      expect(mocks.job.queue).not.toHaveBeenCalled();
      expect(mocks.job.queueAll).not.toHaveBeenCalled();
    });

    it('should delete the profile image if user has one', async () => {
      const user = UserFactory.create({ profileImagePath: '/path/to/profile.jpg' });
      const files = [user.profileImagePath];

      mocks.user.get.mockResolvedValue(user);

      await sut.deleteProfileImage(authStub.admin);

      expect(mocks.job.queue.mock.calls).toEqual([[{ name: JobName.FileDelete, data: { files } }]]);
      expect(mocks.user.update).toHaveBeenCalledWith(
        authStub.admin.user.id,
        expect.objectContaining({ profileImagePath: '', profileImageAssetId: null }),
      );
    });
  });

  describe('getUserProfileImage', () => {
    it('should throw an error if the user does not exist', async () => {
      mocks.user.get.mockResolvedValue(void 0);

      await expect(sut.getProfileImage(userStub.admin.id)).rejects.toBeInstanceOf(NotFoundException);

      expect(mocks.user.get).toHaveBeenCalledWith(userStub.admin.id, {});
    });

    it('should throw an error if the user does not have a picture', async () => {
      mocks.user.get.mockResolvedValue(userStub.admin);

      await expect(sut.getProfileImage(userStub.admin.id)).rejects.toBeInstanceOf(NotFoundException);

      expect(mocks.user.get).toHaveBeenCalledWith(userStub.admin.id, {});
    });

    it('should return the profile picture', async () => {
      const user = UserFactory.create({ profileImagePath: '/path/to/profile.jpg' });
      mocks.user.get.mockResolvedValue(user);

      await expect(sut.getProfileImage(user.id)).resolves.toEqual(
        new ImmichFileResponse({
          path: '/path/to/profile.jpg',
          contentType: 'image/jpeg',
          cacheControl: CacheControl.None,
        }),
      );

      expect(mocks.user.get).toHaveBeenCalledWith(user.id, {});
    });

    it('never serves a picture copied from a photo that became Locked (FL-53)', async () => {
      const user = UserFactory.create({ profileImagePath: '/path/to/profile.jpg' });
      mocks.user.get.mockResolvedValue(user);
      mocks.user.hasLockedProfileImageSource.mockResolvedValue(true);

      await expect(sut.getProfileImage(user.id)).rejects.toBeInstanceOf(NotFoundException);

      expect(mocks.user.hasLockedProfileImageSource).toHaveBeenCalledWith(user.id);
    });

    it('should return the profile picture with the content-type matching the stored file', async () => {
      const user = UserFactory.create({ profileImagePath: '/path/to/profile.webp' });
      mocks.user.get.mockResolvedValue(user);

      await expect(sut.getProfileImage(user.id)).resolves.toEqual(
        new ImmichFileResponse({
          path: '/path/to/profile.webp',
          contentType: 'image/webp',
          cacheControl: CacheControl.None,
        }),
      );
    });
  });

  describe('handleQueueUserDelete', () => {
    it('should skip users not ready for deletion', async () => {
      mocks.user.getDeletedAfter.mockResolvedValue([]);

      await sut.handleUserDeleteCheck();

      expect(mocks.user.getDeletedAfter).toHaveBeenCalled();
      expect(mocks.job.queue).not.toHaveBeenCalled();
      expect(mocks.job.queueAll).toHaveBeenCalledWith([]);
    });

    it('should queue user ready for deletion', async () => {
      const user = UserFactory.create();
      mocks.user.getDeletedAfter.mockResolvedValue([{ id: user.id }]);

      await sut.handleUserDeleteCheck();

      expect(mocks.user.getDeletedAfter).toHaveBeenCalled();
      expect(mocks.job.queueAll).toHaveBeenCalledWith([{ name: JobName.UserDelete, data: { id: user.id } }]);
    });

    it('sweeps fork rows of removed accounts, and warns while the fork schema is not writable (FL-71)', async () => {
      mocks.user.getDeletedAfter.mockResolvedValue([]);
      mocks.user.sweepRemovedAccountForkRows.mockResolvedValue({
        preferenceHistory: 2,
        recipientGroups: 1,
        memoryShowLess: 3,
        memoryCurations: 4,
        peopleAndPets: 3,
        workspaceLayouts: 1,
        utilityActivity: 5,
      });

      await sut.handleUserDeleteCheck();
      expect(mocks.user.sweepRemovedAccountForkRows).toHaveBeenCalled();
      expect(mocks.logger.warn).not.toHaveBeenCalled();
      expect(mocks.logger.log).toHaveBeenCalledWith(
        expect.stringContaining('3 memory show-less rules, 4 memory curations'),
      );
      expect(mocks.logger.log).toHaveBeenCalledWith(expect.stringContaining('5 utility activity entries'));

      mocks.user.sweepRemovedAccountForkRows.mockResolvedValue(undefined);
      await sut.handleUserDeleteCheck();
      expect(mocks.logger.warn).toHaveBeenCalledWith(expect.stringContaining('not swept'));
    });
  });

  describe('handleUserDelete', () => {
    beforeEach(() => {
      mocks.albumUser.forgetRecipient.mockResolvedValue();
      mocks.user.deletePreferenceHistory.mockResolvedValue(true);
    });

    it('should skip users not ready for deletion', async () => {
      const user = { id: 'user-1', deletedAt: makeDeletedAt(5) } as UserAdmin;

      mocks.user.get.mockResolvedValue(user);

      await sut.handleUserDelete({ id: user.id });

      expect(mocks.storage.unlinkDir).not.toHaveBeenCalled();
      expect(mocks.user.delete).not.toHaveBeenCalled();
    });

    it('should delete the user and associated assets', async () => {
      const user = { id: 'deleted-user', deletedAt: makeDeletedAt(10) } as UserAdmin;
      const options = { force: true, recursive: true };

      mocks.user.get.mockResolvedValue(user);

      await sut.handleUserDelete({ id: user.id });

      // FL-44: media folders are emptied file by file through the reference guard, never recursively
      for (const folder of ['library', 'upload', 'thumbs', 'encoded-video']) {
        expect(mocks.storage.walkFiles).toHaveBeenCalledWith(expect.stringContaining(`/data/${folder}/deleted-user`));
        expect(mocks.storage.removeEmptyDirs).toHaveBeenCalledWith(
          expect.stringContaining(`/data/${folder}/deleted-user`),
          true,
        );
        expect(mocks.storage.unlinkDir).not.toHaveBeenCalledWith(
          expect.stringContaining(`/data/${folder}/deleted-user`),
          expect.anything(),
        );
      }
      expect(mocks.storage.unlinkDir).toHaveBeenCalledWith(
        expect.stringContaining('/data/profile/deleted-user'),
        options,
      );
      expect(mocks.storage.unlinkDir).toHaveBeenCalledWith(
        expect.stringContaining('/data/exports/deleted-user'),
        options,
      );
      expect(mocks.album.deleteAll).toHaveBeenCalledWith(user.id);
      // FL-55: the account's recipient groups go, and it leaves everyone else's.
      expect(mocks.albumUser.forgetRecipient).toHaveBeenCalledWith(user.id);
      // FL-71 (CC-10): and its own preference history.
      expect(mocks.user.deletePreferenceHistory).toHaveBeenCalledWith(user.id);
      expect(mocks.asset.deleteAll).toHaveBeenCalledWith(user.id);
      expect(mocks.user.delete).toHaveBeenCalledWith(user, true);
      expect(mocks.asset.deleteAll.mock.invocationCallOrder[0]).toBeLessThan(
        mocks.user.delete.mock.invocationCallOrder[0]!,
      );
    });

    it('should delete the library path for a storage label', async () => {
      const user = { id: 'deleted-user', deletedAt: makeDeletedAt(10), storageLabel: 'admin' } as UserAdmin;

      mocks.user.get.mockResolvedValue(user);

      await sut.handleUserDelete({ id: user.id });

      expect(mocks.storage.walkFiles).toHaveBeenCalledWith(expect.stringContaining('data/library/admin'));
    });

    it('keeps files another account still references and deletes the rest (FL-44)', async () => {
      const user = { id: 'deleted-user', deletedAt: makeDeletedAt(10) } as UserAdmin;
      mocks.user.get.mockResolvedValue(user);
      const shared = '/data/library/deleted-user/2024/shared.jpg';
      const own = '/data/library/deleted-user/2024/own.jpg';
      mocks.storage.walkFiles.mockImplementation((folder: string) =>
        (async function* () {
          yield* await Promise.resolve(folder.endsWith('/library/deleted-user') ? [shared, own] : []);
        })(),
      );
      mocks.physicalFile.deleteUnreferencedPath.mockImplementation(async (path, unlink) => {
        if (path === shared) {
          return { deleted: false, references: 1 };
        }
        await unlink();
        return { deleted: true, references: 0 };
      });

      await sut.handleUserDelete({ id: user.id });

      expect(mocks.physicalFile.deleteUnreferencedPath).toHaveBeenCalledWith(shared, expect.any(Function));
      expect(mocks.physicalFile.deleteUnreferencedPath).toHaveBeenCalledWith(own, expect.any(Function));
      expect(mocks.storage.unlink).toHaveBeenCalledWith(own);
      expect(mocks.storage.unlink).not.toHaveBeenCalledWith(shared);
      expect(mocks.logger.warn).toHaveBeenCalledWith(expect.stringContaining('Kept 1 file(s)'));
      expect(mocks.user.delete).toHaveBeenCalledWith(user, true);
    });

    it('never deletes the account physical deduplication retains originals in (FL-44)', async () => {
      const user = { id: 'retained-user', deletedAt: makeDeletedAt(10) } as UserAdmin;
      mocks.user.get.mockResolvedValue(user);
      mocks.systemMetadata.get.mockResolvedValue({
        physicalDeduplication: { enabled: true, masterUserId: user.id },
      });

      await sut.handleUserDelete({ id: user.id });

      expect(mocks.asset.deleteAll).not.toHaveBeenCalled();
      expect(mocks.storage.walkFiles).not.toHaveBeenCalled();
      expect(mocks.storage.unlinkDir).not.toHaveBeenCalled();
      expect(mocks.user.delete).not.toHaveBeenCalled();
      expect(mocks.logger.error).toHaveBeenCalledWith(expect.stringContaining('retains the originals'));
    });

    it('removes an account an administrator removed now (force) at once (FL-71)', async () => {
      const user = { id: 'deleted-user', deletedAt: makeDeletedAt(0), status: UserStatus.Removing } as UserAdmin;
      mocks.user.get.mockResolvedValue(user);

      await sut.handleUserDelete({ id: user.id, force: true });

      expect(mocks.user.delete).toHaveBeenCalledWith(user, true);
    });

    it('keeps an account restored since a forced removal was queued, when that job is retried (FL-71)', async () => {
      const user = { id: 'deleted-user', deletedAt: null, status: UserStatus.Active } as UserAdmin;
      mocks.user.get.mockResolvedValue(user);

      await sut.handleUserDelete({ id: user.id, force: true });

      expect(mocks.asset.deleteAll).not.toHaveBeenCalled();
      expect(mocks.storage.unlinkDir).not.toHaveBeenCalled();
      expect(mocks.user.delete).not.toHaveBeenCalled();
    });

    it('leaves an account deleted again without "remove now" to the delete delay, when a forced removal is retried (FL-71)', async () => {
      const user = { id: 'deleted-user', deletedAt: makeDeletedAt(0), status: UserStatus.Deleted } as UserAdmin;
      mocks.user.get.mockResolvedValue(user);

      await sut.handleUserDelete({ id: user.id, force: true });

      expect(mocks.asset.deleteAll).not.toHaveBeenCalled();
      expect(mocks.user.delete).not.toHaveBeenCalled();
    });
  });

  describe('updateMyPreferences (FL-77 admin casting permission)', () => {
    const castTurnedOff = [
      { key: UserMetadataKey.Preferences, value: { cast: { gCastEnabled: true, adminDisabled: true } } },
    ] as unknown as UserMetadataItem[];

    beforeEach(() => {
      mocks.user.upsertMetadata.mockResolvedValue();
      mocks.session.requestSyncResetForUser.mockResolvedValue();
    });

    it('should refuse to turn casting on while an administrator has turned it off', async () => {
      mocks.user.getMetadata.mockResolvedValue(castTurnedOff);

      await expect(sut.updateMyPreferences(authStub.user1, { cast: { gCastEnabled: true } })).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(mocks.user.upsertMetadata).not.toHaveBeenCalled();
    });

    it('should report casting off and keep the stored choice when other preferences are saved', async () => {
      mocks.user.getMetadata.mockResolvedValue(castTurnedOff);

      await expect(
        sut.updateMyPreferences(authStub.user1, { cast: { gCastEnabled: false }, tags: { enabled: true } }),
      ).resolves.toMatchObject({ cast: { gCastEnabled: false, adminDisabled: true }, tags: { enabled: true } });
      // the third argument is the preferences-lock transaction (FL-67); the unit mock passes undefined
      expect(mocks.user.upsertMetadata).toHaveBeenCalledWith(
        authStub.user1.user.id,
        {
          key: UserMetadataKey.Preferences,
          value: expect.objectContaining({ cast: { gCastEnabled: true, adminDisabled: true } }),
        },
        undefined,
      );
    });

    it('should never let a user set the administrator flag', async () => {
      mocks.user.getMetadata.mockResolvedValue([]);

      await expect(
        sut.updateMyPreferences(authStub.user1, { cast: { gCastEnabled: true, adminDisabled: true } }),
      ).resolves.toMatchObject({ cast: { gCastEnabled: true, adminDisabled: false } });
      expect(mocks.user.upsertMetadata).toHaveBeenCalledWith(
        authStub.user1.user.id,
        { key: UserMetadataKey.Preferences, value: { cast: { gCastEnabled: true } } },
        undefined,
      );
    });

    it('should report casting off from getMyPreferences while an administrator has turned it off', async () => {
      mocks.user.getMetadata.mockResolvedValue(castTurnedOff);

      await expect(sut.getMyPreferences(authStub.user1)).resolves.toMatchObject({
        cast: { gCastEnabled: false, adminDisabled: true },
      });
    });

    it('should reject a save made against preferences an administrator changed since they were loaded', async () => {
      const loaded = getPreferencesRevision(getPreferences([]));
      mocks.user.getMetadata.mockResolvedValue(castTurnedOff);

      await expect(
        sut.updateMyPreferences(authStub.user1, { expectedRevision: loaded, tags: { enabled: true } }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(mocks.user.upsertMetadata).not.toHaveBeenCalled();
    });

    it('should apply a save made against the current revision without storing the revision', async () => {
      mocks.user.getMetadata.mockResolvedValue(castTurnedOff);
      const { revision } = await sut.getMyPreferences(authStub.user1);

      await expect(
        sut.updateMyPreferences(authStub.user1, { expectedRevision: revision, tags: { enabled: true } }),
      ).resolves.toMatchObject({ tags: { enabled: true } });
      expect(mocks.user.upsertMetadata).toHaveBeenCalledWith(
        authStub.user1.user.id,
        {
          key: UserMetadataKey.Preferences,
          value: { tags: { enabled: true }, cast: { gCastEnabled: true, adminDisabled: true } },
        },
        undefined,
      );
    });
  });

  describe('Locked rules (FL-67)', () => {
    const personId = 'c5f9f5a1-3b8d-4f6e-9a2b-0d1e2f3a4b5c';
    const tagId = '0b8f7e6d-5c4b-4a39-8281-7f6e5d4c3b2a';
    const storedRules = [
      {
        key: UserMetadataKey.Preferences,
        value: { privacy: { suppression: { personIds: [personId], tagIds: [tagId], scope: 'visible' } } },
      },
    ] as unknown as UserMetadataItem[];
    const unlocked = AuthFactory.from().session({ hasElevatedPermission: true }).build();

    beforeEach(() => {
      mocks.user.upsertMetadata.mockResolvedValue();
      mocks.session.requestSyncResetForUser.mockResolvedValue();
    });

    it('should refuse to change Locked rules from a session that is not unlocked', async () => {
      mocks.user.getMetadata.mockResolvedValue(storedRules);

      await expect(
        sut.updateMyPreferences(authStub.user1, { privacy: { suppression: { personIds: [] } } }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(mocks.database.withUserPreferencesLock).not.toHaveBeenCalled();
      expect(mocks.user.upsertMetadata).not.toHaveBeenCalled();
    });

    it('should refuse a scope change from a session that is not unlocked', async () => {
      await expect(
        sut.updateMyPreferences(authStub.user1, { privacy: { suppression: { scope: 'owned' } } }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('should still save other preferences from a session that is not unlocked', async () => {
      mocks.user.getMetadata.mockResolvedValue(storedRules);

      await expect(
        sut.updateMyPreferences(authStub.user1, { tags: { enabled: true }, privacy: { suppression: {} } }),
      ).resolves.toMatchObject({ tags: { enabled: true } });
      expect(mocks.user.upsertMetadata).toHaveBeenCalledWith(
        authStub.user1.user.id,
        {
          key: UserMetadataKey.Preferences,
          value: expect.objectContaining({
            privacy: { suppression: { personIds: [personId], tagIds: [tagId], scope: 'visible' } },
          }),
        },
        undefined,
      );
    });

    it('should change Locked rules from an unlocked session inside the preferences lock', async () => {
      mocks.user.getMetadata.mockResolvedValue(storedRules);

      await expect(
        sut.updateMyPreferences(unlocked, { privacy: { suppression: { personIds: [], tagIds: [tagId] } } }),
      ).resolves.toMatchObject({ privacy: { suppression: { personIds: [], tagIds: [tagId], scope: 'visible' } } });
      expect(mocks.database.withUserPreferencesLock).toHaveBeenCalledWith(unlocked.user.id, expect.any(Function));
      expect(mocks.user.getMetadata).toHaveBeenCalledWith(unlocked.user.id, undefined);
    });

    it('should refuse an unlocked save made against rules that changed in another tab', async () => {
      const loaded = getPreferencesRevision(getPreferences([]));
      mocks.user.getMetadata.mockResolvedValue(storedRules);

      await expect(
        sut.updateMyPreferences(unlocked, {
          expectedRevision: loaded,
          privacy: { suppression: { personIds: [personId] } },
        }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(mocks.user.upsertMetadata).not.toHaveBeenCalled();
    });

    it('should keep Locked people and tags out of reads from a session that is not unlocked', async () => {
      mocks.user.getMetadata.mockResolvedValue(storedRules);

      const locked = await sut.getMyPreferences(authStub.user1);
      const revealed = await sut.getMyPreferences(unlocked);

      expect(locked.privacy.suppression).toEqual({ tagIds: [], personIds: [], petIds: [], scope: 'visible' });
      expect(revealed.privacy.suppression).toMatchObject({ tagIds: [tagId], personIds: [personId] });
      // the revision covers the stored rules either way, so a stale save is still detected
      expect(locked.revision).toBe(revealed.revision);
      // FL-67: the response says whether the rules were revealed, so a client never edits blanked ones
      expect(locked.lockedRulesRevealed).toBe(false);
      expect(revealed.lockedRulesRevealed).toBe(true);
    });

    it('should keep Locked people and tags out of the response to a save from a session that is not unlocked', async () => {
      mocks.user.getMetadata.mockResolvedValue(storedRules);

      const response = await sut.updateMyPreferences(authStub.user1, { ratings: { enabled: true } });

      expect(response.privacy.suppression.personIds).toEqual([]);
      expect(response.privacy.suppression.tagIds).toEqual([]);
    });
  });

  describe('setLicense', () => {
    it('should save client license if valid', async () => {
      const license = { licenseKey: 'IMCL-license-key', activationKey: 'activation-key' };

      mocks.user.upsertMetadata.mockResolvedValue();

      await sut.setLicense(authStub.user1, license);

      expect(mocks.user.upsertMetadata).toHaveBeenCalledWith(authStub.user1.user.id, {
        key: UserMetadataKey.License,
        value: expect.any(Object),
      });
    });

    it('should save server license as client if valid', async () => {
      const license = { licenseKey: 'IMSV-license-key', activationKey: 'activation-key' };

      mocks.user.upsertMetadata.mockResolvedValue();

      await sut.setLicense(authStub.user1, license);

      expect(mocks.user.upsertMetadata).toHaveBeenCalledWith(authStub.user1.user.id, {
        key: UserMetadataKey.License,
        value: expect.any(Object),
      });
    });

    it('should not save license if invalid', async () => {
      const license = { licenseKey: 'license-key', activationKey: 'activation-key' };
      const call = sut.setLicense(authStub.admin, license);

      mocks.user.upsertMetadata.mockResolvedValue();

      await expect(call).rejects.toThrowError('Invalid license key');

      expect(mocks.user.upsertMetadata).not.toHaveBeenCalled();
    });
  });

  describe('deleteLicense', () => {
    it('should delete license', async () => {
      mocks.user.upsertMetadata.mockResolvedValue();

      await sut.deleteLicense(authStub.admin);

      expect(mocks.user.upsertMetadata).not.toHaveBeenCalled();
    });
  });

  describe('handleUserSyncUsage', () => {
    it('should sync usage', async () => {
      await sut.handleUserSyncUsage();

      expect(mocks.user.syncUsage).toHaveBeenCalledTimes(1);
    });
  });

  describe('preference history (FL-71 CC-10)', () => {
    beforeEach(() => {
      mocks.user.upsertMetadata.mockResolvedValue();
      mocks.session.requestSyncResetForUser.mockResolvedValue();
    });

    it('records what a save changed with the device that saved it', async () => {
      mocks.user.getMetadata.mockResolvedValue([]);
      mocks.session.getByUserId.mockResolvedValue([
        { id: authStub.user1.session!.id, deviceOS: 'macOS', deviceType: 'Web' },
      ] as never);

      await sut.updateMyPreferences(authStub.user1, { memories: { enabled: false } });

      expect(mocks.user.addPreferenceHistory).toHaveBeenCalledWith({
        userId: authStub.user1.user.id,
        deviceLabel: 'macOS · Web',
        changes: [{ path: 'memories.enabled', before: 'true', after: 'false' }],
        omittedChanges: 0,
      });
    });

    it('records nothing when nothing changed', async () => {
      mocks.user.getMetadata.mockResolvedValue([]);

      await sut.updateMyPreferences(authStub.user1, {});

      expect(mocks.user.addPreferenceHistory).not.toHaveBeenCalled();
    });

    it('never records the values of Locked-content rules, only that they changed', () => {
      const before = getPreferences([]);
      const after = {
        ...before,
        privacy: {
          ...before.privacy,
          suppression: { ...before.privacy.suppression, personIds: ['secret-person'] },
        },
      };

      const changes = describePreferenceChanges(before, after);

      expect(changes).toEqual([{ path: 'privacy.suppression', before: null, after: null, protected: true }]);
      expect(JSON.stringify(changes)).not.toContain('secret-person');
    });

    it('keeps the save when the history cannot be written', async () => {
      mocks.user.getMetadata.mockResolvedValue([]);
      mocks.user.addPreferenceHistory.mockRejectedValue(new Error('down'));

      await expect(sut.updateMyPreferences(authStub.user1, { tags: { enabled: true } })).resolves.toMatchObject({
        tags: { enabled: true },
      });
    });

    it("serves only the signed-in account's own history", async () => {
      mocks.user.getPreferenceHistory.mockResolvedValue([
        {
          id: 'entry-1',
          createdAt: new Date('2026-09-24T10:00:00.000Z'),
          deviceLabel: null,
          changes: [{ path: 'tags.enabled', before: 'false', after: 'true' }],
          omittedChanges: 0,
        },
      ]);

      await expect(sut.getMyPreferenceHistory(authStub.user1)).resolves.toEqual({
        entries: [
          {
            id: 'entry-1',
            createdAt: '2026-09-24T10:00:00.000Z',
            deviceLabel: null,
            changes: [{ path: 'tags.enabled', before: 'false', after: 'true' }],
            omittedChanges: 0,
          },
        ],
      });
      expect(mocks.user.getPreferenceHistory).toHaveBeenCalledWith(authStub.user1.user.id);
    });
  });

  describe('skipped fork writes are logged (FL-71)', () => {
    it('warns when the preference history is not recorded because the fork schema is not writable', async () => {
      mocks.user.upsertMetadata.mockResolvedValue();
      mocks.session.requestSyncResetForUser.mockResolvedValue();
      mocks.user.getMetadata.mockResolvedValue([]);
      mocks.session.getByUserId.mockResolvedValue([]);
      mocks.user.addPreferenceHistory.mockResolvedValue(false);

      await sut.updateMyPreferences(authStub.user1, { tags: { enabled: true } });

      expect(mocks.logger.warn).toHaveBeenCalledWith(expect.stringContaining('Preference history not recorded'));
    });
  });
});
