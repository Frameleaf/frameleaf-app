import { SystemMetadataKey } from 'src/enum.js';
import { StorageService } from 'src/services/storage.service.js';
import { ImmichStartupError } from 'src/utils/misc.js';
import { mockEnvData } from 'test/repositories/config.repository.mock.js';
import { newUuid } from 'test/small.factory.js';
import { ServiceMocks, newTestService } from 'test/utils.js';

describe(StorageService.name, () => {
  let sut: StorageService;
  let mocks: ServiceMocks;

  beforeEach(() => {
    ({ sut, mocks } = newTestService(StorageService));
  });

  it('should work', () => {
    expect(sut).toBeDefined();
  });

  describe('onBootstrap', () => {
    it('migrates a verified old marker before checking write access', async () => {
      mocks.config.getEnv.mockReturnValue(
        mockEnvData({ storage: { mediaLocation: '/data', importRoots: [], ignoreMountCheckErrors: false } }),
      );
      mocks.systemMetadata.get.mockResolvedValue({ mountChecks: { upload: true } });
      mocks.asset.getFileSamples.mockResolvedValue([]);
      mocks.storage.readFile.mockImplementation((filename) => {
        if (filename.endsWith('/upload/.frameleaf')) {
          return Promise.reject(Object.assign(new Error('missing'), { code: 'ENOENT' }));
        }
        return Promise.resolve(Buffer.from('existing marker'));
      });

      await expect(sut.onBootstrap()).resolves.toBeUndefined();

      expect(mocks.storage.readFile).toHaveBeenCalledWith('/data/upload/.immich');
      expect(mocks.storage.rename).toHaveBeenCalledWith('/data/upload/.immich', '/data/upload/.frameleaf');
      expect(mocks.storage.overwriteFile).toHaveBeenCalledWith('/data/upload/.frameleaf', expect.any(Buffer));
      expect(mocks.storage.createFile).not.toHaveBeenCalledWith('/data/upload/.frameleaf', expect.anything());
    });

    it('refuses to recreate a previously verified marker when neither name exists', async () => {
      mocks.systemMetadata.get.mockResolvedValue({ mountChecks: { upload: true } });
      mocks.storage.readFile.mockImplementation((filename) => {
        if (filename.includes('/upload/'))
          return Promise.reject(Object.assign(new Error('missing'), { code: 'ENOENT' }));
        return Promise.resolve(Buffer.from('marker'));
      });

      await expect(sut.onBootstrap()).rejects.toBeInstanceOf(ImmichStartupError);

      expect(mocks.storage.rename).not.toHaveBeenCalled();
      expect(mocks.storage.createFile).not.toHaveBeenCalledWith('/data/upload/.frameleaf', expect.anything());
      expect(mocks.systemMetadata.set).not.toHaveBeenCalled();
    });

    it('does not fall back to an old marker when the Frameleaf marker is unreadable', async () => {
      mocks.systemMetadata.get.mockResolvedValue({ mountChecks: { upload: true } });
      mocks.storage.readFile.mockRejectedValue(Object.assign(new Error('denied'), { code: 'EACCES' }));

      await expect(sut.onBootstrap()).rejects.toBeInstanceOf(ImmichStartupError);

      expect(mocks.storage.rename).not.toHaveBeenCalled();
      expect(mocks.storage.readFile).not.toHaveBeenCalledWith(expect.stringContaining('/.immich'));
    });

    it('should enable mount folder checking', async () => {
      mocks.systemMetadata.get.mockResolvedValue(null);
      mocks.asset.getFileSamples.mockResolvedValue([]);
      mocks.config.getEnv.mockReturnValue(
        mockEnvData({
          storage: {
            ignoreMountCheckErrors: false,
            importRoots: [],
            mediaLocation: '/data',
          },
        }),
      );

      await expect(sut.onBootstrap()).resolves.toBeUndefined();

      expect(mocks.systemMetadata.set).toHaveBeenCalledWith(SystemMetadataKey.SystemFlags, {
        mountChecks: {
          backups: true,
          'encoded-video': true,
          exports: true,
          library: true,
          profile: true,
          thumbs: true,
          upload: true,
        },
      });
      expect(mocks.storage.mkdirSync).toHaveBeenCalledWith(expect.stringContaining('/data/encoded-video'));
      expect(mocks.storage.mkdirSync).toHaveBeenCalledWith(expect.stringContaining('/data/library'));
      expect(mocks.storage.mkdirSync).toHaveBeenCalledWith(expect.stringContaining('/data/profile'));
      expect(mocks.storage.mkdirSync).toHaveBeenCalledWith(expect.stringContaining('/data/thumbs'));
      expect(mocks.storage.mkdirSync).toHaveBeenCalledWith(expect.stringContaining('/data/upload'));
      expect(mocks.storage.mkdirSync).toHaveBeenCalledWith(expect.stringContaining('/data/backups'));
      // exports (memory highlights, Studio bundles) live under the media location too
      expect(mocks.storage.mkdirSync).toHaveBeenCalledWith(expect.stringContaining('/data/exports'));
      expect(mocks.storage.createFile).toHaveBeenCalledWith(
        expect.stringContaining('/data/exports/.frameleaf'),
        expect.any(Buffer),
      );
      expect(mocks.storage.createFile).toHaveBeenCalledWith(
        expect.stringContaining('/data/encoded-video/.frameleaf'),
        expect.any(Buffer),
      );
      expect(mocks.storage.createFile).toHaveBeenCalledWith(
        expect.stringContaining('/data/library/.frameleaf'),
        expect.any(Buffer),
      );
      expect(mocks.storage.createFile).toHaveBeenCalledWith(
        expect.stringContaining('/data/profile/.frameleaf'),
        expect.any(Buffer),
      );
      expect(mocks.storage.createFile).toHaveBeenCalledWith(
        expect.stringContaining('/data/thumbs/.frameleaf'),
        expect.any(Buffer),
      );
      expect(mocks.storage.createFile).toHaveBeenCalledWith(
        expect.stringContaining('/data/upload/.frameleaf'),
        expect.any(Buffer),
      );
      expect(mocks.storage.createFile).toHaveBeenCalledWith(
        expect.stringContaining('/data/backups/.frameleaf'),
        expect.any(Buffer),
      );
    });

    it('should enable mount folder checking for a new folder type', async () => {
      mocks.systemMetadata.get.mockResolvedValue({
        mountChecks: {
          backups: false,
          'encoded-video': true,
          exports: true,
          library: false,
          profile: true,
          thumbs: true,
          upload: true,
        },
      });
      mocks.asset.getFileSamples.mockResolvedValue([]);
      mocks.config.getEnv.mockReturnValue(
        mockEnvData({
          storage: {
            ignoreMountCheckErrors: false,
            importRoots: [],
            mediaLocation: '/data',
          },
        }),
      );

      await expect(sut.onBootstrap()).resolves.toBeUndefined();

      expect(mocks.systemMetadata.set).toHaveBeenCalledWith(SystemMetadataKey.SystemFlags, {
        mountChecks: {
          backups: true,
          'encoded-video': true,
          exports: true,
          library: true,
          profile: true,
          thumbs: true,
          upload: true,
        },
      });
      expect(mocks.storage.mkdirSync).toHaveBeenCalledTimes(2);
      expect(mocks.storage.mkdirSync).toHaveBeenCalledWith(expect.stringContaining('/data/library'));
      expect(mocks.storage.mkdirSync).toHaveBeenCalledWith(expect.stringContaining('/data/backups'));
      expect(mocks.storage.createFile).toHaveBeenCalledTimes(2);
      expect(mocks.storage.createFile).toHaveBeenCalledWith(
        expect.stringContaining('/data/library/.frameleaf'),
        expect.any(Buffer),
      );
      expect(mocks.storage.createFile).toHaveBeenCalledWith(
        expect.stringContaining('/data/backups/.frameleaf'),
        expect.any(Buffer),
      );
    });

    it('should throw an error if .frameleaf is missing', async () => {
      mocks.systemMetadata.get.mockResolvedValue({ mountChecks: { upload: true } });
      mocks.storage.readFile.mockRejectedValue(new Error("ENOENT: no such file or directory, open '/app/.frameleaf'"));

      await expect(sut.onBootstrap()).rejects.toThrow('Failed to read');

      expect(mocks.storage.createOrOverwriteFile).not.toHaveBeenCalled();
      expect(mocks.systemMetadata.set).not.toHaveBeenCalled();
    });

    it('should throw an error if .frameleaf is present but read-only', async () => {
      mocks.systemMetadata.get.mockResolvedValue({ mountChecks: { upload: true } });
      mocks.storage.overwriteFile.mockRejectedValue(
        new Error("ENOENT: no such file or directory, open '/app/.frameleaf'"),
      );

      await expect(sut.onBootstrap()).rejects.toThrow('Failed to write');

      expect(mocks.systemMetadata.set).not.toHaveBeenCalled();
    });

    it('should skip mount file creation if file already exists', async () => {
      const error = new Error('Error creating file') as any;
      error.code = 'EEXIST';
      mocks.systemMetadata.get.mockResolvedValue({ mountChecks: {} });
      mocks.storage.createFile.mockRejectedValue(error);
      mocks.asset.getFileSamples.mockResolvedValue([]);

      await expect(sut.onBootstrap()).resolves.toBeUndefined();

      expect(mocks.logger.warn).toHaveBeenCalledWith('Found existing mount file, skipping creation');
    });

    it('should throw an error if mount file could not be created', async () => {
      mocks.systemMetadata.get.mockResolvedValue({ mountChecks: {} });
      mocks.storage.createFile.mockRejectedValue(new Error('Error creating file'));

      await expect(sut.onBootstrap()).rejects.toBeInstanceOf(ImmichStartupError);
      expect(mocks.systemMetadata.set).not.toHaveBeenCalled();
    });

    it('should startup if checks are disabled', async () => {
      mocks.systemMetadata.get.mockResolvedValue({ mountChecks: { upload: true } });
      mocks.config.getEnv.mockReturnValue(
        mockEnvData({
          storage: { ignoreMountCheckErrors: true, importRoots: [] },
        }),
      );
      mocks.asset.getFileSamples.mockResolvedValue([]);
      mocks.storage.overwriteFile.mockRejectedValue(
        new Error("ENOENT: no such file or directory, open '/app/.frameleaf'"),
      );

      await expect(sut.onBootstrap()).resolves.toBeUndefined();

      expect(mocks.systemMetadata.set).not.toHaveBeenCalledWith(SystemMetadataKey.SystemFlags, expect.anything());
    });
  });

  describe('handleDeleteFiles', () => {
    it('announces committed removal from its durable cleanup intent', async () => {
      mocks.asset.getById.mockResolvedValue(undefined);
      await sut.handleDeleteFiles({ files: [], removedAssetId: 'asset-id', removedAssetOwnerId: 'user-id' });
      expect(mocks.event.emit).toHaveBeenCalledWith('AssetDelete', { assetId: 'asset-id', userId: 'user-id' });
    });

    it('keeps deletion listeners fenced when the removal did not commit', async () => {
      mocks.asset.getById.mockResolvedValue({ id: 'asset-id' } as never);
      await sut.handleDeleteFiles({ files: [], removedAssetId: 'asset-id', removedAssetOwnerId: 'user-id' });
      expect(mocks.event.emit).not.toHaveBeenCalled();
    });

    it('does not swallow a failed durable deletion announcement', async () => {
      mocks.asset.getById.mockResolvedValue(undefined);
      mocks.event.emit.mockRejectedValue(new Error('Announcement unavailable'));
      await expect(
        sut.handleDeleteFiles({ files: [], removedAssetId: 'asset-id', removedAssetOwnerId: 'user-id' }),
      ).rejects.toThrow('Announcement unavailable');
    });

    // The repository owns the unlink so the reference count and the delete stay
    // inside one advisory-locked transaction; these mocks stand in for that
    // decision. Whether the count itself is correct is a repository concern.
    beforeEach(() => {
      mocks.physicalFile.deleteUnreferencedPath.mockImplementation((async (
        path: string,
        unlink: () => Promise<void>,
      ) => {
        await unlink();
        return { deleted: true, references: 0 };
      }) as never);
    });

    it('should handle null values', async () => {
      await sut.handleDeleteFiles({ files: [undefined, null] });

      expect(mocks.physicalFile.deleteUnreferencedPath).not.toHaveBeenCalled();
      expect(mocks.storage.unlink).not.toHaveBeenCalled();
    });

    it('should handle an error removing a file', async () => {
      mocks.storage.unlink.mockRejectedValue(new Error('something-went-wrong'));

      await sut.handleDeleteFiles({ files: ['path/to/something'] });

      expect(mocks.storage.unlink).toHaveBeenCalledWith('path/to/something');
    });

    it('sends an unreferenced original to the file trash instead of unlinking it (universal storage)', async () => {
      const checksum = Buffer.from('a'.repeat(64), 'hex');
      mocks.physicalFile.deleteUnreferencedPath.mockImplementation((async (
        path: string,
        _unlink: () => Promise<void>,
        options: { trash?: { move: (from: string, to: string) => Promise<void> } },
      ) => {
        await options.trash!.move(path, '/data/file-trash/id/photo.jpg');
        return { deleted: true, references: 0, trashed: true };
      }) as never);

      await sut.handleDeleteFiles({
        files: ['/data/library/user/photo.jpg', '/data/thumbs/user/thumb.webp'],
        removedAssetId: 'asset-id',
        original: {
          path: '/data/library/user/photo.jpg',
          ownerId: 'user-id',
          assetId: 'asset-id',
          originalFileName: 'photo.jpg',
          checksum: checksum.toString('hex'),
          sizeInBytes: 42,
        },
      });

      expect(mocks.physicalFile.deleteUnreferencedPath).toHaveBeenCalledWith(
        '/data/library/user/photo.jpg',
        expect.any(Function),
        {
          removedAssetId: 'asset-id',
          trash: {
            move: expect.any(Function),
            original: {
              checksum,
              sizeInBytes: 42,
              ownerId: 'user-id',
              assetId: 'asset-id',
              originalFileName: 'photo.jpg',
            },
          },
        },
      );
      // every path may be a registered original, so every one may go to the trash
      expect(mocks.physicalFile.deleteUnreferencedPath).toHaveBeenCalledWith(
        '/data/thumbs/user/thumb.webp',
        expect.any(Function),
        { removedAssetId: 'asset-id', trash: { move: expect.any(Function) } },
      );
      expect(mocks.storage.rename).toHaveBeenCalledWith(
        '/data/library/user/photo.jpg',
        '/data/file-trash/id/photo.jpg',
      );
      expect(mocks.storage.unlink).not.toHaveBeenCalled();
    });

    it('should remove the file', async () => {
      await sut.handleDeleteFiles({ files: ['path/to/something'] });

      expect(mocks.storage.unlink).toHaveBeenCalledWith('path/to/something');
    });

    it('should not remove a path that is still referenced', async () => {
      // A live asset.originalPath pointing at a shared file — how the dedup
      // migration destroyed master originals.
      mocks.physicalFile.deleteUnreferencedPath.mockResolvedValue({ deleted: false, references: 1 } as never);

      await sut.handleDeleteFiles({ files: ['path/to/shared-original'] });

      expect(mocks.storage.unlink).not.toHaveBeenCalled();
    });

    it('passes the removed asset on, so a job whose removal rolled back keeps every file (FL-169)', async () => {
      const removedAssetId = newUuid();

      await sut.handleDeleteFiles({ files: ['path/to/frame.jpeg'], removedAssetId });

      expect(mocks.physicalFile.deleteUnreferencedPath).toHaveBeenCalledWith(
        'path/to/frame.jpeg',
        expect.any(Function),
        expect.objectContaining({ removedAssetId }),
      );
    });
  });
});
