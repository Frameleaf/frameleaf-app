import { BadRequestException } from '@nestjs/common';
import { hash } from 'bcrypt';
import { Kysely } from 'kysely';
import { AuthType } from 'src/enum.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { ClusterGroupRepository } from 'src/repositories/cluster-group.repository.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { CryptoRepository } from 'src/repositories/crypto.repository.js';
import { DatabaseRepository } from 'src/repositories/database.repository.js';
import { EventRepository } from 'src/repositories/event.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { SessionRepository } from 'src/repositories/session.repository.js';
import { StorageRepository } from 'src/repositories/storage.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { UserRepository } from 'src/repositories/user.repository.js';
import { DB } from 'src/schema/index.js';
import { AuthService } from 'src/services/auth.service.js';
import { mediumFactory, newMediumService } from 'test/medium.factory.js';
import { factory } from 'test/small.factory.js';
import { getKyselyDB } from 'test/utils.js';

let defaultDatabase: Kysely<DB>;

const setup = (db?: Kysely<DB>) => {
  return newMediumService(AuthService, {
    database: db || defaultDatabase,
    real: [
      AccessRepository,
      ClusterGroupRepository,
      ConfigRepository,
      CryptoRepository,
      DatabaseRepository,
      SessionRepository,
      SystemMetadataRepository,
      UserRepository,
    ],
    mock: [LoggingRepository, StorageRepository, EventRepository],
  });
};

beforeAll(async () => {
  defaultDatabase = await getKyselyDB();
});

