import { createHash } from 'node:crypto';
import { lstat } from 'node:fs/promises';

vi.mock('node:fs/promises', async (original) => ({
  ...(await original<typeof import('node:fs/promises')>()),
  lstat: vi.fn(),
}));
import { CloudBackupStoreError, CloudBackupStoreRepository } from 'src/repositories/cloud-backup-store.repository.js';
import { CloudBackupBucket } from 'src/services/cloud-backup-maintenance.js';
import {
  CloudBackupRestoreScope,
  CloudBackupRestorer,
  emptyRestoreResult,
  restorePlan,
  restoredDumpName,
} from 'src/services/cloud-backup-restore.js';
import { CloudBackupManifest } from 'src/utils/cloud-backup.js';

const hex = (text: string) => createHash('sha256').update(text).digest('hex');
const MEDIA = '/data';

const bucket: CloudBackupBucket = {
  bucketRef: 'https://s3.test/family-backup',
  connection: {
    endpoint: 'https://s3.test',
    region: 'us-east-1',
    bucket: 'family-backup',
    accessKeyId: 'a',
    secretAccessKey: 'b',
  },
  bucketKey: Buffer.alloc(32, 7),
};

const manifest: CloudBackupManifest = {
  format: 'frameleaf-backup-manifest',
  version: 1,
  instanceId: 'instance-1',
  createdAt: '2026-09-26T03:00:00.000Z',
  database: {
    key: 'db/cloud-backup-immich-db-backup-20260926T030000-v3.2.0-pg16.4.sql.gz',
    sha256: hex('dump'),
    size: 50,
  },
  assets: {
    'asset-1': {
      owner: 'owner-1',
      files: [
        { role: 'original', path: '/data/library/owner-1/2026/IMG_1.jpg', sha256: hex('one'), size: 100, mtime: null },
        { role: 'sidecar', path: '/data/library/owner-1/2026/IMG_1.jpg.xmp', sha256: hex('xmp'), size: 5, mtime: null },
      ],
    },
    'asset-2': {
      owner: 'owner-2',
      files: [{ role: 'original', path: '/elsewhere/IMG_2.jpg', sha256: hex('two'), size: 200, mtime: null }],
    },
  },
  profiles: {
    'owner-1': { role: 'profile', path: '/data/profile/owner-1/p.jpg', sha256: hex('p'), size: 7, mtime: null },
  },
  albums: {},
  people: {},
};

const plan = (scope: CloudBackupRestoreScope, assetIds: string[] | null = null, current = new Map<string, string>()) =>
  restorePlan({ manifest, scope, assetIds, operationId: 'op-1', mediaLocation: MEDIA, currentOriginals: current });

