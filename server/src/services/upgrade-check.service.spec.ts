import { serverVersion } from 'src/constants.js';
import { UpgradeCheckService, upgradeCheckSummary } from 'src/services/upgrade-check.service.js';
import {
  type LibraryFingerprint,
  type LibraryFingerprintCounts,
  UPGRADE_FINGERPRINT_KEY,
  type UpgradeFingerprintState,
} from 'src/utils/library-fingerprint.js';
import { ServiceMocks, newTestService } from 'test/utils.js';

const CURRENT = serverVersion.toString();
const PREVIOUS = '0.0.1';
const LIBRARY = '/mnt/photos';
const OWN = ['/data/library', '/data/upload', '/data/encoded-video'];
const SENTINEL = 'a3c1f0de-0000-4000-8000-000000000001';

const gone = () => Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' });

const counts = (patch: Partial<LibraryFingerprintCounts> = {}): LibraryFingerprintCounts => ({
  total: 600,
  newestAt: '2027-01-04T18:30:00.000Z',
  byType: { IMAGE: 600 },
  byOwner: { 'owner-1': 600 },
  byLibrary: { 'library-1': 600 },
  tables: { asset: 600, user: 1, album: 3, person: 9, asset_face: 80, smart_search: 600 },
  roots: [{ path: LIBRARY, assets: 600, folders: { '2023': 250, '2024': 350 } }],
  ...patch,
});

const before = (): LibraryFingerprint => ({
  version: PREVIOUS,
  capturedAt: '2027-01-05T10:00:00.000Z',
  assets: {
    total: 600,
    newestAt: '2027-01-04T18:30:00.000Z',
    byType: { IMAGE: 600 },
    byOwner: { 'owner-1': 600 },
    byLibrary: { 'library-1': 600 },
  },
  tables: { asset: 600, user: 1, album: 3, person: 9, asset_face: 80, smart_search: 600 },
  roots: [
    {
      kind: 'library',
      name: 'Family archive',
      path: LIBRARY,
      sentinelId: SENTINEL,
      state: 'present',
      assets: 600,
      folders: { '2023': 250, '2024': 350 },
    },
  ],
});

const record = { kind: 'library' as const, name: 'Family archive', path: LIBRARY, sentinelId: SENTINEL };

