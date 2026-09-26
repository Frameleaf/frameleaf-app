import { createHash } from 'node:crypto';
import { CloudBackupStoreError } from 'src/repositories/cloud-backup-store.repository.js';
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
    let store: Record<string, ReturnType<typeof vi.fn>>;
    let storage: Record<string, ReturnType<typeof vi.fn>>;
    let crypto: Record<string, ReturnType<typeof vi.fn>>;
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
      store = {
        download: vi.fn().mockImplementation((_connection, _key, _bucketKey, target: string, sha256: string) => {
          present.set(target, sha256);
          return Promise.resolve({ size: 1, sha256 });
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

    it('fetches every object by its SHA-256 name and has it verified against that name', async () => {
      const result = await restore('files', ['asset-1']);

      expect(store.download).toHaveBeenCalledWith(
        bucket.connection,
        `o/${hex('one')}`,
        bucket.bucketKey,
        '/data/frameleaf/restore/op-1/asset-1/original-IMG_1.jpg',
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
        '/data/backups/cloud-restore-immich-db-backup-20260926T030000-v3.2.0-pg16.4.sql.gz',
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
  });
});
