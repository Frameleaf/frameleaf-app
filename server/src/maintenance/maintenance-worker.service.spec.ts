import { ConflictException, UnauthorizedException } from '@nestjs/common';
import { SignJWT } from 'jose';
import { MaintenanceAction, SystemMetadataKey } from 'src/enum.js';
import { MaintenanceHealthRepository } from 'src/maintenance/maintenance-health.repository.js';
import { MaintenanceWebsocketRepository } from 'src/maintenance/maintenance-websocket.repository.js';
import { MaintenanceWorkerService } from 'src/maintenance/maintenance-worker.service.js';
import { DatabaseBackupService } from 'src/services/database-backup.service.js';
import { AutoMocked, ServiceMocks, automock, getMocks } from 'test/utils.js';

describe(MaintenanceWorkerService.name, () => {
  let sut: MaintenanceWorkerService;
  let mocks: ServiceMocks;
  let maintenanceWebsocketRepositoryMock: AutoMocked<MaintenanceWebsocketRepository>;
  let maintenanceHealthRepositoryMock: AutoMocked<MaintenanceHealthRepository>;
  let databaseBackupServiceMock: AutoMocked<DatabaseBackupService>;

  beforeEach(() => {
    mocks = getMocks();
    maintenanceWebsocketRepositoryMock = automock(MaintenanceWebsocketRepository, {
      args: [mocks.logger],
      strict: false,
    });
    maintenanceHealthRepositoryMock = automock(MaintenanceHealthRepository, {
      args: [mocks.logger],
      strict: false,
    });
    databaseBackupServiceMock = automock(DatabaseBackupService, {
      args: [
        mocks.logger,
        mocks.storage,
        mocks.config,
        mocks.systemMetadata,
        mocks.process,
        mocks.database,
        mocks.cron,
        mocks.job,
        maintenanceHealthRepositoryMock,
      ],
      strict: false,
    });

    sut = new MaintenanceWorkerService(
      mocks.logger as never,
      mocks.app,
      mocks.config,
      mocks.systemMetadata as never,
      maintenanceWebsocketRepositoryMock,
      maintenanceHealthRepositoryMock,
      mocks.storage as never,
      mocks.process,
      mocks.database as never,
      databaseBackupServiceMock,
    );

    sut.mock({
      active: true,
      action: MaintenanceAction.Start,
    });
  });

  it('should work', () => {
    expect(sut).toBeDefined();
  });

  describe('getSystemConfig', () => {
    it('should respond the server is in maintenance mode', () => {
      expect(sut.getSystemConfig()).toMatchObject(
        expect.objectContaining({
          maintenanceMode: true,
        }),
      );

      expect(mocks.systemMetadata.get).toHaveBeenCalledTimes(0);
    });
  });

  describe('ssr', () => {
    it('sends a page request to maintenance and keeps its query for the way back', () => {
      const redirect = vi.fn();
      const url = '/user-settings?area=maintenance&section=backups';
      sut.ssr([])(
        { url, originalUrl: url, path: '/user-settings', method: 'GET' } as never,
        { redirect } as never,
        vi.fn(),
      );

      expect(redirect).toHaveBeenCalledWith(
        `/maintenance?${new URLSearchParams({ continue: '/user-settings?area=maintenance&section=backups' })}`,
      );
    });

    it('keeps only the path of an auth page, never its callback code', () => {
      const redirect = vi.fn();
      const url = '/auth/login?code=secret&state=abc';
      sut.ssr([])(
        { url, originalUrl: url, path: '/auth/login', method: 'GET' } as never,
        { redirect } as never,
        vi.fn(),
      );

      expect(redirect).toHaveBeenCalledWith(`/maintenance?${new URLSearchParams({ continue: '/auth/login' })}`);
    });

    it('keeps a hostile address inside the encoded continue value', () => {
      const redirect = vi.fn();
      const url = '//evil.example/x?a=%0d%0a';
      sut.ssr([])(
        { url, originalUrl: url, path: '//evil.example/x', method: 'GET' } as never,
        { redirect } as never,
        vi.fn(),
      );

      const [location] = redirect.mock.calls[0];
      expect(location).toMatch(/^\/maintenance\?continue=/);
      expect(new URLSearchParams(location.split('?', 2)[1]).get('continue')).toBe(url);
    });

    it('serves the maintenance page itself, and passes API and non-GET requests on', () => {
      const send = vi.fn();
      const res = { redirect: vi.fn(), status: () => res, type: () => res, header: () => res, send };
      const next = vi.fn();
      const handler = sut.ssr([]);

      handler(
        {
          url: '/maintenance?token=x',
          originalUrl: '/maintenance?token=x',
          path: '/maintenance',
          method: 'GET',
        } as never,
        res as never,
        next,
      );
      handler(
        {
          url: '/api/server/config',
          originalUrl: '/api/server/config',
          path: '/api/server/config',
          method: 'GET',
        } as never,
        res as never,
        next,
      );
      handler({ url: '/photos', originalUrl: '/photos', path: '/photos', method: 'POST' } as never, res as never, next);

      expect(send).toHaveBeenCalledTimes(1);
      expect(next).toHaveBeenCalledTimes(2);
      expect(res.redirect).not.toHaveBeenCalled();
    });
  });
  describe.skip('detectMediaLocation');

  describe('setStatus', () => {
    it('should broadcast status', () => {
      sut.setStatus({
        active: true,
        action: MaintenanceAction.Start,
        task: 'abc',
        error: 'def',
      });

      expect(maintenanceWebsocketRepositoryMock.serverSend).toHaveBeenCalled();
      expect(maintenanceWebsocketRepositoryMock.clientSend).toHaveBeenCalledTimes(2);
      expect(maintenanceWebsocketRepositoryMock.clientSend).toHaveBeenCalledWith('MaintenanceStatusV1', 'private', {
        active: true,
        action: 'start',
        task: 'abc',
        error: 'def',
      });
      expect(maintenanceWebsocketRepositoryMock.clientSend).toHaveBeenCalledWith('MaintenanceStatusV1', 'public', {
        active: true,
        action: 'start',
        task: 'abc',
        error: 'Something went wrong, see logs!',
      });
    });
  });

  describe('reason (FL-81)', () => {
    it('reports the reason from setAction on the public and private status', async () => {
      await sut.setAction({ action: MaintenanceAction.Start, reason: 'Upgrading storage' });

      await expect(sut.status()).resolves.toEqual(expect.objectContaining({ reason: 'Upgrading storage' }));
      expect(maintenanceWebsocketRepositoryMock.clientSend).toHaveBeenCalledWith(
        'MaintenanceStatusV1',
        'public',
        expect.objectContaining({ reason: 'Upgrading storage' }),
      );
    });

    it('keeps the reason when a later action does not send one', async () => {
      await sut.setAction({ action: MaintenanceAction.Start, reason: 'Upgrading storage' });
      sut.setStatus({ active: true, action: MaintenanceAction.Start, task: 'abc' });

      await expect(sut.status()).resolves.toEqual(
        expect.objectContaining({ task: 'abc', reason: 'Upgrading storage' }),
      );
    });

    it('clears the reason with null and stores the change', async () => {
      await sut.setAction({ action: MaintenanceAction.Start, reason: 'Upgrading storage' });
      expect(mocks.systemMetadata.set).toHaveBeenLastCalledWith(SystemMetadataKey.MaintenanceMode, {
        isMaintenanceMode: true,
        secret: 'secret',
        action: { action: MaintenanceAction.Start, reason: 'Upgrading storage' },
      });

      await sut.setAction({ action: MaintenanceAction.Start, reason: null });

      await expect(sut.status()).resolves.not.toHaveProperty('reason');
      expect(mocks.systemMetadata.set).toHaveBeenLastCalledWith(SystemMetadataKey.MaintenanceMode, {
        isMaintenanceMode: true,
        secret: 'secret',
        action: { action: MaintenanceAction.Start, reason: undefined },
      });
    });

    it('restores the stored reason on init', async () => {
      mocks.systemMetadata.get.mockResolvedValue({
        isMaintenanceMode: true,
        secret: 'secret',
        action: { action: MaintenanceAction.Start, reason: 'Moving house' },
      });
      await sut.init();

      await expect(sut.status()).resolves.toEqual(expect.objectContaining({ reason: 'Moving house' }));
    });
  });

  describe('logSecret', () => {
    const RE_LOGIN_URL = /(?:^|\s)\/maintenance\?token=([A-Za-z0-9-_]*\.[A-Za-z0-9-_]*\.[A-Za-z0-9-_]*)/;

    it('should log a valid login URL', async () => {
      mocks.systemMetadata.get.mockResolvedValue({
        isMaintenanceMode: true,
        secret: 'secret',
        action: {
          action: MaintenanceAction.Start,
        },
      });

      await expect(sut.logSecret()).resolves.toBeUndefined();
      expect(mocks.logger.log).toHaveBeenCalledWith(expect.stringMatching(RE_LOGIN_URL));

      const [url] = mocks.logger.log.mock.lastCall!;
      // FL-190: without a public address the log gives a path on this server, never another host.
      expect(url).toContain('Log in by opening this path on your server');
      expect(url).not.toMatch(/https?:\/\//);
      const token = RE_LOGIN_URL.exec(url)![1];

      await expect(sut.login(token)).resolves.toEqual(
        expect.objectContaining({
          username: 'immich-admin',
        }),
      );
    });
  });

  describe('authenticate', () => {
    it('should fail without a cookie', async () => {
      await expect(sut.authenticate({})).rejects.toThrowError(new UnauthorizedException('Missing JWT Token'));
    });

    it('should parse cookie properly', async () => {
      mocks.systemMetadata.get.mockResolvedValue({
        isMaintenanceMode: true,
        secret: 'secret',
        action: {
          action: MaintenanceAction.Start,
        },
      });

      await expect(
        sut.authenticate({
          cookie: 'immich_maintenance_token=invalid-jwt',
        }),
      ).rejects.toThrowError(new UnauthorizedException('Invalid JWT Token'));
    });
  });

  describe('status', () => {
    beforeEach(() => {
      sut.mock({
        active: true,
        action: MaintenanceAction.Start,
        error: 'secret value!',
      });
    });

    it('generates private status', async () => {
      const jwt = await new SignJWT({ _mockValue: true })
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuedAt()
        .setExpirationTime('4h')
        .sign(new TextEncoder().encode('secret'));

      await expect(sut.status(jwt)).resolves.toEqual(
        expect.objectContaining({
          error: 'secret value!',
        }),
      );
    });

    it('generates public status', async () => {
      await expect(sut.status()).resolves.toEqual(
        expect.objectContaining({
          error: 'Something went wrong, see logs!',
        }),
      );
    });
  });

  describe('detectPriorInstall', () => {
    it('generate report about prior installation', async () => {
      mocks.storage.readdir.mockResolvedValue(['.immich', 'file1', 'file2']);
      mocks.storage.readFile.mockResolvedValue(undefined as never);
      mocks.storage.overwriteFile.mockRejectedValue(undefined as never);

      await expect(sut.detectPriorInstall()).resolves.toMatchInlineSnapshot(`
        {
          "storage": [
            {
              "files": 2,
              "folder": "encoded-video",
              "readable": true,
              "writable": false,
            },
            {
              "files": 2,
              "folder": "library",
              "readable": true,
              "writable": false,
            },
            {
              "files": 2,
              "folder": "upload",
              "readable": true,
              "writable": false,
            },
            {
              "files": 2,
              "folder": "profile",
              "readable": true,
              "writable": false,
            },
            {
              "files": 2,
              "folder": "thumbs",
              "readable": true,
              "writable": false,
            },
            {
              "files": 2,
              "folder": "backups",
              "readable": true,
              "writable": false,
            },
            {
              "files": 2,
              "folder": "exports",
              "readable": true,
              "writable": false,
            },
          ],
        }
      `);
    });
  });

  describe('login', () => {
    it('should fail without token', async () => {
      await expect(sut.login()).rejects.toThrowError(new UnauthorizedException('Missing JWT Token'));
    });

    it('should fail with expired JWT', async () => {
      mocks.systemMetadata.get.mockResolvedValue({
        isMaintenanceMode: true,
        secret: 'secret',
        action: {
          action: MaintenanceAction.Start,
        },
      });

      const jwt = await new SignJWT({})
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuedAt()
        .setExpirationTime('0s')
        .sign(new TextEncoder().encode('secret'));

      await expect(sut.login(jwt)).rejects.toThrowError(new UnauthorizedException('Invalid JWT Token'));
    });

    it('should succeed with valid JWT', async () => {
      mocks.systemMetadata.get.mockResolvedValue({
        isMaintenanceMode: true,
        secret: 'secret',
        action: {
          action: MaintenanceAction.Start,
        },
      });

      const jwt = await new SignJWT({ _mockValue: true })
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuedAt()
        .setExpirationTime('4h')
        .sign(new TextEncoder().encode('secret'));

      await expect(sut.login(jwt)).resolves.toEqual(
        expect.objectContaining({
          _mockValue: true,
        }),
      );
    });
  });

  describe.skip('setAction'); // just calls setStatus+runAction

  describe('claimAction (FL-81)', () => {
    it('refuses every other action while a restore is running', async () => {
      let finishRestore: () => void = () => {};
      databaseBackupServiceMock.restoreDatabaseBackup.mockReturnValue(
        new Promise<void>((resolve) => (finishRestore = resolve)),
      );
      mocks.database.tryLock.mockResolvedValueOnce(true);

      const restore = { action: MaintenanceAction.RestoreDatabase, restoreBackupFilename: 'development-filename.sql' };
      sut.claimAction(restore);
      const running = sut.setAction(restore);

      for (const action of [
        restore,
        { action: MaintenanceAction.End },
        { action: MaintenanceAction.Start },
        { action: MaintenanceAction.SelectDatabaseRestore },
      ]) {
        expect(() => sut.claimAction(action)).toThrowError(ConflictException);
      }

      finishRestore();
      await running;
    });

    it('allows End and another restore after a restore failed', async () => {
      databaseBackupServiceMock.restoreDatabaseBackup.mockRejectedValue(new Error('Migration failed'));
      mocks.database.tryLock.mockResolvedValueOnce(true);

      const restore = { action: MaintenanceAction.RestoreDatabase, restoreBackupFilename: 'development-filename.sql' };
      sut.claimAction(restore);
      await sut.setAction(restore);

      expect(() => sut.claimAction({ action: MaintenanceAction.End })).not.toThrow();
      expect(() => sut.claimAction(restore)).not.toThrow();
    });

    it('does not restore when another process holds the maintenance lock, and keeps refusing meanwhile', async () => {
      mocks.database.tryLock.mockResolvedValueOnce(false);

      const restore = { action: MaintenanceAction.RestoreDatabase, restoreBackupFilename: 'development-filename.sql' };
      sut.claimAction(restore);
      await sut.setAction(restore);

      expect(databaseBackupServiceMock.restoreDatabaseBackup).not.toHaveBeenCalled();
      // the other process's restore is still running until its status says otherwise
      expect(() => sut.claimAction({ action: MaintenanceAction.End })).toThrowError(ConflictException);
    });

    it('refuses actions while a restore resumed on start is running', async () => {
      let finishRestore: () => void = () => {};
      databaseBackupServiceMock.restoreDatabaseBackup.mockReturnValue(
        new Promise<void>((resolve) => (finishRestore = resolve)),
      );
      mocks.database.tryLock.mockResolvedValueOnce(true);

      const running = sut.runAction({
        action: MaintenanceAction.RestoreDatabase,
        restoreBackupFilename: 'development-filename.sql',
      });
      expect(() => sut.claimAction({ action: MaintenanceAction.End })).toThrowError(ConflictException);

      finishRestore();
      await running;
    });

    it('refuses actions while another server reports a restore without an error', () => {
      sut.mock({ active: true, action: MaintenanceAction.RestoreDatabase, task: 'restore', progress: 0.4 });
      expect(() => sut.claimAction({ action: MaintenanceAction.End })).toThrowError(ConflictException);

      sut.mock({ active: true, action: MaintenanceAction.RestoreDatabase, task: 'error', error: 'failed' });
      expect(() => sut.claimAction({ action: MaintenanceAction.End })).not.toThrow();
    });

    it('lets actions through when no restore is running', () => {
      expect(() => sut.claimAction({ action: MaintenanceAction.Start })).not.toThrow();
      expect(() => sut.claimAction({ action: MaintenanceAction.End })).not.toThrow();
    });
  });

  /**
   * Actions
   */

  describe('action: start', () => {
    it('should not do anything', async () => {
      await sut.runAction({
        action: MaintenanceAction.Start,
      });

      expect(mocks.logger.log).toHaveBeenCalledTimes(0);
    });
  });

  describe('action: end', () => {
    it('should set maintenance mode', async () => {
      mocks.systemMetadata.get.mockResolvedValue({ isMaintenanceMode: false });
      await sut.runAction({
        action: MaintenanceAction.End,
      });

      expect(mocks.systemMetadata.set).toHaveBeenCalledWith(SystemMetadataKey.MaintenanceMode, {
        isMaintenanceMode: false,
      });

      expect(maintenanceWebsocketRepositoryMock.clientBroadcast).toHaveBeenCalledWith('AppRestartV1', {
        isMaintenanceMode: false,
      });

      expect(maintenanceWebsocketRepositoryMock.serverSend).toHaveBeenCalledWith('AppRestart', {
        isMaintenanceMode: false,
      });
    });
  });

  describe('action: restore database', () => {
    beforeEach(() => {
      mocks.database.tryLock.mockResolvedValueOnce(true);
    });

    it('should update maintenance mode state', async () => {
      await sut.runAction({
        action: MaintenanceAction.RestoreDatabase,
        restoreBackupFilename: 'filename',
      });

      expect(mocks.database.tryLock).toHaveBeenCalled();
      expect(mocks.logger.log).toHaveBeenCalledWith('Running maintenance action restore_database');

      expect(mocks.systemMetadata.set).toHaveBeenCalledWith(SystemMetadataKey.MaintenanceMode, {
        isMaintenanceMode: true,
        secret: 'secret',
        action: {
          action: 'start',
        },
      });
    });

    it('should defer to database backup service', async () => {
      await sut.runAction({
        action: MaintenanceAction.RestoreDatabase,
        restoreBackupFilename: 'development-filename.sql',
      });

      expect(maintenanceWebsocketRepositoryMock.clientSend).toHaveBeenCalledWith(
        'MaintenanceStatusV1',
        expect.any(String),
        {
          active: true,
          action: MaintenanceAction.RestoreDatabase,
          task: 'ready',
          progress: expect.any(Number),
        },
      );

      expect(maintenanceWebsocketRepositoryMock.clientSend).toHaveBeenLastCalledWith(
        'MaintenanceStatusV1',
        expect.any(String),
        {
          active: true,
          action: 'end',
        },
      );
    });

    it('keeps the safety backup unless the request says not to', async () => {
      await sut.runAction({
        action: MaintenanceAction.RestoreDatabase,
        restoreBackupFilename: 'development-filename.sql',
      });
      expect(databaseBackupServiceMock.restoreDatabaseBackup).toHaveBeenLastCalledWith(
        'development-filename.sql',
        expect.any(Function),
        { keepSafetyBackup: true },
      );

      mocks.database.tryLock.mockResolvedValueOnce(true);
      await sut.runAction({
        action: MaintenanceAction.RestoreDatabase,
        restoreBackupFilename: 'development-filename.sql',
        keepSafetyBackup: false,
      });
      expect(databaseBackupServiceMock.restoreDatabaseBackup).toHaveBeenLastCalledWith(
        'development-filename.sql',
        expect.any(Function),
        { keepSafetyBackup: false },
      );
    });

    it('should forward errors from database backup service', async () => {
      databaseBackupServiceMock.restoreDatabaseBackup.mockRejectedValue('Sample error');

      await sut.runAction({
        action: MaintenanceAction.RestoreDatabase,
        restoreBackupFilename: 'development-filename.sql',
      });

      expect(maintenanceWebsocketRepositoryMock.clientSend).toHaveBeenCalledWith('MaintenanceStatusV1', 'private', {
        active: true,
        action: MaintenanceAction.RestoreDatabase,
        error: 'Sample error',
        task: 'error',
      });

      expect(maintenanceWebsocketRepositoryMock.clientSend).toHaveBeenCalledWith('MaintenanceStatusV1', 'public', {
        active: true,
        action: MaintenanceAction.RestoreDatabase,
        error: 'Something went wrong, see logs!',
        task: 'error',
      });
    });
  });
});