describe('cloud backup restore (FL-164)', () => {
  describe(restorePlan.name, () => {
    it('restores files into the restore folder for Library Care, never in place', () => {
      const { files, destination } = plan('files', ['asset-1']);

      expect(destination).toBe('/data/frameleaf/restore/op-1');
      expect(files.map(({ target, inPlace }) => ({ target, inPlace }))).toEqual([
        { target: '/data/frameleaf/restore/op-1/asset-1/original-IMG_1.jpg', inPlace: false },
        { target: '/data/frameleaf/restore/op-1/asset-1/sidecar-IMG_1.jpg.xmp', inPlace: false },
      ]);
    });

    it('restores one asset in place, to where the library expects its original now', () => {
      const { files } = plan('asset', ['asset-1'], new Map([['asset-1', '/data/library/owner-1/moved/IMG_1.jpg']]));

      expect(files.map(({ target, inPlace }) => ({ target, inPlace }))).toEqual([
        { target: '/data/library/owner-1/moved/IMG_1.jpg', inPlace: true },
        { target: '/data/library/owner-1/2026/IMG_1.jpg.xmp', inPlace: true },
      ]);
    });

    it('never writes outside the media folder: such a file goes to the restore folder instead', () => {
      const { files } = plan('library');

      expect(files.find(({ assetId }) => assetId === 'asset-2')).toMatchObject({
        target: '/data/frameleaf/restore/op-1/asset-2/original-IMG_2.jpg',
        inPlace: false,
      });
      // every file of the library, and the profile images
      expect(files).toHaveLength(4);
    });

    it('keeps untrusted file roles inside the asset restore directory', () => {
      const tampered = structuredClone(manifest);
      tampered.assets['asset-1'].files[0].role = '../../../../escape';
      const { files } = restorePlan({
        manifest: tampered,
        scope: 'files',
        assetIds: ['asset-1'],
        operationId: 'op-1',
        mediaLocation: MEDIA,
        currentOriginals: new Map(),
      });
      expect(files[0].target).toBe('/data/frameleaf/restore/op-1/asset-1/escape-IMG_1.jpg');
    });

    it('restores no files for a database restore', () => {
      expect(plan('database').files).toEqual([]);
    });

    it('names the restored dump so the maintenance restore lists it', () => {
      expect(restoredDumpName(manifest.database!.key)).toBe(
        'cloud-restore-immich-db-backup-20260926T030000-v3.2.0-pg16.4.sql.gz',
      );
      expect(restoredDumpName('db/../../etc/passwd.sql.gz')).toBe('cloud-restore-passwd.sql.gz');
    });
  });

  describe(CloudBackupRestorer.name, () => {
    let store: { download: ReturnType<typeof vi.fn<CloudBackupStoreRepository['download']>> };
    let storage: Record<string, ReturnType<typeof vi.fn>>;
    let crypto: { hashFile: ReturnType<typeof vi.fn<(path: string) => Promise<Buffer>>> };
    let sut: CloudBackupRestorer;
    let present: Map<string, string>;

    const restore = (scope: CloudBackupRestoreScope, assetIds: string[] | null = null) => {
      const { files, destination } = plan(scope, assetIds);
      return sut.restore({
        bucket,
        manifest,
        scope,
        files,
        destination,
        mediaLocation: MEDIA,
        backupsFolder: '/data/backups',
        operationId: 'op-1',
        start: emptyRestoreResult(),
        checkpoint: () => Promise.resolve(true),
      });
    };

    beforeEach(() => {
      present = new Map();
      vi.mocked(lstat).mockImplementation((path) => {
        const value = present.get(String(path));
        if (!value) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
        return Promise.resolve({
          dev: 1n,
          ino: BigInt(`0x${value.slice(0, 12)}`),
          size: BigInt(
            Object.values(manifest.assets)
              .flatMap((asset) => asset.files)
              .find((file) => file.sha256 === value)?.size ?? 1,
          ),
          mtimeNs: 1n,
          ctimeNs: 1n,
          nlink: 1n,
          isFile: () => true,
          isSymbolicLink: () => false,
        } as never);
      });
      store = {
        download: vi.fn().mockImplementation((_connection, _key, _bucketKey, target: string, sha256: string | null) => {
          present.set(target, sha256!);
          const size =
            [
              ...Object.values(manifest.assets).flatMap((asset) => asset.files),
              ...Object.values(manifest.profiles),
              manifest.database!,
            ].find((file) => file.sha256 === sha256)?.size ?? 1;
          return Promise.resolve({ size, sha256 });
        }),
      };
      storage = {
        checkFileExists: vi.fn().mockImplementation((path: string) => Promise.resolve(present.has(path))),
        mkdirSync: vi.fn(),
        rename: vi.fn().mockImplementation((from: string, to: string) => {
          present.set(to, present.get(from)!);
          present.delete(from);
          return Promise.resolve();
        }),
        copyFile: vi.fn(),
        unlink: vi.fn(),
      };
      crypto = {
        hashFile: vi.fn().mockImplementation((path: string) => Promise.resolve(Buffer.from(present.get(path)!, 'hex'))),
      };
      const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
      sut = new CloudBackupRestorer(store as never, storage as never, crypto as never, logger as never);
    });

    it('keeps an occupied owner destination untouched when authorization is revoked during download', async () => {
      const { files, destination } = plan('asset', ['asset-1']);
      const original = files[0];
      present.set(original.target, hex('occupied'));
      store.download.mockImplementationOnce((_connection, _key, _bucketKey, target: string, sha256: string | null) => {
        present.set(target, sha256!);
        return Promise.resolve({ size: original.size, sha256: sha256! });
      });
      const publish = vi.fn().mockRejectedValue(new Error('Owner restore authorization changed'));
      await expect(
        sut.restore({
          bucket,
          manifest,
          scope: 'asset',
          files: [original],
          destination,
          mediaLocation: MEDIA,
          backupsFolder: '/data/backups',
          operationId: 'op-1',
          start: emptyRestoreResult(),
          checkpoint: () => Promise.resolve(true),
          publish,
        } as Parameters<CloudBackupRestorer['restore']>[0]),
      ).rejects.toThrow('Owner restore authorization changed');
      expect(present.get(original.target)).toBe(hex('occupied'));
      expect(storage.rename).not.toHaveBeenCalled();
      expect(publish).toHaveBeenCalledOnce();
      expect(crypto.hashFile).not.toHaveBeenCalled();
      expect(storage.unlink).toHaveBeenCalled();
    });

    it.each(['corrupt', 'wrong-size'])(
      'refuses %s staged bytes after a valid download response without moving an original aside',
      async (change) => {
        const { files, destination } = plan('asset', ['asset-1']);
        const original = files[0];
        present.set(original.target, hex('occupied'));
        store.download.mockImplementationOnce((_connection, _key, _bucketKey, target, sha256) => {
          present.set(target, change === 'corrupt' ? hex('corrupt stage') : sha256!);
          return Promise.resolve({ size: original.size, sha256: sha256! });
        });
        if (change === 'wrong-size') {
          const stat = vi.mocked(lstat).getMockImplementation()!;
          vi.mocked(lstat).mockImplementation((path, options) => {
            if (String(path).includes('/staging/'))
              return Promise.resolve({
                dev: 1n,
                ino: 1n,
                size: 1n,
                mtimeNs: 1n,
                ctimeNs: 1n,
                nlink: 1n,
                isFile: () => true,
                isSymbolicLink: () => false,
              } as never);
            return stat(path, options);
          });
        }
        await expect(
          sut.restore({
            bucket,
            manifest,
            scope: 'asset',
            files: [original],
            destination,
            mediaLocation: MEDIA,
            backupsFolder: '/data/backups',
            operationId: 'op-1',
            start: emptyRestoreResult(),
            checkpoint: () => Promise.resolve(true),
            publish: (_file, _staged, commit) => commit(),
          }),
        ).rejects.toThrow('Owner restore staging size or checksum mismatch');
        expect(present.get(original.target)).toBe(hex('occupied'));
        expect(storage.rename).not.toHaveBeenCalled();
      },
    );

    it('refuses stage mutation after hashing before moving the valid original aside', async () => {
      const { files, destination } = plan('asset', ['asset-1']);
      const original = files[0];
      present.set(original.target, hex('occupied'));
      store.download.mockImplementationOnce((_connection, _key, _bucketKey, target, sha256) => {
        present.set(target, sha256!);
        return Promise.resolve({ size: original.size, sha256: sha256! });
      });
      let guardCalls = 0;
      await expect(
        sut.restore({
          bucket,
          manifest,
          scope: 'asset',
          files: [original],
          destination,
          mediaLocation: MEDIA,
          backupsFolder: '/data/backups',
          operationId: 'op-1',
          start: emptyRestoreResult(),
          checkpoint: () => Promise.resolve(true),
          publish: (_file, staged, commit) => {
            if (++guardCalls === 2) present.set(staged, hex('changed after hash'));
            return commit();
          },
        }),
      ).rejects.toThrow('Owner restore original changed');
      expect(present.get(original.target)).toBe(hex('occupied'));
      expect(storage.rename).not.toHaveBeenCalled();
    });

    it('refuses wrong-sized verified owner staging before moving the occupied target', async () => {
      const { files, destination } = plan('asset', ['asset-1']);
      present.set(files[0].target, hex('occupied'));
      const publish = vi.fn();
      store.download.mockResolvedValueOnce({ size: 1, sha256: files[0].sha256 });
      await expect(
        sut.restore({
          bucket,
          manifest,
          scope: 'asset',
          files: [files[0]],
          destination,
          mediaLocation: MEDIA,
          backupsFolder: '/data/backups',
          operationId: 'op-1',
          start: emptyRestoreResult(),
          checkpoint: () => Promise.resolve(true),
          publish,
        } as Parameters<CloudBackupRestorer['restore']>[0]),
      ).rejects.toThrow('size');
      expect(present.get(files[0].target)).toBe(hex('occupied'));
      expect(publish).not.toHaveBeenCalled();
      expect(storage.rename).not.toHaveBeenCalled();
    });

    it('publishes only after the owner guard accepts verified staging and preserves the move-aside rule', async () => {
      const { files, destination } = plan('asset', ['asset-1']);
      const original = files[0];
      present.set(original.target, hex('occupied'));
      store.download.mockImplementationOnce((_connection, _key, _bucketKey, target: string, sha256: string | null) => {
        expect(target).not.toBe(original.target);
        expect(present.get(original.target)).toBe(hex('occupied'));
        present.set(target, sha256!);
        return Promise.resolve({ size: original.size, sha256: sha256! });
      });
      const publish = vi.fn(async (_file, staged, commit: () => Promise<string>) => {
        expect(present.get(staged)).toBe(original.sha256);
        expect(present.get(original.target)).toBe(hex('occupied'));
        return commit();
      });
      const result = await sut.restore({
        bucket,
        manifest,
        scope: 'asset',
        files: [original],
        destination,
        mediaLocation: MEDIA,
        backupsFolder: '/data/backups',
        operationId: 'op-1',
        start: emptyRestoreResult(),
        checkpoint: () => Promise.resolve(true),
        publish: publish as never,
      });
      expect(result?.replaced).toBe(1);
      expect(present.get(original.target)).toBe(original.sha256);
      expect(present.values().toArray()).toContain(hex('occupied'));
    });

    it('hashes an occupied owner target before entering the publication transaction', async () => {
      const { files, destination } = plan('asset', ['asset-1']);
      const original = files[0];
      present.set(original.target, hex('occupied'));
      let transactionActive = false;
      crypto.hashFile.mockImplementation((path: string) => {
        expect(transactionActive, 'whole-file hash holds the publication transaction').toBe(false);
        return Promise.resolve(Buffer.from(present.get(path)!, 'hex'));
      });
      store.download.mockImplementationOnce((_connection, _key, _bucketKey, target, sha256) => {
        present.set(target, sha256!);
        return Promise.resolve({ size: original.size, sha256: sha256! });
      });
      await sut.restore({
        bucket,
        manifest,
        scope: 'asset',
        files: [original],
        destination,
        mediaLocation: MEDIA,
        backupsFolder: '/data/backups',
        operationId: 'op-1',
        start: emptyRestoreResult(),
        checkpoint: () => Promise.resolve(true),
        publish: async (_file, _staged, commit) => {
          transactionActive = true;
          try {
            return await commit();
          } finally {
            transactionActive = false;
          }
        },
      });
      expect(crypto.hashFile).toHaveBeenCalledTimes(2);
    });

    it.each(['occupied', 'missing'])(
      'refuses a %s target changed after prepublication evidence without moving it aside',
      async (initial) => {
        const { files, destination } = plan('asset', ['asset-1']);
        const original = files[0];
        if (initial === 'occupied') present.set(original.target, hex('occupied'));
        let guardCalls = 0;
        store.download.mockImplementationOnce((_connection, _key, _bucketKey, target, sha256) => {
          present.set(target, sha256!);
          return Promise.resolve({ size: original.size, sha256: sha256! });
        });
        await expect(
          sut.restore({
            bucket,
            manifest,
            scope: 'asset',
            files: [original],
            destination,
            mediaLocation: MEDIA,
            backupsFolder: '/data/backups',
            operationId: 'op-1',
            start: emptyRestoreResult(),
            checkpoint: () => Promise.resolve(true),
            publish: async (_file, _staged, commit) => {
              if (++guardCalls === 2) present.set(original.target, hex('new occupant'));
              return commit();
            },
          }),
        ).rejects.toThrow('Owner restore original changed');
        expect(present.get(original.target)).toBe(hex('new occupant'));
        expect(storage.rename).not.toHaveBeenCalled();
      },
    );

    it('never overwrites an earlier moved-aside file when the same owner operation publishes again', async () => {
      const { files, destination } = plan('asset', ['asset-1']);
      const original = files[0];
      store.download.mockImplementation((_connection, _key, _bucketKey, target, sha256) => {
        present.set(target, sha256!);
        return Promise.resolve({ size: original.size, sha256: sha256! });
      });
      const publish = (_file: unknown, _staged: string, commit: () => Promise<'written' | 'skipped' | 'replaced'>) =>
        commit();
      const options = {
        bucket,
        manifest,
        scope: 'asset' as const,
        files: [original],
        destination,
        mediaLocation: MEDIA,
        backupsFolder: '/data/backups',
        operationId: 'op-1',
        start: emptyRestoreResult(),
        checkpoint: () => Promise.resolve(true),
        publish,
      };
      present.set(original.target, hex('first occupant'));
      await sut.restore(options);
      present.set(original.target, hex('second occupant'));
      await sut.restore(options);
      expect(present.values().toArray()).toEqual(
        expect.arrayContaining([hex('first occupant'), hex('second occupant'), original.sha256]),
      );
    });

    it('records each owner file before a following object fails, retaining truthful partial progress', async () => {
      const { files, destination } = plan('asset', ['asset-1']);
      store.download
        .mockImplementationOnce((_connection, _key, _bucketKey, target: string, sha256: string | null) => {
          present.set(target, sha256!);
          return Promise.resolve({ size: files[0].size, sha256: sha256! });
        })
        .mockRejectedValueOnce(new Error('second object unavailable'));
      const checkpoint = vi.fn().mockResolvedValue(true);
      await expect(
        sut.restore({
          bucket,
          manifest,
          scope: 'asset',
          files,
          destination,
          mediaLocation: MEDIA,
          backupsFolder: '/data/backups',
          operationId: 'op-1',
          start: emptyRestoreResult(),
          checkpoint,
          publish: async (_file, _staged, commit) => commit(),
        }),
      ).rejects.toThrow('second object unavailable');
      expect(checkpoint).toHaveBeenCalledWith(expect.objectContaining({ files: 1, bytes: files[0].size }));
      expect(present.get(files[0].target)).toBe(files[0].sha256);
    });

    it('fetches every object by its SHA-256 name and has it verified against that name', async () => {
      const result = await restore('files', ['asset-1']);

      expect(store.download).toHaveBeenCalledWith(
        bucket.connection,
        `o/${hex('one')}`,
        bucket.bucketKey,
        expect.stringMatching(/\/asset-1\/\.cloud-restore-.*\.tmp$/),
        hex('one'),
      );
      expect(result).toMatchObject({ phase: 'done', files: 2, filesTotal: 2, bytesTotal: 105, skipped: 0 });
    });

    it('leaves a file that is already in place, and moves a different one aside, never deleting it', async () => {
      present.set('/data/library/owner-1/2026/IMG_1.jpg', hex('damaged'));
      present.set('/data/library/owner-1/2026/IMG_1.jpg.xmp', hex('xmp'));

      const result = await restore('asset', ['asset-1']);

      expect(storage.rename).toHaveBeenCalledWith(
        '/data/library/owner-1/2026/IMG_1.jpg',
        '/data/frameleaf/restore/replaced/op-1/library/owner-1/2026/IMG_1.jpg',
      );
      expect(storage.unlink).not.toHaveBeenCalled();
      expect(present.get('/data/library/owner-1/2026/IMG_1.jpg')).toBe(hex('one'));
      expect(result).toMatchObject({ files: 2, skipped: 1, replaced: 1, restoredAssetIds: ['asset-1'] });
    });

    it('puts the database dump into the backups folder for the maintenance restore', async () => {
      const result = await restore('database');

      expect(store.download).toHaveBeenCalledWith(
        bucket.connection,
        manifest.database!.key,
        bucket.bucketKey,
        expect.stringMatching(/\/backups\/\.cloud-restore-.*\.tmp$/),
        hex('dump'),
      );
      expect(result).toMatchObject({
        phase: 'done',
        databaseFile: 'cloud-restore-immich-db-backup-20260926T030000-v3.2.0-pg16.4.sql.gz',
      });
    });

    it('stops at an object that does not match its checksum, and says which', async () => {
      store.download.mockRejectedValueOnce(new CloudBackupStoreError('mismatch', null, 'ChecksumMismatch'));

      await expect(restore('files', ['asset-1'])).rejects.toThrow(`o/${hex('one')} does not match its checksum`);
      expect(store.download).toHaveBeenCalledTimes(1);
    });

    it.each([
      new CloudBackupStoreError('missing', 404, 'NoSuchKey'),
      new CloudBackupStoreError('mismatch', null, 'ChecksumMismatch'),
      new Error('cancelled'),
    ])('preserves the occupied admin target when download fails: %s', async (error) => {
      const target = '/data/library/owner-1/2026/IMG_1.jpg';
      present.set(target, hex('existing'));
      store.download.mockRejectedValueOnce(error);
      await expect(restore('asset', ['asset-1'])).rejects.toThrow();
      expect(present.get(target)).toBe(hex('existing'));
      expect(storage.rename).not.toHaveBeenCalled();
    });

    it('stops at an object that is missing from the bucket', async () => {
      store.download.mockRejectedValueOnce(new CloudBackupStoreError('missing', 404, 'NoSuchKey'));

      await expect(restore('files', ['asset-1'])).rejects.toThrow('missing from the bucket');
    });

    it('carries on after its cursor when it resumes', async () => {
      const { files, destination } = plan('files', ['asset-1']);
      const result = await sut.restore({
        bucket,
        manifest,
        scope: 'files',
        files,
        destination,
        mediaLocation: MEDIA,
        backupsFolder: '/data/backups',
        operationId: 'op-1',
        start: { ...emptyRestoreResult(), cursor: files[0].fileKey, files: 1, bytes: 100 },
        checkpoint: () => Promise.resolve(true),
      });

      expect(store.download).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({ files: 2, bytes: 105 });
    });

    it('puts items, details and albums back after the files and before the database, once, even after a pause', async () => {
      const { files, destination } = plan('library');
      const order: string[] = [];
      store.download = vi
        .fn()
        .mockImplementation((_connection, key: string, _bucketKey, target: string, sha256: string | null) => {
          order.push(key.startsWith('db/') ? 'database' : 'file');
          present.set(target, sha256!);
          const size =
            [
              ...Object.values(manifest.assets).flatMap((asset) => asset.files),
              ...Object.values(manifest.profiles),
              manifest.database!,
            ].find((file) => file.sha256 === sha256)?.size ?? 1;
          return Promise.resolve({ size, sha256 });
        });
      const library = vi.fn().mockImplementation((result) => {
        order.push('library');
        return Promise.resolve({ ...result, recreated: 1 });
      });
      const options = {
        bucket,
        manifest,
        scope: 'library' as const,
        files,
        destination,
        mediaLocation: MEDIA,
        backupsFolder: '/data/backups',
        operationId: 'op-1',
        library,
      };

      // paused as soon as the files are back
      const paused = await sut.restore({
        ...options,
        start: emptyRestoreResult(),
        checkpoint: (result) => Promise.resolve(result.phase !== 'library'),
      });
      expect(paused).toBeNull();
      expect(library).not.toHaveBeenCalled();

      const resumed = await sut.restore({
        ...options,
        start: { ...emptyRestoreResult(), phase: 'library' },
        checkpoint: () => Promise.resolve(true),
      });
      expect(library).toHaveBeenCalledOnce();
      expect(order.slice(-2)).toEqual(['library', 'database']);
      expect(resumed).toMatchObject({ phase: 'done', recreated: 1 });
    });
  });
});