describe(AuthService.name, () => {
  // FL-34 (ported from PR131 bebfed12ff): a stale authentication read never reverses a lock
  describe('PIN refresh revocation race', () => {
    it('elevates only while the PIN and password are the ones the unlock checked', async () => {
      const { ctx } = setup();
      const repository = ctx.get(SessionRepository);
      const { user } = await ctx.newUser({ pinCode: 'old-pin-hash', password: 'password-hash' });
      const { session } = await ctx.newSession({ userId: user.id });
      const deadline = new Date(Date.now() + 3_600_000);
      const checked = { pinCode: 'old-pin-hash', password: 'password-hash' };

      await expect(repository.elevate(session.id, user.id, checked, deadline)).resolves.toBe(true);
      await repository.update(session.id, { pinExpiresAt: null });
      // a PIN change (with its lockAll) lands between the check and the write
      await ctx.get(UserRepository).update(user.id, { pinCode: 'new-pin-hash' });
      await expect(repository.elevate(session.id, user.id, checked, deadline)).resolves.toBe(false);
      expect(await repository.get(session.id)).toEqual(expect.objectContaining({ pinExpiresAt: null }));
      // another account's session is never elevated
      const { user: other } = await ctx.newUser({ pinCode: 'old-pin-hash', password: 'password-hash' });
      await expect(repository.elevate(session.id, other.id, checked, deadline)).resolves.toBe(false);
    });

    it('refreshes an active elevation but cannot resurrect an expired or deleted session', async () => {
      const { ctx } = setup();
      const repository = ctx.get(SessionRepository);
      const { user } = await ctx.newUser();
      const { session } = await ctx.newSession({ userId: user.id, pinExpiresAt: new Date(Date.now() + 60_000) });
      const deadline = new Date(Date.now() + 3_600_000);
      await expect(repository.refreshPinExpiry(session.id, deadline)).resolves.toBe(true);
      expect(await repository.get(session.id)).toEqual(expect.objectContaining({ pinExpiresAt: deadline }));
      const expired = new Date(Date.now() - 1000);
      await repository.update(session.id, { pinExpiresAt: expired });
      await expect(repository.refreshPinExpiry(session.id, deadline)).resolves.toBe(false);
      expect(await repository.get(session.id)).toEqual(expect.objectContaining({ pinExpiresAt: expired }));
      await repository.delete(session.id);
      await expect(repository.refreshPinExpiry(session.id, deadline)).resolves.toBe(false);
    });

    it.each(['lock', 'lockAll'] as const)(
      'does not renew elevation after %s supersedes a session read',
      async (lock) => {
        const { sut, ctx } = setup();
        const repository = ctx.get(SessionRepository);
        const { user } = await ctx.newUser();
        const token = 'pin-refresh-race-token';
        const { session } = await ctx.newSession({
          userId: user.id,
          token: ctx.get(CryptoRepository).hashSha256(token),
          pinExpiresAt: new Date(Date.now() + 60_000),
          updatedAt: new Date(),
        });
        const read = repository.getByToken.bind(repository);
        const snapshotRead = Promise.withResolvers<void>();
        const releaseRead = Promise.withResolvers<void>();
        const spy = vi.spyOn(repository, 'getByToken').mockImplementationOnce(async (token) => {
          const snapshot = await read(token);
          snapshotRead.resolve();
          await releaseRead.promise;
          return snapshot;
        });
        const pending = sut.authenticate({
          headers: { cookie: `immich_access_token=${token}` },
          queryParams: {},
          metadata: { adminRoute: false, sharedLinkRoute: false, uri: 'test' },
        });
        try {
          await snapshotRead.promise;
          if (lock === 'lock') {
            await repository.update(session.id, { pinExpiresAt: null });
          } else {
            await repository.lockAll(user.id);
          }
          releaseRead.resolve();
          const auth = await pending;
          expect(auth.session?.hasElevatedPermission).toBe(false);
          const stored = await repository.get(session.id);
          expect(stored?.pinExpiresAt).toBeNull();
        } finally {
          releaseRead.resolve();
          await pending.catch(() => {});
          spy.mockRestore();
        }
      },
    );

    it.each(['delete', 'expire'] as const)('rejects a session %sd after its stale PIN snapshot', async (change) => {
      const { sut, ctx } = setup();
      const repository = ctx.get(SessionRepository);
      const { user } = await ctx.newUser();
      const token = `pin-refresh-${change}`;
      const { session } = await ctx.newSession({
        userId: user.id,
        token: ctx.get(CryptoRepository).hashSha256(token),
        pinExpiresAt: new Date(Date.now() + 60_000),
        updatedAt: new Date(),
      });
      const read = repository.getByToken.bind(repository);
      const snapshotRead = Promise.withResolvers<void>();
      const releaseRead = Promise.withResolvers<void>();
      const spy = vi.spyOn(repository, 'getByToken').mockImplementationOnce(async (hashed) => {
        const snapshot = await read(hashed);
        snapshotRead.resolve();
        await releaseRead.promise;
        return snapshot;
      });
      const pending = sut.authenticate({
        headers: { cookie: `immich_access_token=${token}` },
        queryParams: {},
        metadata: { adminRoute: false, sharedLinkRoute: false, uri: 'test' },
      });
      try {
        await snapshotRead.promise;
        await (change === 'delete'
          ? repository.delete(session.id)
          : repository.update(session.id, { expiresAt: new Date(Date.now() - 1000) }));
        releaseRead.resolve();
        await expect(pending).rejects.toThrow('Invalid user token');
      } finally {
        releaseRead.resolve();
        await pending.catch(() => {});
        spy.mockRestore();
      }
    });
  });

  // FL-34: every revocation tells the revoked sessions' tabs, so the bulk delete names what it removed
  describe('session deletion notices', () => {
    it('returns exactly the sessions a bulk revocation deleted', async () => {
      const { ctx } = setup();
      const repository = ctx.get(SessionRepository);
      const { user } = await ctx.newUser();
      const { user: other } = await ctx.newUser();
      const { session: current } = await ctx.newSession({ userId: user.id });
      const { session: first } = await ctx.newSession({ userId: user.id });
      const { session: second } = await ctx.newSession({ userId: user.id });
      const { session: foreign } = await ctx.newSession({ userId: other.id });

      const deleted = await repository.invalidateAll({ userId: user.id, excludeId: current.id });
      expect(deleted.toSorted()).toEqual([first.id, second.id].toSorted());
      await expect(repository.invalidateAll({ userId: user.id, excludeId: current.id })).resolves.toEqual([]);
      await expect(repository.invalidateAll({ userId: user.id })).resolves.toEqual([current.id]);
      expect(await repository.get(foreign.id)).toBeDefined();
    });
  });

  describe('adminSignUp', () => {
    it(`should sign up the admin`, async () => {
      const { sut, ctx } = setup();
      ctx.getMock(EventRepository).emit.mockResolvedValue();
      const dto = { name: 'Admin', email: 'admin@example.com', password: 'password' };

      await expect(sut.adminSignUp(dto)).resolves.toEqual(
        expect.objectContaining({
          id: expect.any(String),
          email: dto.email,
          name: dto.name,
          isAdmin: true,
        }),
      );
    });
  });

  describe('login', () => {
    it('should reject an incorrect password', async () => {
      const { sut, ctx } = setup();
      const password = 'password';
      const passwordHashed = await hash(password, 10);
      const { user } = await ctx.newUser({ password: passwordHashed });
      const dto = { email: user.email, password: 'wrong-password' };

      await expect(sut.login(dto, mediumFactory.loginDetails())).rejects.toThrow('Incorrect email or password');
    });

    it('should accept a correct password and return a login response', async () => {
      const { sut, ctx } = setup();
      const password = 'password';
      const passwordHashed = await hash(password, 10);
      const { user } = await ctx.newUser({ password: passwordHashed });
      const dto = { email: user.email, password };

      await expect(sut.login(dto, mediumFactory.loginDetails())).resolves.toEqual({
        accessToken: expect.any(String),
        isAdmin: user.isAdmin,
        isOnboarded: false,
        name: user.name,
        profileImagePath: user.profileImagePath,
        userId: user.id,
        userEmail: user.email,
        shouldChangePassword: user.shouldChangePassword,
      });
    });
  });

  describe('logout', () => {
    it('should logout', async () => {
      const { sut } = setup();
      const auth = factory.auth();
      await expect(sut.logout(auth, AuthType.Password)).resolves.toEqual({
        successful: true,
        redirectUri: '/auth/login?autoLaunch=0',
      });
    });

    it('should cleanup the session', async () => {
      const { sut, ctx } = setup();
      const sessionRepo = ctx.get(SessionRepository);
      const eventRepo = ctx.getMock(EventRepository);
      const { user } = await ctx.newUser();
      const { session } = await ctx.newSession({ userId: user.id });
      const auth = factory.auth({ session, user });
      eventRepo.emit.mockResolvedValue();

      await expect(sessionRepo.get(session.id)).resolves.toEqual(expect.objectContaining({ id: session.id }));
      await expect(sut.logout(auth, AuthType.Password)).resolves.toEqual({
        successful: true,
        redirectUri: '/auth/login?autoLaunch=0',
      });
      await expect(sessionRepo.get(session.id)).resolves.toBeUndefined();
    });
  });

  describe('changePassword', () => {
    it('should change the password and login with it', async () => {
      const { sut, ctx } = setup();
      ctx.getMock(EventRepository).emit.mockResolvedValue();
      const dto = { password: 'password', newPassword: 'new-password' };
      const passwordHashed = await hash(dto.password, 10);
      const { user } = await ctx.newUser({ password: passwordHashed });
      const auth = factory.auth({ user });

      const response = await sut.changePassword(auth, dto);
      expect(response).toEqual(
        expect.objectContaining({
          id: user.id,
          email: user.email,
        }),
      );
      expect((response as any).password).not.toBeDefined();

      await expect(
        sut.login({ email: user.email, password: dto.newPassword }, mediumFactory.loginDetails()),
      ).resolves.toBeDefined();
    });

    it('should validate the current password', async () => {
      const { sut, ctx } = setup();
      const dto = { password: 'wrong-password', newPassword: 'new-password' };
      const passwordHashed = await hash('password', 10);
      const { user } = await ctx.newUser({ password: passwordHashed });
      const auth = factory.auth({ user });

      const response = sut.changePassword(auth, dto);
      await expect(response).rejects.toThrow(BadRequestException);
      await expect(response).rejects.toThrow('Wrong password');
    });
  });
});
