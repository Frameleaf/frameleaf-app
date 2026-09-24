import { JobStatus } from 'src/enum.js';
import { SessionService } from 'src/services/session.service.js';
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

      mocks.session.invalidateAll.mockResolvedValue([otherSession.id]);

      await sut.deleteAll(auth);

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
      mocks.session.delete.mockResolvedValue();

      await sut.delete(authStub.user1, 'token-1');

      expect(mocks.access.authDevice.checkOwnerAccess).toHaveBeenCalledWith(
        authStub.user1.user.id,
        new Set(['token-1']),
      );
      expect(mocks.session.delete).toHaveBeenCalledWith('token-1');
      expect(mocks.event.emit).toHaveBeenCalledWith('SessionDelete', { sessionId: 'token-1' });
    });

    it('neither deletes nor announces a session of another owner', async () => {
      mocks.access.authDevice.checkOwnerAccess.mockResolvedValue(new Set());

      await expect(sut.delete(authStub.user1, 'token-1')).rejects.toThrow();

      expect(mocks.session.delete).not.toHaveBeenCalled();
      expect(mocks.event.emit).not.toHaveBeenCalledWith('SessionDelete', expect.anything());
    });
  });
});
