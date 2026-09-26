import { Kysely } from 'kysely';
import { DateTime } from 'luxon';
import { ImmichEnvironment, JobName, JobStatus, UserAvatarColor, UserMetadataKey } from 'src/enum.js';
import { ClusterGroupRepository } from 'src/repositories/cluster-group.repository.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { CryptoRepository } from 'src/repositories/crypto.repository.js';
import { DatabaseRepository } from 'src/repositories/database.repository.js';
import { EventRepository } from 'src/repositories/event.repository.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { SessionRepository } from 'src/repositories/session.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { UserRepository } from 'src/repositories/user.repository.js';
import { DB } from 'src/schema/index.js';
import { UserService } from 'src/services/user.service.js';
import { HumanReadableSize } from 'src/utils/bytes.js';
import { mediumFactory, newMediumService } from 'test/medium.factory.js';
import { factory, newUuid } from 'test/small.factory.js';
import { getKyselyDB } from 'test/utils.js';

let defaultDatabase: Kysely<DB>;

const setup = (db?: Kysely<DB>) => {
  process.env.IMMICH_ENV = ImmichEnvironment.Testing;

  return newMediumService(UserService, {
    database: db || defaultDatabase,
    real: [
      ClusterGroupRepository,
      CryptoRepository,
      ConfigRepository,
      // FL-67: preference saves run under DatabaseRepository.withUserPreferencesLock
      DatabaseRepository,
      SystemMetadataRepository,
      UserRepository,
      SessionRepository,
    ],
    mock: [LoggingRepository, JobRepository, EventRepository],
  });
};

beforeAll(async () => {
  defaultDatabase = await getKyselyDB();
  const { ctx } = setup();
  await ctx.newUser({ isAdmin: true, email: 'admin@example.com' });
});

