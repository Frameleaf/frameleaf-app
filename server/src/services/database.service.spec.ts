import { DatabaseExtension, DatabaseLock, VectorIndex } from 'src/enum.js';
import { DatabaseService } from 'src/services/database.service.js';
import { ServiceMocks, newTestService } from 'test/utils.js';

describe(DatabaseService.name, () => {
  let sut: DatabaseService;
  let mocks: ServiceMocks;
  beforeEach(() => {
    ({ sut, mocks } = newTestService(DatabaseService));
    mocks.database.getPostgresVersion.mockResolvedValue('19beta4 (Debian)');
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
});
