import { Kysely } from 'kysely';
import { LibraryScope } from 'src/enum.js';
import { AssetSourceRepository } from 'src/repositories/asset-source.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { getActiveForkKyselyDB } from 'test/utils.js';

let db: Kysely<DB>;
beforeAll(async () => {
  db = await getActiveForkKyselyDB();
});
afterAll(async () => {
  await db?.destroy();
});

const setup = () => {
  const { ctx } = newMediumService(BaseService, { database: db, real: [], mock: [LoggingRepository] });
  return { ctx, sut: new AssetSourceRepository(db) };
};

const readAsset = (id: string) =>
  db.selectFrom('asset').select(['createdAt', 'updateId']).where('id', '=', id).executeTakeFirstOrThrow();

describe('FL-653 imported sources', () => {
  it('adds an address once, even from items sent at the same time', async () => {
    const { ctx, sut } = setup();
    const { user } = await ctx.newUser();
    const { asset } = await ctx.newAsset({ ownerId: user.id, libraryScope: LibraryScope.Design });
    const input = { assetId: asset.id, importedFrom: 'eagle' as const, pageUrl: 'https://example.com/a', title: '' };
    const [first, second] = await Promise.all([sut.addImported(input), sut.addImported(input)]);
    expect(first.id).toBe(second.id);
    expect(first).toMatchObject({ importedFrom: 'eagle', mediaUrl: null, pageUrl: 'https://example.com/a' });
    await expect(sut.getAll(asset.id)).resolves.toHaveLength(1);
  });

  it('keeps an address the extension already saved as it is', async () => {
    const { ctx, sut } = setup();
    const { user } = await ctx.newUser();
    const { asset } = await ctx.newAsset({ ownerId: user.id, libraryScope: LibraryScope.Design });
    const extension = await db.transaction().execute((tx) =>
      sut.upsertCapture(tx, {
        assetId: asset.id,
        captureId: '9a7b6c5d-4e3f-4a1b-8c2d-3e4f5a6b7c8d',
        pageUrl: 'https://example.com/a',
        title: 'Saved page',
        capturedAt: new Date().toISOString(),
      }),
    );
    const imported = await sut.addImported({
      assetId: asset.id,
      importedFrom: 'eagle',
      pageUrl: 'https://example.com/a',
      title: '',
    });
    expect(imported).toMatchObject({ id: extension.id, importedFrom: null, title: 'Saved page' });
  });

  it('refuses an unknown importer at the database', async () => {
    const { ctx } = setup();
    const { user } = await ctx.newUser();
    const { asset } = await ctx.newAsset({ ownerId: user.id });
    await expect(
      db
        .insertInto('asset_source')
        .values({
          assetId: asset.id,
          captureId: '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d',
          pageUrl: 'https://example.com/',
          title: '',
          capturedAt: new Date(),
          importedFrom: 'pinterest' as 'eagle',
        })
        .execute(),
    ).rejects.toThrow(/asset_source_importedFrom_check/);
  });
});

describe('FL-653 Added date', () => {
  it("moves your Boards item's Added date earlier and moves its sync position", async () => {
    const { ctx, sut } = setup();
    const { user } = await ctx.newUser();
    const { asset } = await ctx.newAsset({ ownerId: user.id, libraryScope: LibraryScope.Design });
    const before = await readAsset(asset.id);
    const addedAt = new Date('2024-03-01T12:00:00.000Z');
    await expect(sut.moveAddedDateEarlier({ assetId: asset.id, ownerId: user.id, addedAt })).resolves.toBe(true);
    const after = await readAsset(asset.id);
    expect(new Date(after.createdAt).toISOString()).toBe(addedAt.toISOString());
    expect(after.updateId).not.toBe(before.updateId);
  });

  it('never moves a date later, nor changes an item in Photos, in the trash or of someone else', async () => {
    const { ctx, sut } = setup();
    const { user } = await ctx.newUser();
    const { user: other } = await ctx.newUser();
    const addedAt = new Date('2024-03-01T12:00:00.000Z');
    const { asset: both } = await ctx.newAsset({ ownerId: user.id, libraryScope: LibraryScope.Both });
    const { asset: trashed } = await ctx.newAsset({
      ownerId: user.id,
      libraryScope: LibraryScope.Design,
      deletedAt: new Date(),
    });
    const { asset: theirs } = await ctx.newAsset({ ownerId: other.id, libraryScope: LibraryScope.Design });
    const { asset: older } = await ctx.newAsset({ ownerId: user.id, libraryScope: LibraryScope.Design });
    await sut.moveAddedDateEarlier({ assetId: older.id, ownerId: user.id, addedAt });
    for (const asset of [both, trashed, theirs]) {
      const before = await readAsset(asset.id);
      await expect(sut.moveAddedDateEarlier({ assetId: asset.id, ownerId: user.id, addedAt })).resolves.toBe(false);
      await expect(readAsset(asset.id)).resolves.toEqual(before);
    }
    await expect(
      sut.moveAddedDateEarlier({ assetId: older.id, ownerId: user.id, addedAt: new Date('2025-01-01T00:00:00Z') }),
    ).resolves.toBe(false);
  });
});