describe(UserService.name, () => {
  describe('create', () => {
    it('should create a user', async () => {
      const { sut, ctx } = setup();
      ctx.getMock(EventRepository).emit.mockResolvedValue();
      const user = mediumFactory.userInsert({ clusterGroupId: newUuid() });
      const created = await sut.createUser({ name: user.name, email: user.email });
      expect(created).toEqual(expect.objectContaining({ name: user.name, email: user.email }));

      await expect(sut.get(created.id)).resolves.toMatchObject({ name: user.name, email: user.email });
    });

    it('should reject user with duplicate email', async () => {
      const { sut, ctx } = setup();
      ctx.getMock(EventRepository).emit.mockResolvedValue();
      const user = mediumFactory.userInsert({ clusterGroupId: newUuid() });
      await expect(sut.createUser({ name: 'Test', email: user.email })).resolves.toMatchObject({ email: user.email });
      await expect(sut.createUser({ name: 'Test', email: user.email })).rejects.toThrow('Email is not available');
    });

    it('should not return password', async () => {
      const { sut, ctx } = setup();
      ctx.getMock(EventRepository).emit.mockResolvedValue();
      const dto = mediumFactory.userInsert({ clusterGroupId: newUuid(), password: 'password' });
      const user = await sut.createUser({ name: 'Test', email: dto.email, password: 'password' });
      expect((user as any).password).toBeUndefined();
    });
  });

  describe('search', () => {
    it('should get users', async () => {
      const { sut, ctx } = setup();
      const { user: user1 } = await ctx.newUser();
      const { user: user2 } = await ctx.newUser();
      const auth = factory.auth({ user: user1 });

      await expect(sut.search(auth)).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ email: user1.email }),
          expect.objectContaining({ email: user2.email }),
        ]),
      );
    });
  });

  describe('get', () => {
    it('should get a user', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();

      await expect(sut.get(user.id)).resolves.toEqual(
        expect.objectContaining({
          id: user.id,
          name: user.name,
          email: user.email,
        }),
      );
    });

    it('should not return password', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const result = await sut.get(user.id);

      expect((result as any).password).toBeUndefined();
    });

    it('should not expose private fields', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();

      await expect(sut.get(user.id)).resolves.not.toMatchObject({
        shouldChangePassword: expect.anything(),
        storageLabel: expect.anything(),
      });
    });
  });

  describe('getMe', () => {
    it('should get my user', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });

      await expect(sut.getMe(auth)).resolves.toEqual(
        expect.objectContaining({ id: user.id, email: user.email, quotaUsageInBytes: 0 }),
      );
    });

    it('should include the supporter key summary, and ignore a previous product key (FL-156)', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user: { id: user.id } });
      const userRepo = ctx.get(UserRepository);

      await userRepo.upsertMetadata(user.id, {
        key: UserMetadataKey.License,
        value: { licenseKey: 'IMCL-FF69', activationKey: 'x', activatedAt: '2026-09-01T00:00:00.000Z' } as never,
      });
      await expect(sut.getMe(auth)).resolves.toMatchObject({ license: null });

      await userRepo.upsertMetadata(user.id, {
        key: UserMetadataKey.License,
        value: { kind: 'individual', keyHint: 'CMSF', activatedAt: '2026-09-25T00:00:00.000Z' },
      });
      await expect(sut.getMe(auth)).resolves.toMatchObject({
        license: { kind: 'individual', keyHint: 'CMSF', activatedAt: new Date('2026-09-25T00:00:00.000Z') },
      });
    });
  });

  describe('updateMe', () => {
    it('should update a user', async () => {
      const { sut, ctx } = setup();
      const { user, result: before } = await ctx.newUser();
      const auth = factory.auth({ user: { id: user.id } });
      const after = await sut.updateMe(auth, { name: `${before.name} Updated` });

      expect(before.updatedAt).toBeDefined();
      expect(after.updatedAt).toBeDefined();
      expect(before.updatedAt).not.toEqual(after.updatedAt);

      await expect(sut.getMe(auth)).resolves.toMatchObject({
        name: `${before.name} Updated`,
        updatedAt: after.updatedAt,
      });
    });

    it('should update the name', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user: { id: user.id } });

      const dto = { name: 'Name' };

      await expect(sut.updateMe(auth, dto)).resolves.toMatchObject(dto);
      await expect(sut.getMe(auth)).resolves.toMatchObject(dto);
    });

    it('should update the email', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user: { id: user.id } });

      const dto = { email: 'updated@example.com' };

      await expect(sut.updateMe(auth, dto)).resolves.toMatchObject(dto);
      await expect(sut.getMe(auth)).resolves.toMatchObject(dto);
    });

    it('should not allow an email that is already taken', async () => {
      const { sut, ctx } = setup();
      const { user: user1 } = await ctx.newUser();
      const { user: user2 } = await ctx.newUser();
      const auth = factory.auth({ user: { id: user2.id } });

      await expect(sut.updateMe(auth, { email: user1.email })).rejects.toThrow('Email is not available');
    });

    it('should update the avatar color', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user: { id: user.id } });

      const dto = { avatarColor: UserAvatarColor.Blue };

      await expect(sut.updateMe(auth, dto)).resolves.toMatchObject(dto);
      await expect(sut.getMe(auth)).resolves.toMatchObject(dto);
    });

    it('should clear shouldChangePassword when the password is updated', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser({ shouldChangePassword: true });
      const auth = factory.auth({ user: { id: user.id } });

      await expect(sut.updateMe(auth, { password: 'super-secret' })).resolves.toMatchObject({
        shouldChangePassword: false,
      });
      await expect(sut.getMe(auth)).resolves.toMatchObject({ shouldChangePassword: false });
    });
  });

  describe('updateMyPreferences', () => {
    it('stores saved searches and keeps any naming a Locked person from a locked session (FL-49)', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const unlocked = factory.auth({ user: { id: user.id }, session: { hasElevatedPermission: true } });
      const locked = factory.auth({ user: { id: user.id } });
      const lockedPerson = newUuid();
      const savedSearches = [
        { name: 'Beach', query: { filter: { city: { eq: 'Lisbon' } } } },
        { name: 'Private', query: { filter: { personIds: { any: [lockedPerson] } } } },
      ];

      await expect(sut.getMyPreferences(locked)).resolves.toMatchObject({ savedSearches: [] });
      await sut.updateMyPreferences(unlocked, {
        savedSearches,
        privacy: { suppression: { personIds: [lockedPerson] } },
      });

      await expect(sut.getMyPreferences(unlocked)).resolves.toMatchObject({ savedSearches });
      const lockedView = await sut.getMyPreferences(locked);
      expect(lockedView.savedSearches).toEqual([savedSearches[0]]);

      // a locked session may replace the list, but the searches it cannot see are kept
      const added = { name: 'Snow', query: { filter: { city: { eq: 'Banff' } } } };
      await sut.updateMyPreferences(locked, { savedSearches: [added], expectedRevision: lockedView.revision });
      await expect(sut.getMyPreferences(unlocked)).resolves.toMatchObject({
        savedSearches: [added, savedSearches[1]],
      });
      await expect(sut.getMyPreferences(locked)).resolves.toMatchObject({ savedSearches: [added] });

      // an unlocked session replaces the whole list
      await sut.updateMyPreferences(unlocked, { savedSearches: [] });
      await expect(sut.getMyPreferences(unlocked)).resolves.toMatchObject({ savedSearches: [] });
    });

    it('should update memories enabled', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user: { id: user.id } });

      const dto = { memories: { enabled: false } };

      await expect(sut.getMyPreferences(auth)).resolves.toMatchObject({ memories: { enabled: true } });
      await expect(sut.updateMyPreferences(auth, dto)).resolves.toMatchObject(dto);
      await expect(sut.getMyPreferences(auth)).resolves.toMatchObject(dto);
    });

    it('should update the download archive size', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user: { id: user.id } });

      const dto = { download: { archiveSize: 1_234_567 } };

      await expect(sut.getMyPreferences(auth)).resolves.toMatchObject({
        download: { archiveSize: 4 * HumanReadableSize.GiB },
      });
      await expect(sut.updateMyPreferences(auth, dto)).resolves.toMatchObject(dto);
      await expect(sut.getMyPreferences(auth)).resolves.toMatchObject(dto);
    });

    it('should update download include embedded videos', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user: { id: user.id } });

      const dto = { download: { includeEmbeddedVideos: true } };

      await expect(sut.getMyPreferences(auth)).resolves.toMatchObject({
        download: { includeEmbeddedVideos: false },
      });
      await expect(sut.updateMyPreferences(auth, dto)).resolves.toMatchObject(dto);
      await expect(sut.getMyPreferences(auth)).resolves.toMatchObject(dto);
    });

    it('should update the minimum face count', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user: { id: user.id } });

      const dto = { people: { minimumFaces: 2 } };

      await expect(sut.getMyPreferences(auth)).resolves.toMatchObject({ people: { minimumFaces: 3 } });
      await expect(sut.updateMyPreferences(auth, dto)).resolves.toMatchObject(dto);
      await expect(sut.getMyPreferences(auth)).resolves.toMatchObject(dto);
    });

    it('should change Locked rules only from an unlocked session and hide them from other sessions (FL-67)', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const locked = factory.auth({ user: { id: user.id } });
      const unlocked = { ...locked, session: { id: newUuid(), hasElevatedPermission: true } } as typeof locked;
      const tagId = newUuid();

      await expect(sut.updateMyPreferences(locked, { privacy: { suppression: { tagIds: [tagId] } } })).rejects.toThrow(
        'Unlock with your PIN before changing Locked rules',
      );

      await expect(
        sut.updateMyPreferences(unlocked, { privacy: { suppression: { tagIds: [tagId], scope: 'visible' } } }),
      ).resolves.toMatchObject({ privacy: { suppression: { tagIds: [tagId], scope: 'visible' } } });

      await expect(sut.getMyPreferences(locked)).resolves.toMatchObject({
        privacy: { suppression: { tagIds: [], personIds: [], petIds: [], scope: 'visible' } },
      });
      await expect(sut.getMyPreferences(unlocked)).resolves.toMatchObject({
        privacy: { suppression: { tagIds: [tagId] } },
      });
    });

    it('should let only one of two saves made against the same revision through (FL-67)', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user: { id: user.id } });
      const unlocked = { ...auth, session: { id: newUuid(), hasElevatedPermission: true } } as typeof auth;
      const { revision } = await sut.getMyPreferences(unlocked);

      const results = await Promise.allSettled([
        sut.updateMyPreferences(unlocked, {
          expectedRevision: revision,
          privacy: { suppression: { tagIds: [newUuid()] } },
        }),
        sut.updateMyPreferences(unlocked, {
          expectedRevision: revision,
          privacy: { suppression: { scope: 'visible' } },
        }),
      ]);

      expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
      expect(results.filter(({ status }) => status === 'rejected')).toHaveLength(1);
    });
  });

  describe.sequential('handleUserDeleteCheck', () => {
    beforeEach(async () => {
      const { sut } = setup();
      // These tests specifically have to be sequential otherwise we hit race conditions with config changes applying in incorrect tests
      const config = await sut.getConfig({ withCache: false });
      config.user.deleteDelay = 7;
      await sut.updateConfig(config);
    });

    it('should work when there are no deleted users', async () => {
      const { sut, ctx } = setup();
      const jobMock = ctx.getMock(JobRepository);
      jobMock.queueAll.mockResolvedValue(void 0);
      await expect(sut.handleUserDeleteCheck()).resolves.toEqual(JobStatus.Success);
      expect(jobMock.queueAll).toHaveBeenCalledExactlyOnceWith([]);
    });

    it('should work when there is a user to delete', async () => {
      const { sut, ctx } = setup(await getKyselyDB());
      const jobMock = ctx.getMock(JobRepository);
      const { user } = await ctx.newUser({ deletedAt: DateTime.now().minus({ days: 60 }).toJSDate() });
      jobMock.queueAll.mockResolvedValue(void 0);
      await expect(sut.handleUserDeleteCheck()).resolves.toEqual(JobStatus.Success);
      expect(jobMock.queueAll).toHaveBeenCalledExactlyOnceWith([{ name: JobName.UserDelete, data: { id: user.id } }]);
    });

    it('should skip a recently deleted user', async () => {
      const { sut, ctx } = setup(await getKyselyDB());
      const jobMock = ctx.getMock(JobRepository);
      await ctx.newUser({ deletedAt: DateTime.now().minus({ days: 5 }).toJSDate() });
      jobMock.queueAll.mockResolvedValue(void 0);
      await expect(sut.handleUserDeleteCheck()).resolves.toEqual(JobStatus.Success);
      expect(jobMock.queueAll).toHaveBeenCalledExactlyOnceWith([]);
    });

    it('should respect a custom user delete delay', async () => {
      const { sut, ctx } = setup(await getKyselyDB());
      const jobMock = ctx.getMock(JobRepository);
      await ctx.newUser({ deletedAt: DateTime.now().minus({ days: 25 }).toJSDate() });
      jobMock.queueAll.mockResolvedValue(void 0);
      const config = await sut.getConfig({ withCache: false });
      config.user.deleteDelay = 30;
      await sut.updateConfig(config);
      await expect(sut.handleUserDeleteCheck()).resolves.toEqual(JobStatus.Success);
      expect(jobMock.queueAll).toHaveBeenCalledExactlyOnceWith([]);
    });
  });
});
