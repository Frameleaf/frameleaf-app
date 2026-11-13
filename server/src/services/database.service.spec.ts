import { serverVersion } from 'src/constants.js';
import { DatabaseExtension, DatabaseLock, VectorIndex } from 'src/enum.js';
import { DatabaseService } from 'src/services/database.service.js';
import {
  type LibraryFingerprintCounts,
  UPGRADE_FINGERPRINT_KEY,
  type UpgradeFingerprintState,
} from 'src/utils/library-fingerprint.js';
import { ServiceMocks, newTestService } from 'test/utils.js';

describe(DatabaseService.name, () => {
  let sut: DatabaseService;
  let mocks: ServiceMocks;
  beforeEach(() => {
    ({ sut, mocks } = newTestService(DatabaseService));
    mocks.database.getPostgresVersion.mockResolvedValue('19rc1 (Debian)');
    mocks.database.getPostgresVersionRange.mockReturnValue('>=19.0.0 <20.0.0');
    mocks.database.getExtensionVersionRange.mockReturnValue('>=0.8.7 <0.9.0');
    mocks.database.getExtensionVersions.mockResolvedValue([
      { name: DatabaseExtension.Vector, installedVersion: '0.8.7', availableVersion: '0.8.7' },
    ]);
  });

  it.each(['18.4', '20.0', 'unknown'])('rejects unsupported PostgreSQL %s before mutating it', async (version) => {
    mocks.database.getPostgresVersion.mockResolvedValue(version);
    await expect(sut.onBootstrap()).rejects.toThrow('Frameleaf requires PostgreSQL 19');
    expect(mocks.database.runMigrations).not.toHaveBeenCalled();
    expect(mocks.database.createExtension).not.toHaveBeenCalled();
  });

  it('boots PostgreSQL 19 prerelease with one migration chain and HNSW indexes', async () => {
    await sut.onBootstrap();
    expect(mocks.database.withLock).toHaveBeenCalledWith(DatabaseLock.Migrations, expect.any(Function));
    expect(mocks.database.assertFrameleafDatabase).toHaveBeenCalledOnce();
    expect(mocks.database.runMigrations).toHaveBeenCalledOnce();
    expect(mocks.database.assertImportActivated).toHaveBeenCalledOnce();
    expect(mocks.database.reindexVectorsIfNeeded).toHaveBeenCalledWith([
      VectorIndex.Clip,
      VectorIndex.Face,
      VectorIndex.VideoMomentFrame,
    ]);
  });

  it('rejects a populated source before extension or migration writes', async () => {
    mocks.database.assertFrameleafDatabase.mockRejectedValue(new Error('fresh destination required'));
    await expect(sut.onBootstrap()).rejects.toThrow('fresh destination required');
    expect(mocks.database.createExtension).not.toHaveBeenCalled();
    expect(mocks.database.runMigrations).not.toHaveBeenCalled();
  });

  it('creates the required pgvector extension only when absent', async () => {
    mocks.database.getExtensionVersions.mockResolvedValue([
      { name: DatabaseExtension.Vector, installedVersion: null, availableVersion: '0.8.7' },
    ]);
    await sut.onBootstrap();
    expect(mocks.database.createExtension).toHaveBeenCalledWith(DatabaseExtension.Vector);
  });

  it('keeps an unfinished import offline while the administration command can resume it', async () => {
    mocks.database.assertImportActivated.mockRejectedValue(new Error('DESTINATION_IMPORT_NOT_ACTIVATED'));
    await expect(sut.onBootstrap()).rejects.toThrow('DESTINATION_IMPORT_NOT_ACTIVATED');
    expect(mocks.database.reindexVectorsIfNeeded).not.toHaveBeenCalled();
    mocks.database.assertImportActivated.mockClear();
    await sut.initialize({ allowInactiveImport: true });
    expect(mocks.database.assertImportActivated).not.toHaveBeenCalled();
  });

  it('rejects an unsupported installed vector version without replacing data', async () => {
    mocks.database.getExtensionVersions.mockResolvedValue([
      { name: DatabaseExtension.Vector, installedVersion: '0.7.0', availableVersion: '0.8.7' },
    ]);
    await expect(sut.onBootstrap()).rejects.toThrow('Installed pgvector');
    expect(mocks.database.runMigrations).not.toHaveBeenCalled();
  });

  describe('FL-954 library fingerprint before an upgrade', () => {
    const current = serverVersion.toString();
    const root = { kind: 'library' as const, name: 'Family archive', path: '/mnt/photos', sentinelId: 'abcdefgh' };
    const counts: LibraryFingerprintCounts = {
      total: 600,
      newestAt: '2027-01-04T18:30:00.000Z',
      byType: { IMAGE: 600 },
      byOwner: { 'owner-1': 600 },
      byLibrary: { 'library-1': 600 },
      tables: { asset: 600, user: 1, album: 3, person: 9, asset_face: 80, smart_search: 600 },
      roots: [{ path: '/mnt/photos', assets: 600, folders: { '2024': 600 } }],
    };
    let stored: UpgradeFingerprintState | null;

    beforeEach(() => {
      stored = { roots: [root] };
      mocks.systemMetadata.get.mockImplementation((key: string) =>
        Promise.resolve(key === UPGRADE_FINGERPRINT_KEY ? stored : null),
      );
      mocks.database.getRecordedVersion.mockResolvedValue('0.0.1');
      mocks.database.getLibraryFingerprintCounts.mockResolvedValue(counts);
    });

    it('keeps a fingerprint of the old version before the migrations run', async () => {
      await sut.onBootstrap();

      expect(mocks.database.getLibraryFingerprintCounts).toHaveBeenCalledWith(['/mnt/photos']);
      expect(mocks.systemMetadata.set).toHaveBeenCalledWith(UPGRADE_FINGERPRINT_KEY, {
        roots: [root],
        pending: {
          toVersion: current,
          before: expect.objectContaining({
            version: '0.0.1',
            assets: expect.objectContaining({ total: 600, newestAt: '2027-01-04T18:30:00.000Z' }),
            tables: counts.tables,
            roots: [{ ...root, state: 'present', assets: 600, folders: { '2024': 600 } }],
          }),
        },
      });
      expect(mocks.systemMetadata.set.mock.invocationCallOrder[0]).toBeLessThan(
        mocks.database.runMigrations.mock.invocationCallOrder[0],
      );
    });

    it('keeps none on a start of the same version, or on a new server', async () => {
      mocks.database.getRecordedVersion.mockResolvedValue(current);
      await sut.onBootstrap();
      mocks.database.getRecordedVersion.mockResolvedValue(null);
      await sut.onBootstrap();

      expect(mocks.database.getLibraryFingerprintCounts).not.toHaveBeenCalled();
      expect(mocks.systemMetadata.set).not.toHaveBeenCalled();
      expect(mocks.database.runMigrations).toHaveBeenCalledTimes(2);
    });

    it('keeps the first fingerprint when an upgrade starts again, and takes none once it was checked', async () => {
      await sut.onBootstrap();
      stored = mocks.systemMetadata.set.mock.calls[0][1] as UpgradeFingerprintState;
      mocks.systemMetadata.set.mockClear();

      // a second worker, or a start that failed part way through the migrations
      await sut.onBootstrap();
      expect(mocks.systemMetadata.set).not.toHaveBeenCalled();

      // the check ran, and another worker starts before the new version is in the history
      const { before } = stored.pending!;
      stored = {
        latest: {
          fromVersion: '0.0.1',
          toVersion: current,
          checkedAt: '2027-01-05T10:02:00.000Z',
          state: 'ok',
          findings: [],
          assets: { before: 600, after: 600 },
          newestAt: { before: null, after: null },
          tables: [],
          before,
          after: before,
        },
      };
      await sut.onBootstrap();
      expect(mocks.systemMetadata.set).not.toHaveBeenCalled();
    });

    it('takes a new one when the fingerprint that waits is for another upgrade', async () => {
      await sut.onBootstrap();
      const first = mocks.systemMetadata.set.mock.calls[0][1] as UpgradeFingerprintState;
      stored = { pending: { toVersion: '99.0.0', before: first.pending!.before } };
      mocks.systemMetadata.set.mockClear();

      await sut.onBootstrap();

      expect(mocks.systemMetadata.set).toHaveBeenCalledWith(
        UPGRADE_FINGERPRINT_KEY,
        expect.objectContaining({ pending: expect.objectContaining({ toVersion: current }) }),
      );
    });

    it('goes on with the upgrade when the fingerprint cannot be taken', async () => {
      mocks.database.getLibraryFingerprintCounts.mockRejectedValue(new Error('column "libraryId" does not exist'));

      await sut.onBootstrap();

      expect(mocks.systemMetadata.set).not.toHaveBeenCalled();
      expect(mocks.database.runMigrations).toHaveBeenCalledOnce();
      expect(mocks.logger.warn).toHaveBeenCalledWith(expect.stringContaining('libraryId'));
    });

    it('takes none when there are no photos tables yet', async () => {
      mocks.database.getLibraryFingerprintCounts.mockResolvedValue(null);

      await sut.onBootstrap();

      expect(mocks.systemMetadata.set).not.toHaveBeenCalled();
      expect(mocks.database.runMigrations).toHaveBeenCalledOnce();
    });
  });
});
