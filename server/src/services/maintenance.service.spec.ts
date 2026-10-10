import { MaintenanceAction, SystemMetadataKey } from 'src/enum.js';
import { MaintenanceService } from 'src/services/maintenance.service.js';
import { ServiceMocks, newTestService } from 'test/utils.js';

describe(MaintenanceService.name, () => {
  let sut: MaintenanceService;
  let mocks: ServiceMocks;

  beforeEach(() => {
    ({ sut, mocks } = newTestService(MaintenanceService));
  });

  it('should work', () => {
    expect(sut).toBeDefined();
  });

  it('does not exit until the restart acknowledgement is committed', async () => {
    let committed!: () => void;
    mocks.websocket.acknowledgeRestart.mockImplementation(() => new Promise<void>((resolve) => (committed = resolve)));
    const ack = vi.fn();
    const restart = sut.onRestart({ isMaintenanceMode: true }, ack);
    expect(mocks.websocket.acknowledgeRestart).toHaveBeenCalledWith(ack);
    expect(mocks.app.exitApp).not.toHaveBeenCalled();
    committed();
    await restart;
    expect(mocks.app.exitApp).toHaveBeenCalledOnce();
  });

  it('reports an acknowledgement publication failure without exiting', async () => {
    const error = new Error('ack failed');
    mocks.websocket.acknowledgeRestart.mockRejectedValueOnce(error);
    await expect(sut.onRestart({ isMaintenanceMode: false }, vi.fn())).rejects.toBe(error);
    expect(mocks.app.exitApp).not.toHaveBeenCalled();
  });

  describe('getMaintenanceMode', () => {
    it('should return false if state unknown', async () => {
      mocks.systemMetadata.get.mockResolvedValue(null);

      await expect(sut.getMaintenanceMode()).resolves.toEqual({
        isMaintenanceMode: false,
      });

      expect(mocks.systemMetadata.get).toHaveBeenCalled();
    });

    it('should return false if disabled', async () => {
      mocks.systemMetadata.get.mockResolvedValue({ isMaintenanceMode: false });

      await expect(sut.getMaintenanceMode()).resolves.toEqual({
        isMaintenanceMode: false,
      });

      expect(mocks.systemMetadata.get).toHaveBeenCalled();
    });

    it('should return true if enabled', async () => {
      mocks.systemMetadata.get.mockResolvedValue({
        isMaintenanceMode: true,
        secret: '',
        action: { action: MaintenanceAction.Start },
      });

      await expect(sut.getMaintenanceMode()).resolves.toEqual({
        isMaintenanceMode: true,
        secret: '',
        action: {
          action: 'start',
        },
      });

      expect(mocks.systemMetadata.get).toHaveBeenCalled();
    });
  });

  describe('integrityCheck', () => {
    it('generate integrity report', async () => {
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

  describe('startMaintenance', () => {
    it('should set maintenance mode and return a secret', async () => {
      mocks.systemMetadata.get.mockResolvedValue({ isMaintenanceMode: false });

      await expect(
        sut.startMaintenance(
          {
            action: MaintenanceAction.Start,
          },
          'admin',
        ),
      ).resolves.toMatchObject({
        jwt: expect.any(String),
      });

      expect(mocks.systemMetadata.set).toHaveBeenCalledWith(SystemMetadataKey.MaintenanceMode, {
        isMaintenanceMode: true,
        secret: expect.stringMatching(/^\w{128}$/),
        action: {
          action: 'start',
        },
      });

      expect(mocks.event.emit).toHaveBeenCalledWith('AppRestart', {
        isMaintenanceMode: true,
      });
    });
  });

  describe('startRestoreFlow', () => {
    it('refuses restore without setup proof before starting maintenance', async () => {
      mocks.database.withLock.mockImplementation((_lock, callback) => callback() as never);
      mocks.user.getAdmin.mockResolvedValue(undefined);
      mocks.systemMetadata.get.mockResolvedValue({ code: 'ABCD2345', locked: false } as never);
      await expect(sut.startRestoreFlow({ code: '' }, { ip: '192.168.1.2', via: null })).rejects.toMatchObject({
        response: { code: 'setup_code_required' },
      });
      expect(mocks.systemMetadata.set).not.toHaveBeenCalled();
      expect(mocks.app.exitApp).not.toHaveBeenCalled();
    });

    it('should start maintenance mode and return a jwt', async () => {
      mocks.systemMetadata.get.mockResolvedValue({ isMaintenanceMode: false });

      mocks.database.withLock.mockImplementation((_lock, callback) => callback() as never);
      mocks.user.getAdmin.mockResolvedValue(undefined);
      mocks.systemMetadata.get.mockResolvedValue({ code: 'ABCD2345', locked: false } as never);
      await expect(sut.startRestoreFlow({ code: 'ABCD2345' }, { ip: '192.168.1.2', via: null })).resolves.toMatchObject(
        { jwt: expect.any(String) },
      );

      expect(mocks.systemMetadata.set).toHaveBeenCalledWith(SystemMetadataKey.MaintenanceMode, {
        isMaintenanceMode: true,
        secret: expect.stringMatching(/^\w{128}$/),
        action: {
          action: MaintenanceAction.SelectDatabaseRestore,
        },
      });
    });
  });

  describe('createLoginUrl', () => {
    it('should fail outside of maintenance mode without secret', async () => {
      mocks.systemMetadata.get.mockResolvedValue({ isMaintenanceMode: false });

      await expect(
        sut.createLoginUrl({
          username: '',
        }),
      ).rejects.toThrowError('Not in maintenance mode');
    });

    it('should generate a login path with JWT when the server has no public address (FL-190)', async () => {
      mocks.systemMetadata.get.mockResolvedValue({
        isMaintenanceMode: true,
        secret: 'secret',
        action: {
          action: MaintenanceAction.Start,
        },
      });

      await expect(
        sut.createLoginUrl({
          username: '',
        }),
      ).resolves.toEqual(
        expect.stringMatching(/^\/maintenance\?token=[A-Za-z0-9-_]*\.[A-Za-z0-9-_]*\.[A-Za-z0-9-_]*$/),
      );

      expect(mocks.systemMetadata.get).toHaveBeenCalledTimes(2);
    });

    it('should generate a login url on the external domain', async () => {
      mocks.systemMetadata.get.mockResolvedValue({
        server: { externalDomain: 'https://photos.example.com' },
        isMaintenanceMode: true,
        secret: 'secret',
        action: { action: MaintenanceAction.Start },
      });

      await expect(sut.createLoginUrl({ username: '' })).resolves.toEqual(
        expect.stringMatching(/^https:\/\/photos\.example\.com\/maintenance\?token=[\w-]+\.[\w-]+\.[\w-]+$/),
      );
    });

    it('should use the given secret', async () => {
      await expect(
        sut.createLoginUrl(
          {
            username: '',
          },
          'secret',
        ),
      ).resolves.toEqual(expect.stringMatching(/./));

      expect(mocks.systemMetadata.get).toHaveBeenCalledTimes(1);
    });
  });
});
