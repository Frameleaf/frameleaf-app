import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { describe } from 'vitest';
import { SALT_ROUNDS } from 'src/constants.js';
import { mapUserAdmin } from 'src/dtos/user.dto.js';
import { AssetVisibility, JobName, UserMetadataKey, UserStatus } from 'src/enum.js';
import { UserAdminService } from 'src/services/user-admin.service.js';
import { UserMetadataItem } from 'src/types.js';
import { getPreferences, getPreferencesRevision } from 'src/utils/preferences.js';
import { AuthFactory } from 'test/factories/auth.factory.js';
import { UserFactory } from 'test/factories/user.factory.js';
import { authStub } from 'test/fixtures/auth.stub.js';
import { userStub } from 'test/fixtures/user.stub.js';
import { ServiceMocks, newTestService } from 'test/utils.js';

describe(UserAdminService.name, () => {
  let sut: UserAdminService;
  let mocks: ServiceMocks;

  beforeEach(() => {
    ({ sut, mocks } = newTestService(UserAdminService));

    mocks.user.get.mockImplementation((userId) =>
      Promise.resolve([userStub.admin, userStub.user1].find((user) => user.id === userId) ?? undefined),
    );
  });

  describe('create', () => {
    it('should not create a user if there is no local admin account', async () => {
      mocks.user.getAdmin.mockResolvedValueOnce(void 0);

      await expect(
        sut.create({
          email: 'john_smith@email.com',
          name: 'John Smith',
          password: 'password',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('should create user', async () => {
      mocks.user.getAdmin.mockResolvedValue(userStub.admin);
      mocks.user.create.mockResolvedValue(userStub.user1);

      await expect(
        sut.create({
          email: userStub.user1.email,
          name: userStub.user1.name,
          password: 'password',
          storageLabel: 'label',
        }),
      ).resolves.toEqual(mapUserAdmin(userStub.user1));

      expect(mocks.user.getAdmin).toBeCalled();
      expect(mocks.user.create).toBeCalledWith({
        email: userStub.user1.email,
        name: userStub.user1.name,
        storageLabel: 'label',
        password: expect.anything(),
        clusterGroupId: expect.any(String),
      });
    });

    // FL-76: the create path accepted `pinCode` and stored it verbatim while `update`
    // hashed it, so a PIN set at creation could never verify and sat in the clear.
    it('should hash a pin code supplied at creation', async () => {
      mocks.user.getAdmin.mockResolvedValue(userStub.admin);
      mocks.user.create.mockResolvedValue(userStub.user1);
      mocks.crypto.hashBcrypt.mockImplementation((value) => Promise.resolve(`hashed:${value as string}`));

      await sut.create({
        email: userStub.user1.email,
        name: userStub.user1.name,
        password: 'password',
        pinCode: '123456',
      });

      expect(mocks.crypto.hashBcrypt).toHaveBeenCalledWith('123456', SALT_ROUNDS);
      expect(mocks.user.create).toBeCalledWith(
        expect.objectContaining({
          password: 'hashed:password',
          pinCode: 'hashed:123456',
        }),
      );
    });

    it('should not store a pin code when none is supplied at creation', async () => {
      mocks.user.getAdmin.mockResolvedValue(userStub.admin);
      mocks.user.create.mockResolvedValue(userStub.user1);

      await sut.create({
        email: userStub.user1.email,
        name: userStub.user1.name,
        password: 'password',
      });

      expect(mocks.user.create.mock.calls[0][0]).not.toHaveProperty('pinCode');
    });

    it('should require a password when oauth is disabled', async () => {
      mocks.systemMetadata.get.mockResolvedValue({ oauth: { enabled: false } });

      await expect(
        sut.create({
          email: 'john_smith@email.com',
          name: 'John Smith',
          password: '',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(mocks.user.create).not.toHaveBeenCalled();
    });

    it('should create a user without a password when oauth is enabled', async () => {
      mocks.systemMetadata.get.mockResolvedValue({ oauth: { enabled: true } });
      mocks.user.getAdmin.mockResolvedValue(userStub.admin);
      mocks.user.create.mockResolvedValue(userStub.user1);

      await sut.create({
        email: userStub.user1.email,
        name: userStub.user1.name,
        password: '',
      });

      expect(mocks.user.create).toHaveBeenCalled();
      expect(mocks.crypto.hashBcrypt).not.toHaveBeenCalled();
    });

    it('should reject a duplicate email', async () => {
      mocks.user.getByEmail.mockResolvedValue(userStub.user1);

      await expect(
        sut.create({
          email: userStub.user1.email,
          name: userStub.user1.name,
          password: 'password',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(mocks.user.create).not.toHaveBeenCalled();
    });
  });

  describe('update', () => {
    it('should update the user', async () => {
      const update = {
        shouldChangePassword: true,
        email: 'immich@test.com',
        storageLabel: 'storage_label',
      };
      mocks.user.getByEmail.mockResolvedValue(void 0);
      mocks.user.getByStorageLabel.mockResolvedValue(void 0);
      mocks.user.update.mockResolvedValue(userStub.user1);

      await sut.update(authStub.user1, userStub.user1.id, update);

      expect(mocks.user.getByEmail).toHaveBeenCalledWith(update.email);
      expect(mocks.user.getByStorageLabel).toHaveBeenCalledWith(update.storageLabel);
    });

    it('should not set an empty string for storage label', async () => {
      mocks.user.update.mockResolvedValue(userStub.user1);
      await sut.update(authStub.admin, userStub.user1.id, { storageLabel: '' });
      expect(mocks.user.update).toHaveBeenCalledWith(userStub.user1.id, {
        storageLabel: null,
        updatedAt: expect.any(Date),
      });
    });

    it('should not change an email to one already in use', async () => {
      const dto = { id: userStub.user1.id, email: 'updated@test.com' };

      mocks.user.get.mockResolvedValue(userStub.user1);
      mocks.user.getByEmail.mockResolvedValue(userStub.admin);

      await expect(sut.update(authStub.admin, userStub.user1.id, dto)).rejects.toBeInstanceOf(BadRequestException);

      expect(mocks.user.update).not.toHaveBeenCalled();
    });

    it('should not let the admin change the storage label to one already in use', async () => {
      const dto = { id: userStub.user1.id, storageLabel: 'admin' };

      mocks.user.get.mockResolvedValue(userStub.user1);
      mocks.user.getByStorageLabel.mockResolvedValue(userStub.admin);

      await expect(sut.update(authStub.admin, userStub.user1.id, dto)).rejects.toBeInstanceOf(BadRequestException);

      expect(mocks.user.update).not.toHaveBeenCalled();
    });

    it('should not let an admin change their own admin status', async () => {
      mocks.user.get.mockResolvedValue(userStub.admin);

      await expect(sut.update(authStub.admin, userStub.admin.id, { isAdmin: false })).rejects.toBeInstanceOf(
        BadRequestException,
      );

      expect(mocks.user.update).not.toHaveBeenCalled();
    });

    // FL-76: an admin-set PIN is hashed on this path; the matching create path is covered above.
    it('should hash a pin code and lock the account sessions', async () => {
      mocks.user.update.mockResolvedValue(userStub.user1);
      mocks.crypto.hashBcrypt.mockImplementation((value) => Promise.resolve(`hashed:${value as string}`));

      await sut.update(authStub.admin, userStub.user1.id, { pinCode: '123456' });

      expect(mocks.crypto.hashBcrypt).toHaveBeenCalledWith('123456', SALT_ROUNDS);
      expect(mocks.user.update).toHaveBeenCalledWith(userStub.user1.id, {
        pinCode: 'hashed:123456',
        updatedAt: expect.any(Date),
      });
      expect(mocks.session.lockAll).toHaveBeenCalledWith(userStub.user1.id);
    });

    it('should clear a pin code and lock the account sessions', async () => {
      mocks.user.update.mockResolvedValue(userStub.user1);

      await sut.update(authStub.admin, userStub.user1.id, { pinCode: null });

      expect(mocks.crypto.hashBcrypt).not.toHaveBeenCalled();
      expect(mocks.user.update).toHaveBeenCalledWith(userStub.user1.id, {
        pinCode: null,
        updatedAt: expect.any(Date),
      });
      expect(mocks.session.lockAll).toHaveBeenCalledWith(userStub.user1.id);
    });

    it('should leave sessions alone when the update does not mention the pin code', async () => {
      mocks.user.update.mockResolvedValue(userStub.user1);

      await sut.update(authStub.admin, userStub.user1.id, { name: 'New name' });

      expect(mocks.session.lockAll).not.toHaveBeenCalled();
    });

    it('update user information should throw error if user not found', async () => {
      mocks.user.get.mockResolvedValueOnce(void 0);

      await expect(
        sut.update(authStub.admin, userStub.user1.id, { shouldChangePassword: true }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('delete', () => {
    it('should throw error if user could not be found', async () => {
      mocks.user.get.mockResolvedValue(void 0);

      await expect(sut.delete(authStub.admin, 'not-found', {})).rejects.toThrowError(BadRequestException);
      expect(mocks.user.delete).not.toHaveBeenCalled();
    });

    it('cannot delete admin user', async () => {
      await expect(sut.delete(authStub.admin, userStub.admin.id, {})).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('should not allow deleting own account', async () => {
      const user = UserFactory.create({ isAdmin: false });
      const auth = AuthFactory.create(user);
      mocks.user.get.mockResolvedValue(user);
      await expect(sut.delete(auth, user.id, {})).rejects.toBeInstanceOf(ForbiddenException);

      expect(mocks.user.delete).not.toHaveBeenCalled();
    });

    it('should delete user', async () => {
      mocks.user.get.mockResolvedValue(userStub.user1);
      mocks.user.update.mockResolvedValue(userStub.user1);

      await expect(sut.delete(authStub.admin, userStub.user1.id, {})).resolves.toEqual(mapUserAdmin(userStub.user1));
      expect(mocks.user.update).toHaveBeenCalledWith(userStub.user1.id, {
        status: UserStatus.Deleted,
        deletedAt: expect.any(Date),
      });
    });

    it('should force delete user', async () => {
      mocks.user.get.mockResolvedValue(userStub.user1);
      mocks.user.update.mockResolvedValue(userStub.user1);

      await expect(sut.delete(authStub.admin, userStub.user1.id, { force: true })).resolves.toEqual(
        mapUserAdmin(userStub.user1),
      );

      expect(mocks.user.update).toHaveBeenCalledWith(userStub.user1.id, {
        status: UserStatus.Removing,
        deletedAt: expect.any(Date),
      });
      expect(mocks.job.queue).toHaveBeenCalledWith({
        name: JobName.UserDelete,
        data: { id: userStub.user1.id, force: true },
      });
    });
  });

  describe('restore', () => {
    it('should throw error if user could not be found', async () => {
      mocks.user.get.mockResolvedValue(void 0);
      await expect(sut.restore(authStub.admin, userStub.admin.id)).rejects.toThrowError(BadRequestException);
      expect(mocks.user.update).not.toHaveBeenCalled();
    });

    it('should restore an user', async () => {
      mocks.user.get.mockResolvedValue(userStub.user1);
      mocks.user.restore.mockResolvedValue(userStub.user1);
      await expect(sut.restore(authStub.admin, userStub.user1.id)).resolves.toEqual(mapUserAdmin(userStub.user1));
      expect(mocks.user.restore).toHaveBeenCalledWith(userStub.user1.id);
    });
  });

  describe('updatePreferences (FL-77 admin casting permission)', () => {
    const storedPreferences = (value: Record<string, unknown>) =>
      [{ key: UserMetadataKey.Preferences, value }] as unknown as UserMetadataItem[];

    beforeEach(() => {
      mocks.user.upsertMetadata.mockResolvedValue();
    });

    it("should turn casting off for a user without overwriting the user's own choice", async () => {
      mocks.user.getMetadata.mockResolvedValue(storedPreferences({ cast: { gCastEnabled: true } }));

      await expect(
        sut.updatePreferences(authStub.admin, userStub.user1.id, { cast: { adminDisabled: true } }),
      ).resolves.toMatchObject({ cast: { gCastEnabled: false, adminDisabled: true } });
      expect(mocks.user.upsertMetadata).toHaveBeenCalledWith(userStub.user1.id, {
        key: UserMetadataKey.Preferences,
        value: { cast: { gCastEnabled: true, adminDisabled: true } },
      });
    });

    it("should let the user's own choice apply again when casting is allowed", async () => {
      mocks.user.getMetadata.mockResolvedValue(
        storedPreferences({ cast: { gCastEnabled: true, adminDisabled: true } }),
      );

      await expect(
        sut.updatePreferences(authStub.admin, userStub.user1.id, { cast: { adminDisabled: false } }),
      ).resolves.toMatchObject({ cast: { gCastEnabled: true, adminDisabled: false } });
      expect(mocks.user.upsertMetadata).toHaveBeenCalledWith(userStub.user1.id, {
        key: UserMetadataKey.Preferences,
        value: { cast: { gCastEnabled: true } },
      });
    });

    it('should report the administrator decision from getPreferences', async () => {
      mocks.user.getMetadata.mockResolvedValue(storedPreferences({ cast: { adminDisabled: true } }));

      await expect(sut.getPreferences(authStub.admin, userStub.user1.id)).resolves.toMatchObject({
        cast: { gCastEnabled: false, adminDisabled: true },
      });
    });
  });

  describe('updatePreferences (FL-77 account preferences editor)', () => {
    const storedPreferences = (value: Record<string, unknown>) =>
      [{ key: UserMetadataKey.Preferences, value }] as unknown as UserMetadataItem[];
    const personId = 'c5f9f5a1-3b8d-4f6e-9a2b-0d1e2f3a4b5c';

    beforeEach(() => {
      mocks.user.upsertMetadata.mockResolvedValue();
    });

    it('should report a revision that a following save can send back', async () => {
      const metadata = storedPreferences({ memories: { duration: 9 } });
      mocks.user.getMetadata.mockResolvedValue(metadata);

      const loaded = await sut.getPreferences(authStub.admin, userStub.user1.id);
      expect(loaded.revision).toBe(getPreferencesRevision(getPreferences(metadata)));

      const saved = await sut.updatePreferences(authStub.admin, userStub.user1.id, {
        expectedRevision: loaded.revision,
        download: { archiveSize: 1_234_567 },
        people: { minimumFaces: 4 },
      });
      expect(saved).toMatchObject({ download: { archiveSize: 1_234_567 }, people: { minimumFaces: 4 } });
      expect(saved.revision).not.toBe(loaded.revision);
      expect(mocks.user.upsertMetadata).toHaveBeenCalledWith(userStub.user1.id, {
        key: UserMetadataKey.Preferences,
        value: { memories: { duration: 9 }, people: { minimumFaces: 4 }, download: { archiveSize: 1_234_567 } },
      });
    });

    it('should reject a save made against preferences that changed since they were loaded', async () => {
      const loaded = getPreferencesRevision(getPreferences([]));
      mocks.user.getMetadata.mockResolvedValue(storedPreferences({ emailNotifications: { enabled: false } }));

      await expect(
        sut.updatePreferences(authStub.admin, userStub.user1.id, {
          expectedRevision: loaded,
          emailNotifications: { enabled: true },
        }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(mocks.user.upsertMetadata).not.toHaveBeenCalled();
    });

    it("should never show or rewrite the account's Locked choices", async () => {
      mocks.user.getMetadata.mockResolvedValue(
        storedPreferences({ privacy: { suppression: { personIds: [personId] } } }),
      );

      await expect(sut.getPreferences(authStub.admin, userStub.user1.id)).resolves.toMatchObject({
        privacy: { suppression: { personIds: [], tagIds: [], petIds: [] } },
      });

      const saved = await sut.updatePreferences(authStub.admin, userStub.user1.id, {
        privacy: { suppression: { personIds: [] } },
        tags: { enabled: true },
      });
      expect(saved.privacy.suppression.personIds).toEqual([]);
      expect(mocks.user.upsertMetadata).toHaveBeenCalledWith(userStub.user1.id, {
        key: UserMetadataKey.Preferences,
        value: { tags: { enabled: true }, privacy: { suppression: { personIds: [personId] } } },
      });
    });
  });

  describe('getStatistics', () => {
    it("should refuse another user's Locked statistics, even to an elevated administrator (FL-34)", async () => {
      const auth = authStub.adminWithElevatedPermission;

      await expect(
        sut.getStatistics(auth, userStub.user1.id, { visibility: AssetVisibility.Locked }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(mocks.asset.getStatistics).not.toHaveBeenCalled();
    });

    it('should refuse the administrator their own Locked statistics without an elevated session', async () => {
      await expect(
        sut.getStatistics(authStub.admin, authStub.admin.user.id, { visibility: AssetVisibility.Locked }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(mocks.asset.getStatistics).not.toHaveBeenCalled();
    });

    it('should count other visibilities as before', async () => {
      mocks.asset.getStatistics.mockResolvedValue({ image: 1, video: 2, audio: 0, other: 0 } as any);

      await sut.getStatistics(authStub.admin, userStub.user1.id, { visibility: AssetVisibility.Timeline });
      expect(mocks.asset.getStatistics).toHaveBeenCalledWith(userStub.user1.id, {
        visibility: AssetVisibility.Timeline,
      });
    });
  });
});
