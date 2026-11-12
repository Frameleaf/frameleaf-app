import { Kysely } from 'kysely';
import { serverVersion } from 'src/constants.js';
import { StorageCore } from 'src/cores/storage.core.js';
import { AssetType } from 'src/enum.js';
import { CryptoRepository } from 'src/repositories/crypto.repository.js';
import { DatabaseRepository } from 'src/repositories/database.repository.js';
import { LibraryRepository } from 'src/repositories/library.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { StorageRepository } from 'src/repositories/storage.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { VersionHistoryRepository } from 'src/repositories/version-history.repository.js';
import { DB } from 'src/schema/index.js';
import { DatabaseService } from 'src/services/database.service.js';
import { UpgradeCheckService } from 'src/services/upgrade-check.service.js';
import { UPGRADE_FINGERPRINT_KEY, type UpgradeFingerprintState } from 'src/utils/library-fingerprint.js';
import { MediumTestContext, newMediumService } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

const ROOT = '/mnt/photos';
const SENTINEL = `${ROOT}/.frameleaf-sentinel`;
const OWN = ['/data/library', '/data/upload', '/data/encoded-video'];
const real = [
  DatabaseRepository,
  SystemMetadataRepository,
  LibraryRepository,
  VersionHistoryRepository,
  CryptoRepository,
];
const mock = [LoggingRepository, StorageRepository];
const gone = () => Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' });

/** Five files under one external library folder, one upload and one file beside the folder, added on known days. */
const seed = async (ctx: MediumTestContext) => {
  const { user } = await ctx.newUser();
  const { user: other } = await ctx.newUser();
  await ctx.database
    .insertInto('library')
    .values({ ownerId: user.id, name: 'Family archive', importPaths: [ROOT], exclusionPatterns: [] })
    .execute();
  const paths = [
    `${ROOT}/2023/a.jpg`,
    `${ROOT}/2023/b.jpg`,
    `${ROOT}/2024/summer/c.jpg`,
    `${ROOT}/2024/d.mov`,
    `${ROOT}/loose.jpg`,
    '/data/upload/owner/e.jpg',
    // a folder that only starts with the root's name is not inside it
    `${ROOT}-old/f.jpg`,
  ];
  const assets = [];
  for (const [index, originalPath] of paths.entries()) {
    const { asset } = await ctx.newAsset({
      ownerId: index === 5 ? other.id : user.id,
      originalPath,
      type: originalPath.endsWith('.mov') ? AssetType.Video : AssetType.Image,
      createdAt: new Date(Date.UTC(2027, 0, index + 1)),
    });
    assets.push(asset);
  }
  return { user, other, assets };
};

/** A server on its own database: what runs before the migrations, and the check that runs after the start. */
const setup = async () => {
  const database = await getKyselyDB();
  const { sut: databaseService } = newMediumService(DatabaseService, { database, real, mock });
  const { sut: check, ctx } = newMediumService(UpgradeCheckService, { database, real, mock });
  const storage = ctx.getMock(StorageRepository);
  /** What is on the drives: the folders with the names in them, and the sentinel files. */
  StorageCore.setMediaLocation('/data');
  // Frameleaf's own folders are in place, with their mount files
  const folders = new Map<string, string[]>(OWN.map((path) => [path, ['.frameleaf', 'owner']]));
  folders.set(ROOT, ['2023', '2024', 'loose.jpg']);
  const files = new Map<string, string>();
  storage.readdir.mockImplementation((path) =>
    folders.has(path) ? Promise.resolve(folders.get(path)!) : Promise.reject(gone()),
  );
  storage.stat.mockImplementation((path) => {
    // every folder, and every name inside one
    const present = new Set([...folders].flatMap(([folder, names]) => [folder, ...names.map((n) => `${folder}/${n}`)]));
    return present.has(path) ? Promise.resolve({} as never) : Promise.reject(gone());
  });
  storage.readFile.mockImplementation((path) =>
    files.has(path) ? Promise.resolve(Buffer.from(files.get(path)!)) : Promise.reject(gone()),
  );
  storage.createFile.mockImplementation((path, content) => {
    files.set(path, content.toString());
    folders.get(path.slice(0, path.lastIndexOf('/')))?.push('.frameleaf-sentinel');
    return Promise.resolve();
  });
  const state = () =>
    ctx.get(SystemMetadataRepository).get(UPGRADE_FINGERPRINT_KEY) as Promise<UpgradeFingerprintState | null>;
  /** What `DatabaseService` does under the migration lock, just before the migrations run. */
  const beforeMigrations = () =>
    (databaseService as unknown as { captureUpgradeFingerprint: () => Promise<void> }).captureUpgradeFingerprint();
  return { database, ctx, check, folders, files, state, beforeMigrations };
};

