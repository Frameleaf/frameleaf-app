import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { describe } from 'vitest';
import { SALT_ROUNDS } from 'src/constants.js';
import { mapUserAdmin } from 'src/dtos/user.dto.js';
import { AdminAuditAction, AssetVisibility, JobName, UserMetadataKey, UserStatus } from 'src/enum.js';
import { UserAdminService } from 'src/services/user-admin.service.js';
import { UserMetadataItem } from 'src/types.js';
import { getPreferences, getPreferencesRevision } from 'src/utils/preferences.js';
import { AuthFactory } from 'test/factories/auth.factory.js';
import { SessionFactory } from 'test/factories/session.factory.js';
import { UserFactory } from 'test/factories/user.factory.js';
import { authStub } from 'test/fixtures/auth.stub.js';
import { userStub } from 'test/fixtures/user.stub.js';
import { newUuidV7 } from 'test/small.factory.js';
import { ServiceMocks, newTestService } from 'test/utils.js';

describe(UserAdminService.name, () => {
  let sut: UserAdminService;
  let mocks: ServiceMocks;

  beforeEach(() => {
    ({ sut, mocks } = newTestService(UserAdminService));

    mocks.user.get.mockImplementation((userId) =>
      Promise.resolve([userStub.admin, userStub.user1].find((user) => user.id === userId) ?? undefined),
    );

    // the session repository mock is strict: PIN changes lock sessions, deletion signs them out and
    // an administrator can revoke one (FL-76)
    mocks.session.lockAll.mockResolvedValue();
    mocks.session.invalidateAll.mockResolvedValue([]);
    mocks.session.delete.mockResolvedValue();
  });

  describe('create', () => {
    it('should not create a user if there is no local admin account', async () => {
      mocks.user.getAdmin.mockResolvedValueOnce(void 0);

      await expect(
        sut.create(authStub.admin, {
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
        sut.create(authStub.admin, {
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

      await sut.create(authStub.admin, {
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

      await sut.create(authStub.admin, {
        email: userStub.user1.email,
        name: userStub.user1.name,
        password: 'password',
      });

      expect(mocks.user.create.mock.calls[0][0]).not.toHaveProperty('pinCode');
    });

    it('should require a password when oauth is disabled', async () => {
      mocks.systemMetadata.get.mockResolvedValue({ oauth: { enabled: false } });

      await expect(
        sut.create(authStub.admin, {
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

      await sut.create(authStub.admin, {
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
        sut.create(authStub.admin, {
          email: userStub.user1.email,
          name: userStub.user1.name,
          password: 'password',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(mocks.user.create).not.toHaveBeenCalled();
    });

    it('should reject a duplicate storage label (FL-76)', async () => {
      mocks.user.getByEmail.mockResolvedValue(void 0);
      mocks.user.getAdmin.mockResolvedValue(userStub.admin);
      mocks.user.getByStorageLabel.mockResolvedValue(userStub.user1);

      await expect(
        sut.create(authStub.admin, {
          email: 'new@example.com',
          name: 'New',
          password: 'password',
          storageLabel: 'label',
        }),
      ).rejects.toThrow('Storage label already in use by another account');

      expect(mocks.user.create).not.toHaveBeenCalled();
    });

    it('should reject a storage label held by a soft-deleted account with a 400, not a 500 (FL-76)', async () => {
      mocks.user.getByEmail.mockResolvedValue(void 0);
      mocks.user.getAdmin.mockResolvedValue(userStub.admin);
      mocks.user.getByStorageLabel.mockResolvedValue({ ...userStub.user1, deletedAt: new Date() });

      await expect(
        sut.create(authStub.admin, {
          email: 'new@example.com',
          name: 'New',
          password: 'password',
          storageLabel: 'label',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(mocks.user.getByStorageLabel).toHaveBeenCalledWith('label', true);
      expect(mocks.user.create).not.toHaveBeenCalled();
    });
  });

  describe('update', () => {
    // FL-34 (ported from PR131 bb70ad841f): a credential reset revokes the target's elevation everywhere
    it.each([{ pinCode: null }, { pinCode: '654321' }, { password: 'new-password' }])(
      'revokes only the target user elevation after a credential update: %j',
      async (dto) => {
        mocks.user.update.mockResolvedValue(userStub.user1);
        mocks.session.lockAll.mockResolvedValue();

        await sut.update(authStub.admin, userStub.user1.id, dto);

        expect(mocks.session.lockAll).toHaveBeenCalledWith(userStub.user1.id);
        expect(mocks.websocket.clientSend).toHaveBeenCalledWith('on_session_lock', userStub.user1.id);
      },
    );

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
      expect(mocks.user.getByStorageLabel).toHaveBeenCalledWith(update.storageLabel, true);
      expect(mocks.session.lockAll).not.toHaveBeenCalled();
      expect(mocks.websocket.clientSend).not.toHaveBeenCalled();
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

    it('refuses to delete the account physical deduplication retains originals in (FL-44)', async () => {
      mocks.user.get.mockResolvedValue(userStub.user1);
      mocks.systemMetadata.get.mockResolvedValue({
        physicalDeduplication: { enabled: true, masterUserId: userStub.user1.id },
      });

      await expect(sut.delete(authStub.admin, userStub.user1.id, { force: true })).rejects.toThrow(
        /keeps the original files shared by physical deduplication/,
      );
      expect(mocks.user.update).not.toHaveBeenCalled();
      expect(mocks.album.softDeleteAll).not.toHaveBeenCalled();
      expect(mocks.job.queue).not.toHaveBeenCalled();
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

    it("should sign out the account's devices, so a restored account signs in again (FL-76)", async () => {
      mocks.user.get.mockResolvedValue(userStub.user1);
      mocks.user.update.mockResolvedValue(userStub.user1);
      mocks.session.invalidateAll.mockResolvedValue(['account-session']);

      await sut.delete(authStub.admin, userStub.user1.id, {});

      expect(mocks.session.invalidateAll).toHaveBeenCalledWith({ userId: userStub.user1.id });
      expect(mocks.event.emit).toHaveBeenCalledWith('SessionDelete', { sessionId: 'account-session' });
    });

    it('should leave sessions alone when the account cannot be deleted', async () => {
      await expect(sut.delete(authStub.admin, userStub.admin.id, {})).rejects.toBeInstanceOf(ForbiddenException);

      expect(mocks.session.invalidateAll).not.toHaveBeenCalled();
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
      // the third argument is the preferences-lock transaction (FL-67); the unit mock passes undefined
      expect(mocks.user.upsertMetadata).toHaveBeenCalledWith(
        userStub.user1.id,
        { key: UserMetadataKey.Preferences, value: { cast: { gCastEnabled: true, adminDisabled: true } } },
        undefined,
      );
    });

    it("should let the user's own choice apply again when casting is allowed", async () => {
      mocks.user.getMetadata.mockResolvedValue(
        storedPreferences({ cast: { gCastEnabled: true, adminDisabled: true } }),
      );

      await expect(
        sut.updatePreferences(authStub.admin, userStub.user1.id, { cast: { adminDisabled: false } }),
      ).resolves.toMatchObject({ cast: { gCastEnabled: true, adminDisabled: false } });
      expect(mocks.user.upsertMetadata).toHaveBeenCalledWith(
        userStub.user1.id,
        { key: UserMetadataKey.Preferences, value: { cast: { gCastEnabled: true } } },
        undefined,
      );
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
      expect(mocks.user.upsertMetadata).toHaveBeenCalledWith(
        userStub.user1.id,
        {
          key: UserMetadataKey.Preferences,
          value: { memories: { duration: 9 }, people: { minimumFaces: 4 }, download: { archiveSize: 1_234_567 } },
        },
        undefined,
      );
      expect(mocks.database.withUserPreferencesLock).toHaveBeenCalledWith(userStub.user1.id, expect.any(Function));
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
      expect(mocks.user.upsertMetadata).toHaveBeenCalledWith(
        userStub.user1.id,
        {
          key: UserMetadataKey.Preferences,
          value: { tags: { enabled: true }, privacy: { suppression: { personIds: [personId] } } },
        },
        undefined,
      );
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

  describe('getSessions (FL-76)', () => {
    it("marks the administrator's own session as current on their own account", async () => {
      const auth = authStub.adminWithElevatedPermission;
      const session = SessionFactory.create({ userId: userStub.admin.id, id: auth.session!.id });
      mocks.session.getByUserId.mockResolvedValue([session]);

      const [result] = await sut.getSessions(auth, userStub.admin.id);

      expect(result.current).toBe(true);
    });

    it("never marks another account's session as current", async () => {
      const auth = authStub.adminWithElevatedPermission;
      const session = SessionFactory.create({ userId: userStub.user1.id });
      mocks.session.getByUserId.mockResolvedValue([session]);

      const [result] = await sut.getSessions(auth, userStub.user1.id);

      expect(result.current).toBe(false);
    });
  });

  describe('deleteSession (FL-76)', () => {
    it('revokes a session that belongs to the account', async () => {
      const session = SessionFactory.create({ userId: userStub.user1.id });
      mocks.session.getByUserId.mockResolvedValue([session]);

      await sut.deleteSession(authStub.admin, userStub.user1.id, session.id);

      expect(mocks.session.delete).toHaveBeenCalledWith(session.id);
      expect(mocks.event.emit).toHaveBeenCalledWith('SessionDelete', { sessionId: session.id });
    });

    it('refuses a session id that belongs to a different account', async () => {
      const foreignSession = SessionFactory.create({ userId: userStub.admin.id });
      mocks.session.getByUserId.mockResolvedValue([]);

      await expect(sut.deleteSession(authStub.admin, userStub.user1.id, foreignSession.id)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(mocks.session.delete).not.toHaveBeenCalled();
      expect(mocks.event.emit).not.toHaveBeenCalledWith('SessionDelete', expect.anything());
    });
  });

  describe('administrator history (FL-76)', () => {
    const entry = (action: AdminAuditAction, detail: string | null = null) => ({
      userId: userStub.user1.id,
      actorId: authStub.admin.user.id,
      action,
      subject: userStub.user1.name,
      detail,
    });

    it('records who created an account', async () => {
      mocks.user.getAdmin.mockResolvedValue(userStub.admin);
      mocks.user.create.mockResolvedValue(userStub.user1);

      await sut.create(authStub.admin, { email: userStub.user1.email, name: userStub.user1.name, password: 'secret' });

      expect(mocks.adminAudit.create).toHaveBeenCalledWith([entry(AdminAuditAction.AccountCreated)]);
    });

    it('records role, quota and storage label changes as separate entries', async () => {
      mocks.user.update.mockResolvedValue({
        ...userStub.user1,
        isAdmin: true,
        quotaSizeInBytes: 1024,
        storageLabel: 'label',
      });

      await sut.update(authStub.admin, userStub.user1.id, {
        isAdmin: true,
        quotaSizeInBytes: 1024,
        storageLabel: 'label',
      });

      expect(mocks.adminAudit.create).toHaveBeenCalledWith([
        entry(AdminAuditAction.AdminGranted),
        entry(AdminAuditAction.QuotaChanged, '1024'),
        entry(AdminAuditAction.StorageLabelChanged, 'label'),
      ]);
    });

    it('records a password reset without the password', async () => {
      mocks.user.update.mockResolvedValue({ ...userStub.user1, shouldChangePassword: true });
      mocks.crypto.hashBcrypt.mockResolvedValue('hashed');

      await sut.update(authStub.admin, userStub.user1.id, { password: 'new-password', shouldChangePassword: true });

      expect(mocks.adminAudit.create).toHaveBeenCalledWith([entry(AdminAuditAction.PasswordReset, 'change-required')]);
      expect(JSON.stringify(mocks.adminAudit.create.mock.calls)).not.toContain('new-password');
      expect(JSON.stringify(mocks.adminAudit.create.mock.calls)).not.toContain('hashed');
    });

    it('records a PIN reset and a PIN set without the PIN', async () => {
      mocks.user.update.mockResolvedValue(userStub.user1);
      mocks.crypto.hashBcrypt.mockResolvedValue('hashed');

      await sut.update(authStub.admin, userStub.user1.id, { pinCode: null });
      await sut.update(authStub.admin, userStub.user1.id, { pinCode: '123456' });

      expect(mocks.adminAudit.create).toHaveBeenNthCalledWith(1, [entry(AdminAuditAction.PinReset)]);
      expect(mocks.adminAudit.create).toHaveBeenNthCalledWith(2, [entry(AdminAuditAction.PinSet)]);
      expect(JSON.stringify(mocks.adminAudit.create.mock.calls)).not.toContain('123456');
    });

    it('records nothing when an update changes nothing', async () => {
      mocks.user.update.mockResolvedValue(userStub.user1);

      await sut.update(authStub.admin, userStub.user1.id, { name: userStub.user1.name });

      expect(mocks.adminAudit.create).not.toHaveBeenCalled();
    });

    it('records a deletion with its recovery period', async () => {
      mocks.user.get.mockResolvedValue(userStub.user1);
      mocks.user.update.mockResolvedValue(userStub.user1);

      await sut.delete(authStub.admin, userStub.user1.id, {});

      expect(mocks.adminAudit.create).toHaveBeenCalledWith([entry(AdminAuditAction.AccountDeleted, '7')]);
    });

    it('records a permanent removal', async () => {
      mocks.user.get.mockResolvedValue(userStub.user1);
      mocks.user.update.mockResolvedValue(userStub.user1);

      await sut.delete(authStub.admin, userStub.user1.id, { force: true });

      expect(mocks.adminAudit.create).toHaveBeenCalledWith([entry(AdminAuditAction.AccountRemovalScheduled)]);
    });

    it('records a restore', async () => {
      mocks.user.restore.mockResolvedValue(userStub.user1);

      await sut.restore(authStub.admin, userStub.user1.id);

      expect(mocks.adminAudit.create).toHaveBeenCalledWith([entry(AdminAuditAction.AccountRestored)]);
    });

    it('records the device an administrator signed out', async () => {
      const session = SessionFactory.create({ userId: userStub.user1.id, deviceOS: 'iOS', deviceType: 'iPhone' });
      mocks.session.getByUserId.mockResolvedValue([session]);

      await sut.deleteSession(authStub.admin, userStub.user1.id, session.id);

      expect(mocks.adminAudit.create).toHaveBeenCalledWith([entry(AdminAuditAction.SessionRevoked, 'iOS · iPhone')]);
    });

    it('records turning casting off on its own, not as a preferences change', async () => {
      mocks.user.getMetadata.mockResolvedValue([]);
      mocks.user.upsertMetadata.mockResolvedValue();

      await sut.updatePreferences(authStub.admin, userStub.user1.id, { cast: { adminDisabled: true } });

      expect(mocks.adminAudit.create).toHaveBeenCalledWith([entry(AdminAuditAction.CastingDisabled)]);
    });

    it('records which preference sections a save changed', async () => {
      mocks.user.getMetadata.mockResolvedValue([]);
      mocks.user.upsertMetadata.mockResolvedValue();

      await sut.updatePreferences(authStub.admin, userStub.user1.id, {
        download: { archiveSize: 1_234_567 },
        tags: { enabled: true },
      });

      expect(mocks.adminAudit.create).toHaveBeenCalledWith([
        entry(AdminAuditAction.PreferencesUpdated, 'download,tags'),
      ]);
    });

    it('never fails the change when recording it fails', async () => {
      mocks.user.restore.mockResolvedValue(userStub.user1);
      mocks.adminAudit.create.mockRejectedValue(new Error('database unavailable'));

      await expect(sut.restore(authStub.admin, userStub.user1.id)).resolves.toEqual(mapUserAdmin(userStub.user1));
    });

    describe('getHistory', () => {
      const row = (createdAt: string) => ({
        id: newUuidV7(),
        userId: userStub.user1.id,
        actorId: authStub.admin.user.id,
        actorName: userStub.admin.name,
        libraryId: null,
        action: AdminAuditAction.PinReset,
        subject: userStub.user1.name,
        detail: null,
        createdAt: new Date(createdAt),
      });

      it('returns one page, newest first, and says an older page exists', async () => {
        const rows = [
          row('2026-09-03T00:00:00.000Z'),
          row('2026-09-02T00:00:00.000Z'),
          row('2026-09-01T00:00:00.000Z'),
        ];
        mocks.adminAudit.getByUserId.mockResolvedValue(rows);
        const before = newUuidV7();

        const result = await sut.getHistory(authStub.admin, userStub.user1.id, { before, take: 2 });

        expect(mocks.adminAudit.getByUserId).toHaveBeenCalledWith(userStub.user1.id, { before, take: 3 });
        expect(result.hasMore).toBe(true);
        expect(result.events).toEqual([
          expect.objectContaining({ id: rows[0].id, createdAt: '2026-09-03T00:00:00.000Z', actorName: 'admin_name' }),
          expect.objectContaining({ id: rows[1].id, createdAt: '2026-09-02T00:00:00.000Z' }),
        ]);
      });

      it('reports the last page', async () => {
        mocks.adminAudit.getByUserId.mockResolvedValue([row('2026-09-01T00:00:00.000Z')]);

        const result = await sut.getHistory(authStub.admin, userStub.user1.id, {});

        expect(mocks.adminAudit.getByUserId).toHaveBeenCalledWith(userStub.user1.id, { before: undefined, take: 51 });
        expect(result).toMatchObject({ hasMore: false, events: [expect.objectContaining({ action: 'pin-reset' })] });
      });

      it('refuses an unknown account', async () => {
        mocks.user.get.mockResolvedValue(void 0);

        await expect(sut.getHistory(authStub.admin, 'not-found', {})).rejects.toBeInstanceOf(BadRequestException);
        expect(mocks.adminAudit.getByUserId).not.toHaveBeenCalled();
      });
    });
  });

  describe('getPinCodeState (FL-76 CC-30)', () => {
    it('says whether the account has a PIN, and nothing else', async () => {
      mocks.user.hasPinCode.mockResolvedValue(true);

      await expect(sut.getPinCodeState(authStub.admin, 'user-1')).resolves.toStrictEqual({ pinCode: true });
      expect(mocks.user.hasPinCode).toHaveBeenCalledWith('user-1');
      expect(mocks.user.getForPinCode).not.toHaveBeenCalled();
    });

    it('says so when the account has no PIN', async () => {
      mocks.user.hasPinCode.mockResolvedValue(false);

      await expect(sut.getPinCodeState(authStub.admin, 'user-1')).resolves.toStrictEqual({ pinCode: false });
    });

    it('throws for an unknown account', async () => {
      mocks.user.hasPinCode.mockResolvedValue(undefined);

      await expect(sut.getPinCodeState(authStub.admin, 'user-1')).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
