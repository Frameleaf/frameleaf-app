import { Kysely } from 'kysely';
import { AssetVisibility } from 'src/enum.js';
import { AlbumRepository } from 'src/repositories/album.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { TagRepository } from 'src/repositories/tag.repository.js';
import { ViewRepository } from 'src/repositories/view-repository.js';
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import { upsertTags } from 'src/utils/tag.js';
import { newMediumService } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

/** FL-46: what the Folders browser shows of each folder without fetching its files. */
let db: Kysely<DB>;
beforeAll(async () => {
  db = await getKyselyDB();
});
afterAll(async () => {
  await db?.destroy();
});

const setup = () => {
  const { ctx } = newMediumService(BaseService, { database: db, real: [], mock: [LoggingRepository] });
  return { ctx, sut: new ViewRepository(db) };
};

/** An item captured at this local date and time */
const capturedAt = (dateTime: string) => {
  const date = new Date(dateTime);
  return { localDateTime: date, fileCreatedAt: date };
};

const day = (date: string) => new Date(`${date}T00:00:00.000Z`);

describe(ViewRepository.name, () => {
  describe('getFolderSummary', () => {
    it("summarises each folder's own originals: count, bytes, the four newest for a cover and the capture dates", async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const newFile = async (originalPath: string, dateTime: string, fileSizeInByte?: number) => {
        const { asset } = await ctx.newAsset({ ownerId: user.id, originalPath, ...capturedAt(dateTime) });
        if (fileSizeInByte !== undefined) {
          await ctx.newExif({ assetId: asset.id, fileSizeInByte });
        }
        return asset.id;
      };

      // the two oldest are counted and dated, and are not on the cover
      await newFile('/library/trips/a.jpg', '2021-07-04T09:00:00.000Z', 100);
      await newFile('/library/trips/b.jpg', '2022-07-04T09:00:00.000Z', 200);
      const middle = await newFile('/library/trips/c.jpg', '2023-07-04T09:00:00.000Z', 300);
      // two captures in the same instant: the lower id comes first
      const [tiedFirst, tiedSecond] = [
        await newFile('/library/trips/d.jpg', '2024-07-04T09:00:00.000Z', 400),
        await newFile('/library/trips/e.jpg', '2024-07-04T09:00:00.000Z', 500),
      ].toSorted();
      // no extracted size yet: it counts, with no bytes
      const newest = await newFile('/library/trips/f.jpg', '2025-07-04T09:00:00.000Z');
      // a folder's summary is its own files only, never a subfolder's
      const nested = await newFile('/library/trips/rockies/g.jpg', '2026-03-09T12:00:00.000Z', 1000);
      const root = await newFile('/library/h.jpg', '2020-01-01T12:00:00.000Z', 50);

      await expect(sut.getFolderSummary(user.id)).resolves.toEqual([
        {
          path: '/library',
          count: 1,
          size: 50,
          coverAssetIds: [root],
          startDate: day('2020-01-01'),
          endDate: day('2020-01-01'),
        },
        {
          path: '/library/trips',
          count: 6,
          size: 1500,
          coverAssetIds: [newest, tiedFirst, tiedSecond, middle],
          startDate: day('2021-07-04'),
          endDate: day('2025-07-04'),
        },
        {
          path: '/library/trips/rockies',
          count: 1,
          size: 1000,
          coverAssetIds: [nested],
          startDate: day('2026-03-09'),
          endDate: day('2026-03-09'),
        },
      ]);
    });

    it('covers and dates a folder from the same files it counts: nothing trashed, archived, Locked, hidden or of another owner', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const { user: other } = await ctx.newUser();
      const [hiddenTag] = await upsertTags(ctx.get(TagRepository), { userId: user.id, tags: ['private'] });
      const inFolder = { ownerId: user.id, originalPath: '/library/mixed/file.jpg' };

      const { asset: visible } = await ctx.newAsset({ ...inFolder, ...capturedAt('2024-06-01T10:00:00.000Z') });
      // every file that does not count is newer or older than the one that does, so it would lead the
      // cover or move a date if it were read
      await ctx.newAsset({ ...inFolder, deletedAt: new Date(), ...capturedAt('2030-01-01T00:00:00.000Z') });
      await ctx.newAsset({
        ...inFolder,
        visibility: AssetVisibility.Archive,
        ...capturedAt('2000-01-01T00:00:00.000Z'),
      });
      await ctx.newAsset({ ...inFolder, ownerId: other.id, ...capturedAt('2029-01-01T00:00:00.000Z') });
      const { asset: locked } = await ctx.newAsset({
        ...inFolder,
        visibility: AssetVisibility.Locked,
        ...capturedAt('2028-01-01T00:00:00.000Z'),
      });
      const { asset: hidden } = await ctx.newAsset({ ...inFolder, ...capturedAt('2027-01-01T00:00:00.000Z') });
      await ctx.newTagAsset({ tagIds: [hiddenTag.id], assetIds: [hidden.id] });
      // a folder with nothing to list is not a row at all
      await ctx.newAsset({
        ownerId: user.id,
        originalPath: '/library/trashed/file.jpg',
        deletedAt: new Date(),
      });

      const hiddenContent = {
        userId: user.id,
        includeNsfw: true,
        tagIds: [hiddenTag.id],
        personIds: [],
        petIds: [],
        scope: 'owned' as const,
      };
      await expect(sut.getFolderSummary(user.id, { hiddenContent })).resolves.toEqual([
        {
          path: '/library/mixed',
          count: 1,
          size: 0,
          coverAssetIds: [visible.id],
          startDate: day('2024-06-01'),
          endDate: day('2024-06-01'),
        },
      ]);

      // FL-195: an unlocked session lists the owner's own locks, and nothing is hidden from it
      await expect(sut.getFolderSummary(user.id, { revealLockedOwnerId: user.id })).resolves.toEqual([
        {
          path: '/library/mixed',
          count: 3,
          size: 0,
          coverAssetIds: [locked.id, hidden.id, visible.id],
          startDate: day('2024-06-01'),
          endDate: day('2028-01-01'),
        },
      ]);
    });

    it('dates a folder by the local capture day, exactly as an album of the same files is dated', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      // late evening where it was taken, already the next day in UTC
      const { asset: first } = await ctx.newAsset({
        ownerId: user.id,
        originalPath: '/library/evenings/a.jpg',
        localDateTime: new Date('2024-06-01T23:30:00.000Z'),
        fileCreatedAt: new Date('2024-06-02T06:30:00.000Z'),
      });
      const { asset: last } = await ctx.newAsset({
        ownerId: user.id,
        originalPath: '/library/evenings/b.jpg',
        localDateTime: new Date('2024-12-31T23:59:00.000Z'),
        fileCreatedAt: new Date('2025-01-01T04:59:00.000Z'),
      });
      const { album } = await ctx.newAlbum({ ownerId: user.id }, [first.id, last.id]);

      const [summary] = await sut.getFolderSummary(user.id);
      expect(summary).toMatchObject({
        path: '/library/evenings',
        coverAssetIds: [last.id, first.id],
        startDate: day('2024-06-01'),
        endDate: day('2024-12-31'),
      });

      const [metadata] = await ctx.get(AlbumRepository).getMetadataForIds([album.id]);
      expect(summary.startDate).toEqual(metadata.startDate);
      expect(summary.endDate).toEqual(metadata.endDate);
    });
  });
});