describe(UpgradeCheckService.name, () => {
  let sut: UpgradeCheckService;
  let mocks: ServiceMocks;
  /** The folders that exist, with the names in each, and the content of the files that can be read. */
  let folders: Map<string, string[]>;
  let files: Map<string, string>;
  let stored: UpgradeFingerprintState | null;

  const saved = () => mocks.systemMetadata.set.mock.calls.at(-1)?.[1] as UpgradeFingerprintState;

  beforeEach(() => {
    ({ sut, mocks } = newTestService(UpgradeCheckService));
    // Frameleaf's own folders are in place, with their mount files; the external library is mounted
    folders = new Map<string, string[]>(OWN.map((path) => [path, ['.frameleaf', 'owner-1']]));
    folders.set(LIBRARY, ['.frameleaf-sentinel', '2023', '2024']);
    files = new Map([[`${LIBRARY}/.frameleaf-sentinel`, `${SENTINEL}\n`]]);
    stored = null;

    mocks.systemMetadata.get.mockImplementation((key: string) =>
      Promise.resolve(key === UPGRADE_FINGERPRINT_KEY ? stored : null),
    );
    mocks.library.getAll.mockResolvedValue([{ name: 'Family archive', importPaths: [LIBRARY] }] as never);
    mocks.database.getLibraryFingerprintCounts.mockResolvedValue(counts());
    mocks.storage.readdir.mockImplementation((path: string) =>
      folders.has(path) ? Promise.resolve(folders.get(path)!) : Promise.reject(gone()),
    );
    mocks.storage.stat.mockImplementation((path: string) => {
      // every folder, and every name inside one
      const present = new Set(
        [...folders].flatMap(([folder, names]) => [folder, ...names.map((n) => `${folder}/${n}`)]),
      );
      return present.has(path) ? Promise.resolve({} as never) : Promise.reject(gone());
    });
    mocks.storage.readFile.mockImplementation((path: string) =>
      files.has(path) ? Promise.resolve(Buffer.from(files.get(path)!)) : Promise.reject(gone()),
    );
    mocks.storage.createFile.mockImplementation((path: string, content: Buffer) => {
      files.set(path, content.toString());
      return Promise.resolve();
    });
  });

  describe('the check after an upgrade', () => {
    beforeEach(() => {
      stored = { roots: [record], pending: { toVersion: CURRENT, before: before() } };
    });

    it('reports ok with matching counts after a clean upgrade, and stops waiting', async () => {
      await sut.onBootstrap();

      expect(saved().pending).toBeUndefined();
      expect(saved().latest).toMatchObject({
        fromVersion: PREVIOUS,
        toVersion: CURRENT,
        state: 'ok',
        findings: [],
        assets: { before: 600, after: 600 },
      });
      // both fingerprints are kept for a rollback to read
      expect(saved().latest?.before).toEqual(before());
      expect(saved().latest?.after.roots[0]).toMatchObject({ path: LIBRARY, state: 'present', assets: 600 });
      expect(mocks.logger.warn).not.toHaveBeenCalled();
    });

    it('reports the missing drive, not missing photos, when a library folder is not mounted', async () => {
      // Docker leaves the empty mount point behind
      folders.set(LIBRARY, []);
      files.clear();

      await sut.onBootstrap();

      expect(saved().latest?.state).toBe('attention');
      expect(saved().latest?.findings).toEqual([
        {
          reason: 'drive-missing',
          path: LIBRARY,
          name: 'Family archive',
          before: 600,
          after: null,
          beforeAt: null,
          afterAt: null,
        },
      ]);
      // the sentinel stays on record and nothing is written to the empty mount point
      expect(saved().roots).toContainEqual(record);
      expect(mocks.storage.createFile).not.toHaveBeenCalledWith(`${LIBRARY}/.frameleaf-sentinel`, expect.anything());
      expect(mocks.logger.warn).toHaveBeenCalledWith(expect.stringContaining(`drive-missing (${LIBRARY})`));
    });

    it('reports the drive when another drive is mounted in its place', async () => {
      files.set(`${LIBRARY}/.frameleaf-sentinel`, 'ffffffff-0000-4000-8000-00000000000f\n');

      await sut.onBootstrap();

      expect(saved().latest?.findings).toEqual([expect.objectContaining({ reason: 'drive-missing', path: LIBRARY })]);
      expect(saved().roots).toContainEqual(record);
    });

    it('reports a folder that is gone even when no sentinel was on record for it', async () => {
      stored = { pending: { toVersion: CURRENT, before: { ...before(), roots: [] } } };
      folders.delete(LIBRARY);
      files.clear();
      mocks.database.getLibraryFingerprintCounts.mockResolvedValue(
        counts({
          roots: [
            ...OWN.map((path) => ({ path, assets: 0, folders: {} })),
            { path: LIBRARY, assets: 600, folders: { '2023': 250, '2024': 350 } },
          ],
        }),
      );

      await sut.onBootstrap();

      expect(saved().latest?.findings).toEqual([
        expect.objectContaining({ reason: 'drive-missing', path: LIBRARY, before: 600 }),
      ]);
    });

    it('reports fewer photos when the count fell', async () => {
      mocks.database.getLibraryFingerprintCounts.mockResolvedValue(counts({ total: 500 }));

      await sut.onBootstrap();

      expect(saved().latest?.findings).toEqual([
        expect.objectContaining({ reason: 'photos-fewer', before: 600, after: 500 }),
      ]);
    });

    it('asks the database about the roots on record and the ones added since', async () => {
      await sut.onBootstrap();
      expect(mocks.database.getLibraryFingerprintCounts).toHaveBeenCalledWith([LIBRARY, ...OWN]);
    });

    it('leaves a fingerprint that waits for another version unchecked, and drops it', async () => {
      stored = { roots: [record], pending: { toVersion: '99.0.0', before: before() } };

      await sut.onBootstrap();

      expect(mocks.database.getLibraryFingerprintCounts).not.toHaveBeenCalled();
      expect(saved().pending).toBeUndefined();
      expect(saved().latest).toBeUndefined();
    });

    it('never stops a start', async () => {
      mocks.library.getAll.mockRejectedValue(new Error('connection terminated'));

      await expect(sut.onBootstrap()).resolves.toBeUndefined();
      expect(mocks.systemMetadata.set).not.toHaveBeenCalled();
      expect(mocks.logger.warn).toHaveBeenCalledWith(expect.stringContaining('connection terminated'));
    });
  });

  describe('mount sentinels', () => {
    it('writes a sentinel with a random id in each root that is in place and has files', async () => {
      files.clear();
      folders.set(LIBRARY, ['2023', '2024']);

      await sut.onBootstrap();

      expect(mocks.storage.createFile).toHaveBeenCalledWith(
        `${LIBRARY}/.frameleaf-sentinel`,
        Buffer.from('random-uuid\n'),
      );
      expect(saved().roots).toEqual([
        ...OWN.map((path) => ({ kind: 'storage', name: '', path, sentinelId: 'random-uuid' })),
        { kind: 'library', name: 'Family archive', path: LIBRARY, sentinelId: 'random-uuid' },
      ]);
      expect(saved().latest).toBeUndefined();
    });

    it('takes up a sentinel that is already there', async () => {
      await sut.onBootstrap();

      expect(mocks.storage.createFile).not.toHaveBeenCalledWith(`${LIBRARY}/.frameleaf-sentinel`, expect.anything());
      expect(saved().roots).toContainEqual(record);
    });

    it('writes nothing to an empty or missing folder', async () => {
      files.clear();
      folders.set(LIBRARY, []);
      folders.delete('/data/encoded-video');

      await sut.onBootstrap();

      expect(saved().roots?.map(({ path }) => path)).toEqual(['/data/library', '/data/upload']);
    });

    it('records a folder it cannot write to without a sentinel, and tells it is in place by its files', async () => {
      files.clear();
      folders.set(LIBRARY, ['2023', '2024']);
      mocks.storage.createFile.mockImplementation((path: string, content: Buffer) => {
        if (path.startsWith(LIBRARY)) {
          return Promise.reject(Object.assign(new Error('EROFS: read-only file system'), { code: 'EROFS' }));
        }
        files.set(path, content.toString());
        return Promise.resolve();
      });

      await sut.onBootstrap();
      expect(saved().roots).toContainEqual({ ...record, sentinelId: null });

      // after the next upgrade the share is not mounted: its mount point is empty
      stored = {
        roots: saved().roots,
        pending: {
          toVersion: CURRENT,
          before: { ...before(), roots: [{ ...before().roots[0], sentinelId: null }] },
        },
      };
      folders.set(LIBRARY, []);

      await sut.onBootstrap();
      expect(saved().latest?.findings).toEqual([expect.objectContaining({ reason: 'drive-missing', path: LIBRARY })]);
    });

    it('settles on a replaced drive on a later start, once the check has had its say', async () => {
      stored = { roots: [record] };
      files.set(`${LIBRARY}/.frameleaf-sentinel`, 'ffffffff-0000-4000-8000-00000000000f\n');

      await sut.onBootstrap();

      expect(saved().roots).toContainEqual({ ...record, sentinelId: 'ffffffff-0000-4000-8000-00000000000f' });
    });

    it('keeps the record of a drive that is still away', async () => {
      stored = { roots: [record] };
      files.clear();
      folders.set(LIBRARY, []);

      await sut.onBootstrap();

      expect(saved().roots).toContainEqual(record);
    });

    it('forgets the folder of a library that was removed', async () => {
      stored = { roots: [record] };
      mocks.library.getAll.mockResolvedValue([]);

      await sut.onBootstrap();

      expect(saved().roots?.map(({ path }) => path)).toEqual(OWN);
    });
  });

  describe('getUpgradeCheck', () => {
    it('says none before the first upgrade with the check in place', async () => {
      await expect(sut.getUpgradeCheck()).resolves.toEqual({
        state: 'none',
        reason: null,
        checkedAt: null,
        fromVersion: null,
        toVersion: null,
        findings: [],
        assetsBefore: null,
        assetsAfter: null,
        counts: [],
      });
    });

    it('returns the latest check', async () => {
      stored = { roots: [record], pending: { toVersion: CURRENT, before: before() } };
      folders.set(LIBRARY, []);
      files.clear();
      await sut.onBootstrap();
      stored = saved();

      const response = await sut.getUpgradeCheck();

      expect(response).toMatchObject({
        state: 'attention',
        reason: 'upgrade-check-failed',
        fromVersion: PREVIOUS,
        toVersion: CURRENT,
        assetsBefore: 600,
        assetsAfter: 600,
      });
      expect(response.findings).toHaveLength(1);
      expect(response.counts).toContainEqual({ name: 'asset', before: 600, after: 600 });
      // the fingerprints themselves stay on the server
      expect(response).not.toHaveProperty('before');
      expect(response).not.toHaveProperty('after');
    });
  });

  describe('upgradeCheckSummary', () => {
    it('gives a reason only when the check needs someone', () => {
      expect(upgradeCheckSummary(null)).toEqual({
        state: 'none',
        reason: null,
        checkedAt: null,
        fromVersion: null,
        toVersion: null,
      });
      const latest = {
        fromVersion: PREVIOUS,
        toVersion: CURRENT,
        checkedAt: '2027-01-05T10:02:00.000Z',
        findings: [],
        assets: { before: 600, after: 600 },
        newestAt: { before: null, after: null },
        tables: [],
        before: before(),
        after: before(),
      };
      expect(upgradeCheckSummary({ latest: { ...latest, state: 'ok' } })).toMatchObject({ state: 'ok', reason: null });
      expect(upgradeCheckSummary({ latest: { ...latest, state: 'attention' } })).toMatchObject({
        state: 'attention',
        reason: 'upgrade-check-failed',
      });
    });
  });
});
