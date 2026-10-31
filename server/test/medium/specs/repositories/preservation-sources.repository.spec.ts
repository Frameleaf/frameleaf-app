import { Kysely } from 'kysely';
import { randomUUID } from 'node:crypto';
import { LibraryScope } from 'src/enum.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { PreservationRepository } from 'src/repositories/preservation.repository.js';
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import { preservationDerivedId } from 'src/utils/preservation.js';
import { newMediumService } from 'test/medium.factory.js';
import { getActiveForkKyselyDB } from 'test/utils.js';

let db: Kysely<DB>;
beforeAll(async () => {
  db = await getActiveForkKyselyDB();
});
afterAll(async () => {
  await db?.destroy();
});

const source = (captureId: string, overrides: Record<string, unknown> = {}) => ({
  captureId,
  pageUrl: 'https://eagle.example.com/board',
  mediaUrl: null,
  title: 'Board',
  capturedAt: '2026-10-29T10:00:00.000Z',
  note: null,
  creator: null,
  licenseUrl: null,
  ...overrides,
});

const setup = async (libraryScope = LibraryScope.Design) => {
  const { ctx } = newMediumService(BaseService, { database: db, real: [], mock: [LoggingRepository] });
  const { user } = await ctx.newUser();
  const { asset } = await ctx.newAsset({ ownerId: user.id, libraryScope });
  return { user, asset, sut: new PreservationRepository(db) };
};
const sourcesOf = (assetId: string) =>
  db.selectFrom('asset_source').selectAll().where('assetId', '=', assetId).execute();

describe('FL-653 restoring Eagle details', () => {
  it('fills a missing Eagle marker on a source the item already has, keeping its other details', async () => {
    const { user, asset, sut } = await setup();
    const captureId = randomUUID();
    await db
      .insertInto('asset_source')
      .values({ ...source(captureId), assetId: asset.id, title: 'Kept title', capturedAt: new Date() })
      .execute();
    await sut.appendRestoredSources(user.id, asset.id, [source(captureId, { importedFrom: 'eagle', title: 'Other' })]);
    expect(await sourcesOf(asset.id)).toEqual([
      expect.objectContaining({ captureId, title: 'Kept title', importedFrom: 'eagle' }),
    ]);
  });

  it('fills the marker on a source an earlier package restored without it', async () => {
    const { user, asset, sut } = await setup();
    const captureId = randomUUID();
    await sut.appendRestoredSources(user.id, asset.id, [source(captureId)]);
    await sut.appendRestoredSources(user.id, asset.id, [source(captureId, { importedFrom: 'eagle', note: 'New' })]);
    expect(await sourcesOf(asset.id)).toEqual([
      expect.objectContaining({
        captureId: preservationDerivedId(`${user.id}:source:${asset.id}:${captureId}`),
        note: null,
        importedFrom: 'eagle',
      }),
    ]);
  });

  it("restores a Boards-only item's Added date only to an earlier time in the past", async () => {
    const { user, asset, sut } = await setup();
    const addedAt = new Date('2024-03-01T12:00:00.000Z');
    await expect(sut.restoreAddedDate(user.id, asset.id, new Date(Date.now() + 60_000))).resolves.toBe(false);
    await expect(sut.restoreAddedDate(randomUUID(), asset.id, addedAt)).resolves.toBe(false);
    await expect(sut.restoreAddedDate(user.id, asset.id, addedAt)).resolves.toBe(true);
    await expect(sut.restoreAddedDate(user.id, asset.id, new Date('2025-01-01T00:00:00.000Z'))).resolves.toBe(false);
    const row = await db.selectFrom('asset').select('createdAt').where('id', '=', asset.id).executeTakeFirstOrThrow();
    expect(new Date(row.createdAt).toISOString()).toBe(addedAt.toISOString());

    const photos = await setup(LibraryScope.Both);
    await expect(photos.sut.restoreAddedDate(photos.user.id, photos.asset.id, addedAt)).resolves.toBe(false);
  });
});
