import { generateKeyPair } from '@frameleaf/locked-crypto';
import { JobStatus } from 'src/enum.js';
import { SessionService } from 'src/services/session.service.js';
import { lockedKeys } from 'src/utils/locked-key-holder.js';
import { AuthFactory } from 'test/factories/auth.factory.js';
import { SessionFactory } from 'test/factories/session.factory.js';
import { authStub } from 'test/fixtures/auth.stub.js';
import { ServiceMocks, newTestService } from 'test/utils.js';

describe('SessionService', () => {
  let sut: SessionService;
  let mocks: ServiceMocks;

  beforeEach(() => {
    ({ sut, mocks } = newTestService(SessionService));
  });

  it('should be defined', () => {
    expect(sut).toBeDefined();
  });

  describe('onBootstrap', () => {
    it('on bootstrap, sessions of users with a key file are locked (FL-721, spec §4.3)', async () => {
      mocks.lockedKey.userIds.mockResolvedValue(['user-1']);
      mocks.lockedKey.list.mockResolvedValue([]);
      mocks.lockedEncryption.getAllUserIds.mockResolvedValue(['user-2']);
      mocks.session.lockAll.mockResolvedValue();

      await sut.onBootstrap();

      expect(mocks.session.lockAll).toHaveBeenCalledTimes(2);
      expect(mocks.session.lockAll).toHaveBeenCalledWith('user-1');
      expect(mocks.session.lockAll).toHaveBeenCalledWith('user-2');
      expect(mocks.websocket.clientSend).toHaveBeenCalledWith('on_session_lock', 'user-1');
      expect(mocks.websocket.clientSend).toHaveBeenCalledWith('on_session_lock', 'user-2');
    });

    it('locks nothing when nobody has a key file', async () => {
      mocks.lockedKey.userIds.mockResolvedValue([]);
      mocks.lockedKey.list.mockResolvedValue([]);
      mocks.lockedEncryption.getAllUserIds.mockResolvedValue([]);
      await sut.onBootstrap();
      expect(mocks.session.lockAll).not.toHaveBeenCalled();
    });
  });

  describe('onAuthChangePassword', () => {
    it('revokes the other sessions before the Locked key hook, which never throws (FL-721)', async () => {
      const auth = AuthFactory.from().session().build();
      const { publicKey, privateKey } = generateKeyPair();
      lockedKeys.load(auth.user.id, publicKey, privateKey, new Date(Date.now() + 60 * 60 * 1000));
      mocks.lockedKey.read.mockRejectedValue(new SyntaxError('bad json'));
      mocks.lockedKey.exists.mockResolvedValue(true);
      mocks.session.lockAll.mockResolvedValue();
      mocks.session.invalidateAll.mockResolvedValue(['other-session']);

      await expect(
        sut.onAuthChangePassword({
          userId: auth.user.id,
          currentSessionId: auth.session!.id,
          invalidateSessions: true,
        }),
      ).resolves.toBeUndefined();

      expect(mocks.session.invalidateAll).toHaveBeenCalledWith({ userId: auth.user.id, excludeId: auth.session!.id });
      expect(mocks.event.emit).toHaveBeenCalledWith('SessionDelete', { sessionId: 'other-session' });
      expect(lockedKeys.has(auth.user.id)).toBe(false);
      lockedKeys.clear();
    });
  });

  describe('create', () => {
    it('gives a child session exactly the sign-in record of the session that made it', async () => {
      const auth = AuthFactory.from().session({ id: 'parent-session' }).build();
      const record = {
        methods: ['passkey'],
        level: 'verified' as const,
        source: 'local' as const,
        legacy: false,
        authTime: new Date('2026-11-11T10:00:00Z'),
      };
      mocks.session.getSignIn.mockResolvedValue(record);
      mocks.session.create.mockResolvedValue(SessionFactory.create());

      await sut.create(auth, {});

      expect(mocks.session.getSignIn).toHaveBeenCalledWith(auth.session!.id);
      expect(mocks.session.create).toHaveBeenCalledWith(
        expect.objectContaining({ parentId: auth.session!.id }),
        undefined,
        record,
      );
      expect(mocks.frameleafAccount.tagSession).not.toHaveBeenCalled();
    });

    it('makes a child of a session with no record an older session too, which the policy and confirmation judge', async () => {
      const auth = AuthFactory.from().session({ id: 'parent-session' }).build();
      mocks.session.getSignIn.mockResolvedValue(undefined);
      mocks.session.create.mockResolvedValue(SessionFactory.create());

      await sut.create(auth, {});

      // no record: AuthService treats it as an older session (legacy until "Apply to older apps too")
      expect(mocks.session.create).toHaveBeenCalledWith(expect.anything(), undefined, undefined);
      expect(mocks.frameleafAccount.tagSession).not.toHaveBeenCalled();
    });

    it('gives a child of a Frameleaf session the same Frameleaf tag', async () => {
      const auth = AuthFactory.from().session({ id: 'parent-session' }).build();
      const authTime = new Date('2026-11-11T10:00:00Z');
      mocks.session.getSignIn.mockResolvedValue({
        methods: ['email_code'],
        level: 'basic',
        source: 'frameleaf',
        legacy: false,
        authTime,
      });
      mocks.session.create.mockResolvedValue({ ...SessionFactory.create(), id: 'child-session' });
      mocks.frameleafAccount.getSession.mockResolvedValue({
        sessionId: 'parent-session',
        userId: auth.user.id,
        sid: 'fl-sid',
        sub: 'fl-sub',
        authTime,
      } as never);

      await sut.create(auth, {});

      expect(mocks.frameleafAccount.tagSession).toHaveBeenCalledWith({
        sessionId: 'child-session',
        userId: auth.user.id,
        sid: 'fl-sid',
        sub: 'fl-sub',
        authTime,
      });
    });
  });

  describe('handleCleanup', () => {
    it('should clean sessions', async () => {
      mocks.session.cleanup.mockResolvedValue([]);
      await expect(sut.handleCleanup()).resolves.toEqual(JobStatus.Success);
    });
  });

  describe('getAll', () => {
    it('should get the devices', async () => {
      const currentSession = SessionFactory.create();
      const otherSession = SessionFactory.create();
      const auth = AuthFactory.from().session(currentSession).build();

      mocks.session.getByUserId.mockResolvedValue([currentSession, otherSession]);

      await expect(sut.getAll(auth)).resolves.toEqual([
        expect.objectContaining({ current: true, id: currentSession.id }),
        expect.objectContaining({ current: false, id: otherSession.id }),
      ]);

      expect(mocks.session.getByUserId).toHaveBeenCalledWith(auth.user.id);
    });
  });

  describe('logoutDevices', () => {
    it('should logout all devices', async () => {
      const currentSession = SessionFactory.create();
      const otherSession = SessionFactory.create();
      const auth = AuthFactory.from().session(currentSession).build();

      mocks.session.getByUserId.mockResolvedValue([currentSession, otherSession]);
      mocks.session.invalidateAll.mockResolvedValue([otherSession.id]);

      await sut.deleteAll(auth);

      // FL-808: one row per signed-out device, none for the current one
      expect(mocks.accountEvent.create).toHaveBeenCalledTimes(1);
      expect(mocks.accountEvent.create).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'session-revoked', subject: 'android · mobile', userId: auth.user.id }),
      );

      expect(mocks.session.invalidateAll).toHaveBeenCalledWith({
        userId: auth.user.id,
        excludeId: currentSession.id,
      });
      // FL-34: every revoked session's open tabs are told, the current one is not
      expect(mocks.event.emit).toHaveBeenCalledWith('SessionDelete', { sessionId: otherSession.id });
      expect(mocks.event.emit).not.toHaveBeenCalledWith('SessionDelete', { sessionId: currentSession.id });
    });
  });

  // FL-34 (ported from PR131 bb70ad841f): revocation reaches every open tab through `on_session_lock`
  it('revokes elevation in the retained session as well as other sessions on password change', async () => {
    mocks.session.lockAll.mockResolvedValue();
    mocks.session.invalidateAll.mockResolvedValue(['session-2']);

    await sut.onAuthChangePassword({ userId: 'user-1', currentSessionId: 'session-1', invalidateSessions: true });

    expect(mocks.session.lockAll).toHaveBeenCalledWith('user-1');
    expect(mocks.websocket.clientSend).toHaveBeenCalledWith('on_session_lock', 'user-1');
    expect(mocks.session.invalidateAll).toHaveBeenCalledWith({ userId: 'user-1', excludeId: 'session-1' });
    expect(mocks.event.emit).toHaveBeenCalledWith('SessionDelete', { sessionId: 'session-2' });
    expect(mocks.event.emit).not.toHaveBeenCalledWith('SessionDelete', { sessionId: 'session-1' });
  });

  describe('lock', () => {
    it('notifies only the locked session after the authorized write', async () => {
      mocks.access.session.checkOwnerAccess.mockResolvedValue(new Set(['session-1']));
      mocks.session.update.mockResolvedValue(SessionFactory.create());

      await sut.lock(authStub.user1, 'session-1');

      expect(mocks.session.update).toHaveBeenCalledWith('session-1', { pinExpiresAt: null });
      expect(mocks.websocket.clientSend).toHaveBeenCalledWith('on_session_lock', 'session-1');
    });

    it('does not notify or write for another owner', async () => {
      mocks.access.session.checkOwnerAccess.mockResolvedValue(new Set());

      await expect(sut.lock(authStub.user1, 'session-1')).rejects.toThrow();

      expect(mocks.session.update).not.toHaveBeenCalled();
      expect(mocks.websocket.clientSend).not.toHaveBeenCalled();
    });
  });

  describe('logoutDevice', () => {
    it('should logout the device', async () => {
      mocks.access.authDevice.checkOwnerAccess.mockResolvedValue(new Set(['token-1']));
      mocks.session.getByUserId.mockResolvedValue([
        SessionFactory.create({ id: 'token-1', deviceType: 'Safari', deviceOS: 'iOS' }),
      ]);
      mocks.session.delete.mockResolvedValue();

      await sut.delete(authStub.user1, 'token-1');

      // FL-808: exactly one row, naming the device
      expect(mocks.accountEvent.create).toHaveBeenCalledTimes(1);
      expect(mocks.accountEvent.create).toHaveBeenCalledWith({
        userId: authStub.user1.user.id,
        sessionId: authStub.user1.session?.id ?? null,
        action: 'session-revoked',
        subject: 'iOS · Safari',
      });

      expect(mocks.access.authDevice.checkOwnerAccess).toHaveBeenCalledWith(
        authStub.user1.user.id,
        new Set(['token-1']),
      );
      expect(mocks.session.delete).toHaveBeenCalledWith('token-1');
      expect(mocks.event.emit).toHaveBeenCalledWith('SessionDelete', { sessionId: 'token-1' });
    });

    it('still signs the device out when its name cannot be read for the activity log (FL-808)', async () => {
      mocks.access.authDevice.checkOwnerAccess.mockResolvedValue(new Set(['token-1']));
      mocks.session.getByUserId.mockRejectedValue(new Error('database busy'));
      mocks.session.delete.mockResolvedValue();

      await sut.delete(authStub.user1, 'token-1');

      expect(mocks.session.delete).toHaveBeenCalledWith('token-1');
      expect(mocks.event.emit).toHaveBeenCalledWith('SessionDelete', { sessionId: 'token-1' });
      expect(mocks.accountEvent.create).not.toHaveBeenCalled();
    });

    it('neither deletes nor announces a session of another owner', async () => {
      mocks.access.authDevice.checkOwnerAccess.mockResolvedValue(new Set());

      await expect(sut.delete(authStub.user1, 'token-1')).rejects.toThrow();

      expect(mocks.session.delete).not.toHaveBeenCalled();
      expect(mocks.event.emit).not.toHaveBeenCalledWith('SessionDelete', expect.anything());
      expect(mocks.accountEvent.create).not.toHaveBeenCalled();
    });
  });
});
