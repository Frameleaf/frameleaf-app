import { Kysely } from 'kysely';
import { randomBytes } from 'node:crypto';
import { mapAsset } from 'src/dtos/asset-response.dto.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { DatabaseRepository } from 'src/repositories/database.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MapRepository } from 'src/repositories/map.repository.js';
import { PartnerRepository } from 'src/repositories/partner.repository.js';
import { PersonRepository } from 'src/repositories/person.repository.js';
import { PhysicalFileRepository } from 'src/repositories/physical-file.repository.js';
import { SearchRepository } from 'src/repositories/search.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { TagRepository } from 'src/repositories/tag.repository.js';
import { ViewRepository } from 'src/repositories/view-repository.js';
import { DB } from 'src/schema/index.js';
import { backfillLibraryPaths } from 'src/schema/migrations/2100000003007-AssetLibraryPath.js';
import { SearchService } from 'src/services/search.service.js';
import { ViewService } from 'src/services/view.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { factory } from 'test/small.factory.js';
import { getActiveForkKyselyDB as getKyselyDB } from 'test/utils.js';

/**
 * FL-417: when two people's photos share one stored file, each photo shows its own path. No asset
 * response, folder tree or path search ever names the folder the file is kept in when that folder is
 * another account's.
 */
let database: Kysely<DB>;

beforeAll(async () => {
  database = await getKyselyDB();
});

const SIZE = 4096;
const shot = new Date('2023-07-14T10:30:00.000Z');

const setup = async () => {
  const real = [
    AccessRepository,
    AssetRepository,
    ConfigRepository,
    DatabaseRepository,
    MapRepository,
    PartnerRepository,
    PersonRepository,
    PhysicalFileRepository,
    SearchRepository,
    SystemMetadataRepository,
    TagRepository,
    ViewRepository,
  ];
  const search = newMediumService(SearchService, { database, real, mock: [LoggingRepository] });
  const view = newMediumService(ViewService, { database, real, mock: [LoggingRepository] });
  const { ctx } = search;

  // two people whose storage labels differ, so a leaked folder name is easy to spot
  const label = `alice${randomBytes(3).toString('hex')}`;
  const { user: alice } = await ctx.newUser({ storageLabel: label });
  const { user: bob } = await ctx.newUser({ storageLabel: `bob${randomBytes(3).toString('hex')}` });
  const checksum = randomBytes(32);
  const sharedPath = `/data/library/${label}/Holidays 2023/IMG_0001.jpg`;
  const { asset: aliceAsset } = await ctx.newAsset({
    ownerId: alice.id,
    originalPath: sharedPath,
    originalFileName: 'IMG_0001.jpg',
    checksum,
    fileCreatedAt: shot,
    fileModifiedAt: shot,
    localDateTime: shot,
  });
  await ctx.newExif({ assetId: aliceAsset.id, fileSizeInByte: SIZE });
  return { search, view, ctx, alice, bob, label, checksum, sharedPath, aliceAsset };
};

const proven = { verify: () => Promise.resolve('same-file'), identify: () => Promise.resolve('same-file') };

