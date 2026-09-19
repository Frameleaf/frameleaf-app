import { JobStatus } from 'src/enum.js';
import { VersionService } from 'src/services/version.service.js';
import { factory } from 'test/small.factory.js';
import { ServiceMocks, newTestService } from 'test/utils.js';

vitest.mock('node:fs', () => ({ readFileSync: () => JSON.stringify({ version: 'v3.0.0' }) }));

describe(VersionService.name, () => {
  let sut: VersionService;
  let mocks: ServiceMocks;

  beforeEach(() => {
    ({ sut, mocks } = newTestService(VersionService));
    mocks.cron.create.mockResolvedValue();
    mocks.cron.update.mockResolvedValue();
  });

  it('should work', () => {
    expect(sut).toBeDefined();
  });

  describe('onBootstrap', () => {
    it('should record a new version', async () => {
      mocks.versionHistory.getAll.mockResolvedValue([]);
      mocks.versionHistory.getLatest.mockResolvedValue(void 0);
      mocks.versionHistory.create.mockResolvedValue(factory.versionHistory());

      await expect(sut.onBootstrap()).resolves.toBeUndefined();

      expect(mocks.versionHistory.create).toHaveBeenCalledWith({ version: expect.any(String) });
    });

    it('should skip a duplicate version', async () => {
      mocks.versionHistory.getLatest.mockResolvedValue({
        id: 'version-1',
        createdAt: new Date(),
        version: '3.0.0',
      });
      await expect(sut.onBootstrap()).resolves.toBeUndefined();
      expect(mocks.versionHistory.create).not.toHaveBeenCalled();
    });

    it('does not schedule or fetch external version checks', async () => {
      mocks.database.tryLock.mockResolvedValue(true);
      mocks.versionHistory.getLatest.mockResolvedValue({ ...factory.versionHistory(), version: '3.0.0' });
      await sut.onBootstrap();
      expect(mocks.cron.create).not.toHaveBeenCalled();
      expect(mocks.serverInfo.getLatestRelease).not.toHaveBeenCalled();
    });
  });

  describe('getVersion', () => {
    it('should respond the server version', () => {
      expect(sut.getVersion()).toEqual({
        major: 3,
        minor: 0,
        patch: 0,
        prerelease: null,
      });
    });
  });

  describe('getVersionHistory', () => {
    it('should respond the server version history', async () => {
      const upgrade = { id: 'upgrade-1', createdAt: new Date(), version: '1.0.0' };
      mocks.versionHistory.getAll.mockResolvedValue([upgrade]);
      await expect(sut.getVersionHistory()).resolves.toEqual([upgrade]);
    });
  });

  describe('handleVersionCheck', () => {
    it('skips existing jobs even with a legacy enabled setting', async () => {
      mocks.systemMetadata.get.mockResolvedValue({ newVersionCheck: { enabled: true } });
      await expect(sut.handleVersionCheck()).resolves.toEqual(JobStatus.Skipped);
      expect(mocks.serverInfo.getLatestRelease).not.toHaveBeenCalled();
      expect(mocks.systemMetadata.set).not.toHaveBeenCalled();
      expect(mocks.websocket.clientBroadcast).not.toHaveBeenCalled();
    });
  });

  describe('onWebsocketConnection', () => {
    it('should send on_server_version client event', () => {
      sut.onWebsocketConnection({ userId: '42' });
      expect(mocks.websocket.clientSend).toHaveBeenCalledWith('on_server_version', '42', {
        major: 3,
        minor: 0,
        patch: 0,
        prerelease: null,
      });
      expect(mocks.websocket.clientSend).toHaveBeenCalledTimes(1);
    });

    it('ignores cached external release notifications', () => {
      mocks.systemMetadata.get.mockResolvedValue({ checkedAt: '2024-01-01', releaseVersion: 'v1.42.0' });
      sut.onWebsocketConnection({ userId: '42' });
      expect(mocks.websocket.clientSend).toHaveBeenCalledWith('on_server_version', '42', {
        major: 3,
        minor: 0,
        patch: 0,
        prerelease: null,
      });
      expect(mocks.websocket.clientSend).not.toHaveBeenCalledWith('on_new_release', '42', expect.any(Object));
    });

    it('should not send a release notification when the version check is disabled', () => {
      mocks.systemMetadata.get.mockResolvedValueOnce({ newVersionCheck: { enabled: false } });
      sut.onWebsocketConnection({ userId: '42' });
      expect(mocks.websocket.clientSend).toHaveBeenCalledWith('on_server_version', '42', {
        major: 3,
        minor: 0,
        patch: 0,
        prerelease: null,
      });
      expect(mocks.websocket.clientSend).not.toHaveBeenCalledWith('on_new_release', '42', expect.any(Object));
    });
  });
});