describe('library fingerprint (FL-954)', () => {
  const databases: Kysely<DB>[] = [];
  const start = async () => {
    const context = await setup();
    databases.push(context.database);
    return context;
  };
  afterAll(async () => {
    await Promise.all(databases.map((database) => database.destroy()));
  });

  it('counts the library by type, owner, library and top-level folder, and the key tables', async () => {
    const { ctx } = await start();
    const { user, other } = await seed(ctx);

    const counts = await ctx.get(DatabaseRepository).getLibraryFingerprintCounts([ROOT, '/mnt/none']);

    expect(counts).toMatchObject({
      total: 7,
      newestAt: '2027-01-07T00:00:00.000Z',
      byType: { IMAGE: 6, VIDEO: 1 },
      byOwner: { [user.id]: 6, [other.id]: 1 },
      byLibrary: { '': 7 },
      roots: [
        { path: ROOT, assets: 5, folders: { '': 1, '2023': 2, '2024': 2 } },
        { path: '/mnt/none', assets: 0, folders: {} },
      ],
    });
    expect(counts?.tables).toMatchObject({ asset: 7, user: 2, album: 0, person: 0, asset_face: 0, smart_search: 0 });
  });

  it('reads the version the database last ran from the upgrade history', async () => {
    const { ctx } = await start();
    const repository = ctx.get(DatabaseRepository);

    await expect(repository.getRecordedVersion()).resolves.toBeNull();
    await ctx.get(VersionHistoryRepository).create({ version: '1.4.0', createdAt: new Date('2026-12-01') });
    await ctx.get(VersionHistoryRepository).create({ version: '1.4.1', createdAt: new Date('2027-01-05') });
    await expect(repository.getRecordedVersion()).resolves.toBe('1.4.1');
  });

  it('reports ok with matching counts after a clean upgrade', async () => {
    const { ctx, check, files, state, beforeMigrations } = await start();
    await seed(ctx);
    // an ordinary start on the old version writes the sentinel
    await check.run();
    expect(files.has(SENTINEL)).toBe(true);
    await ctx.get(VersionHistoryRepository).create({ version: '0.0.1' });

    // the start on the new version: the fingerprint before the migrations, then the check
    await beforeMigrations();
    await expect(state()).resolves.toMatchObject({
      pending: { toVersion: serverVersion.toString(), before: { version: '0.0.1', assets: { total: 7 } } },
    });
    await check.run();

    const saved = await state();
    expect(saved?.pending).toBeUndefined();
    expect(saved?.latest).toMatchObject({
      fromVersion: '0.0.1',
      toVersion: serverVersion.toString(),
      state: 'ok',
      findings: [],
      assets: { before: 7, after: 7 },
    });
    await expect(check.getUpgradeCheck()).resolves.toMatchObject({
      state: 'ok',
      reason: null,
      assetsBefore: 7,
      assetsAfter: 7,
      counts: expect.arrayContaining([{ name: 'asset', before: 7, after: 7 }]),
    });

    // a second worker starting before the new version is in the history takes no new fingerprint
    await beforeMigrations();
    await expect(state()).resolves.not.toHaveProperty('pending');
  });

  it('reports the missing drive, not missing photos, when the library folder is not mounted after the upgrade', async () => {
    const { ctx, check, folders, files, state, beforeMigrations } = await start();
    await seed(ctx);
    await check.run();
    await ctx.get(VersionHistoryRepository).create({ version: '0.0.1' });

    // the new version starts with the drive away: Docker leaves an empty mount point
    folders.set(ROOT, []);
    files.delete(SENTINEL);
    await beforeMigrations();
    await check.run();

    const response = await check.getUpgradeCheck();
    expect(response).toMatchObject({
      state: 'attention',
      reason: 'upgrade-check-failed',
      assetsBefore: 7,
      assetsAfter: 7,
    });
    expect(response.findings).toEqual([
      {
        reason: 'drive-missing',
        path: ROOT,
        name: 'Family archive',
        before: 5,
        after: null,
        beforeAt: null,
        afterAt: null,
      },
    ]);
    // nothing was written to the empty mount point, and the sentinel stays on record
    expect(files.has(SENTINEL)).toBe(false);
    expect((await state())?.roots).toContainEqual(
      expect.objectContaining({ path: ROOT, sentinelId: expect.any(String) }),
    );
  });

  it('names what is gone when photos are lost across the upgrade', async () => {
    const { ctx, check, beforeMigrations } = await start();
    const { assets } = await seed(ctx);
    await check.run();
    await ctx.get(VersionHistoryRepository).create({ version: '0.0.1' });
    await beforeMigrations();

    // the newest file and a whole folder are gone once the new version is up
    await ctx.database.deleteFrom('asset').where('id', 'in', [assets[0].id, assets[1].id, assets[6].id]).execute();
    await check.run();

    const response = await check.getUpgradeCheck();
    expect(response.state).toBe('attention');
    expect(response.findings.map(({ reason, path }) => [reason, path])).toEqual([
      ['photos-fewer', null],
      ['newest-earlier', null],
      ['folder-empty', `${ROOT}/2023`],
    ]);
  });
});