describe('a shared file never shows another person’s folder', () => {
  it('keeps the photo’s own upload path when an upload links to another account’s file', async () => {
    const { search, view, ctx, bob, label, checksum, sharedPath } = await setup();
    const ownPath = `/data/upload/${bob.id}/ab/cd/bob-upload.jpg`;
    const { asset: bobAsset } = await ctx.newAsset({
      ownerId: bob.id,
      originalPath: ownPath,
      originalFileName: 'IMG_0001.jpg',
      checksum,
      fileCreatedAt: shot,
      fileModifiedAt: shot,
      localDateTime: shot,
    });
    await ctx.newExif({ assetId: bobAsset.id, fileSizeInByte: SIZE });

    const linked = await ctx
      .get(PhysicalFileRepository)
      .linkUploadedOriginal(bobAsset.id, { checksum, sizeInBytes: SIZE }, proven);
    expect(linked?.linked).toBe(true);

    const row = await database
      .selectFrom('asset')
      .select(['originalPath', 'libraryPath'])
      .where('id', '=', bobAsset.id)
      .executeTakeFirstOrThrow();
    // the bytes are read from the shared file; the photo shows its own path
    expect(row).toEqual({ originalPath: sharedPath, libraryPath: ownPath });

    const auth = factory.auth({ user: { id: bob.id } });
    const responses = [
      mapAsset((await ctx.get(AssetRepository).getById(bobAsset.id))!, { auth }),
      ...(await search.sut.searchMetadata(auth, {})).assets.items,
      ...(await search.sut.searchMetadata(auth, { originalPath: 'upload' })).assets.items,
      ...(await view.sut.getAssetsByOriginalPath(auth, `/data/upload/${bob.id}/ab/cd`)),
    ];
    expect(responses.map(({ id }) => id)).toEqual(Array.from({ length: 4 }, () => bobAsset.id));
    for (const response of responses) {
      expect(response.originalPath).toBe(ownPath);
    }
    const folders = await view.sut.getUniqueOriginalPaths(auth);
    const summary = await view.sut.getFolderSummary(auth);
    expect(folders).toEqual([`/data/upload/${bob.id}/ab/cd`]);
    expect(summary.map(({ path }) => path)).toEqual(folders);

    // path search follows the photo's own path, never the shared file's
    expect((await search.sut.searchMetadata(auth, { originalPath: label })).assets.items).toEqual([]);
    expect(
      (await search.sut.searchMetadata(auth, { filter: { originalPath: { like: label } } } as never)).assets.items,
    ).toEqual([]);
    expect(await view.sut.getAssetsByOriginalPath(auth, `/data/library/${label}/Holidays 2023`)).toEqual([]);

    expect(JSON.stringify({ responses, folders, summary })).not.toContain(label);
  });

  it('keeps the owner’s own path untouched', async () => {
    const { view, alice, sharedPath, aliceAsset } = await setup();
    const auth = factory.auth({ user: { id: alice.id } });
    const [response] = await view.sut.getAssetsByOriginalPath(auth, sharedPath.slice(0, sharedPath.lastIndexOf('/')));
    expect(response.id).toBe(aliceAsset.id);
    expect(response.originalPath).toBe(sharedPath);
  });

  it('backfills an existing link from the photo owner’s own label, never the other account’s path', async () => {
    const { ctx, bob, label, checksum, sharedPath, aliceAsset } = await setup();
    const physicalFile = await ctx.get(PhysicalFileRepository).ensureOriginalPhysicalFile(aliceAsset.id);
    // a photo linked before FL-417: its path is the other account's file and it has no path of its own
    const { asset: bobAsset } = await ctx.newAsset({
      ownerId: bob.id,
      originalPath: sharedPath,
      originalFileName: 'Beach.jpg',
      checksum,
      physicalOriginalFileId: physicalFile!.id,
      fileCreatedAt: shot,
      fileModifiedAt: shot,
      localDateTime: shot,
    });
    // a photo in its own folder keeps showing it
    const { asset: own } = await ctx.newAsset({
      ownerId: bob.id,
      originalPath: `/data/library/${bob.storageLabel}/2020/own.jpg`,
      physicalOriginalFileId: (await ctx.get(PhysicalFileRepository).ensureOriginalPhysicalFile(aliceAsset.id))!.id,
    });

    await backfillLibraryPaths(database);
    await backfillLibraryPaths(database);

    const rows = await database
      .selectFrom('asset')
      .select(['id', 'libraryPath'])
      .where('id', 'in', [bobAsset.id, own.id, aliceAsset.id])
      .execute();
    const pathOf = (id: string) => rows.find((row) => row.id === id)?.libraryPath;
    expect(pathOf(bobAsset.id)).toBe(`/data/library/${bob.storageLabel}/2023/2023-07-14/Beach.jpg`);
    expect(pathOf(bobAsset.id)).not.toContain(label);
    expect(pathOf(bobAsset.id)).not.toContain('Holidays');
    expect(pathOf(own.id)).toBeNull();
    expect(pathOf(aliceAsset.id)).toBeNull();
  });

  it('clears the library path when the photo gets its own file back', async () => {
    const { ctx, bob, checksum, sharedPath } = await setup();
    const ownPath = `/data/upload/${bob.id}/ef/gh/bob-own.jpg`;
    const { asset: bobAsset } = await ctx.newAsset({
      ownerId: bob.id,
      originalPath: ownPath,
      checksum,
      fileCreatedAt: shot,
      fileModifiedAt: shot,
      localDateTime: shot,
    });
    await ctx.newExif({ assetId: bobAsset.id, fileSizeInByte: SIZE });
    const physical = ctx.get(PhysicalFileRepository);
    await physical.linkUploadedOriginal(bobAsset.id, { checksum, sizeInBytes: SIZE }, proven);

    await physical.restoreOriginalPhysicalFile(bobAsset.id, { path: ownPath, checksum, sizeInBytes: SIZE });

    const row = await database
      .selectFrom('asset')
      .select(['originalPath', 'libraryPath'])
      .where('id', '=', bobAsset.id)
      .executeTakeFirstOrThrow();
    expect(row).toEqual({ originalPath: ownPath, libraryPath: null });
    expect(row.originalPath).not.toBe(sharedPath);
  });
});
