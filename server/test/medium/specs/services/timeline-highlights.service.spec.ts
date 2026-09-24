import { Kysely } from 'kysely';
import { AssetMetadataKey, AssetOrder, AssetVisibility, SharedLinkType, TimeBucketDateType } from 'src/enum.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { BestPhotosRepository } from 'src/repositories/best-photos.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { PartnerRepository } from 'src/repositories/partner.repository.js';
import { SharedLinkRepository } from 'src/repositories/shared-link.repository.js';
import { DB } from 'src/schema/index.js';
import { TimelineService } from 'src/services/timeline.service.js';
import { MediumTestContext, newMediumService } from 'test/medium.factory.js';
import { factory } from 'test/small.factory.js';
import { getActiveForkKyselyDB, getKyselyDB } from 'test/utils.js';

let defaultDatabase: Kysely<DB>;

const setup = (db?: Kysely<DB>) => {
  return newMediumService(TimelineService, {
    database: db || defaultDatabase,
    real: [AssetRepository, AccessRepository, PartnerRepository, SharedLinkRepository],
    mock: [LoggingRepository],
  });
};

const nsfw = {
  nsfwDetection: { status: 'success', result: { isNsfw: true, score: 0.95, labels: { explicit: 0.95 } } },
};

type Ctx = MediumTestContext<typeof TimelineService>;

const newPhoto = async (
  ctx: Ctx,
  ownerId: string,
  localDateTime: string,
  extra: { score?: number; rating?: number; city?: string; country?: string; visibility?: AssetVisibility } = {},
) => {
  const { asset } = await ctx.newAsset({
    ownerId,
    localDateTime: new Date(localDateTime),
    fileCreatedAt: new Date(localDateTime),
    ...(extra.visibility && { visibility: extra.visibility }),
  });
  await ctx.newExif({
    assetId: asset.id,
    make: 'Canon',
    rating: extra.rating,
    city: extra.city,
    country: extra.country,
  });
  if (extra.score !== undefined) {
    await new BestPhotosRepository(ctx.database).upsertScore({
      assetId: asset.id,
      ownerId,
      score: extra.score,
      aestheticScore: null,
      technicalScore: null,
      subjectScore: null,
      diversityScore: null,
      scoreVersion: 1,
      computedAt: new Date(),
      metadata: null,
      bestFrameTimestampMs: null,
      frameScore: null,
      frameMetadata: null,
    });
  }
  return asset;
};

beforeAll(async () => {
  defaultDatabase = await getKyselyDB();
});

describe('TimelineService.getTimelineHighlights (FL-33)', () => {
  it('picks the key photo by Best Photos score, then rating, then recency and reconciles to the buckets', async () => {
    const { sut, ctx } = setup();
    const { user } = await ctx.newUser();
    const auth = factory.auth({ user });

    // March: the scored photo wins over a better-rated, more recent one
    const scored = await newPhoto(ctx, user.id, '2024-03-02T10:00:00Z', { score: 0.95, city: 'Banff' });
    const rated = await newPhoto(ctx, user.id, '2024-03-20T10:00:00Z', { rating: 5, city: 'Banff' });
    const plainLate = await newPhoto(ctx, user.id, '2024-03-25T10:00:00Z', { city: 'Jasper' });
    const plainEarly = await newPhoto(ctx, user.id, '2024-03-01T10:00:00Z', { country: 'Canada' });
    // February: no scores, so the highest rating wins; a tie on rating goes to the most recent
    const febOld = await newPhoto(ctx, user.id, '2024-02-01T10:00:00Z', { rating: 4 });
    const febNew = await newPhoto(ctx, user.id, '2024-02-10T10:00:00Z', { rating: 4 });
    // January: nothing to rank by but capture time
    const janNew = await newPhoto(ctx, user.id, '2024-01-20T10:00:00Z');
    await newPhoto(ctx, user.id, '2024-01-10T10:00:00Z');

    const months = await sut.getTimelineHighlights(auth, { grouping: 'month', highlightCount: 2 });
    expect(months).toEqual([
      {
        timeBucket: '2024-03-01',
        count: 4,
        keyAssetId: scored.id,
        // the next two best (rated, then the most recent unrated), in capture order (newest first)
        highlightAssetIds: [plainLate.id, rated.id],
        places: ['Banff', 'Canada', 'Jasper'],
      },
      { timeBucket: '2024-02-01', count: 2, keyAssetId: febNew.id, highlightAssetIds: [febOld.id], places: [] },
      {
        timeBucket: '2024-01-01',
        count: 2,
        keyAssetId: janNew.id,
        highlightAssetIds: [expect.any(String)],
        places: [],
      },
    ]);
    expect(months[0].highlightAssetIds).not.toContain(plainEarly.id);

    const buckets = await sut.getTimeBuckets(auth, {});
    expect(months.map(({ timeBucket, count }) => ({ timeBucket, count }))).toEqual(buckets);

    const years = await sut.getTimelineHighlights(auth, { grouping: 'year' });
    expect(years).toEqual([
      {
        timeBucket: '2024-01-01',
        count: 8,
        keyAssetId: scored.id,
        highlightAssetIds: [],
        places: ['Banff', 'Canada', 'Jasper'],
      },
    ]);

    const ascending = await sut.getTimelineHighlights(auth, { grouping: 'month', order: AssetOrder.Asc });
    expect(ascending.map(({ timeBucket }) => timeBucket)).toEqual(['2024-01-01', '2024-02-01', '2024-03-01']);
  });

  it('never counts or picks Locked media outside an elevated session', async () => {
    const { sut, ctx } = setup();
    const { user } = await ctx.newUser();
    const visible = await newPhoto(ctx, user.id, '2024-05-01T10:00:00Z', { score: 0.2 });
    const locked = await newPhoto(ctx, user.id, '2024-05-02T10:00:00Z', {
      score: 0.99,
      city: 'Secret',
      visibility: AssetVisibility.Locked,
    });

    const [card] = await sut.getTimelineHighlights(factory.auth({ user }), { grouping: 'month' });
    expect(card).toEqual({
      timeBucket: '2024-05-01',
      count: 1,
      keyAssetId: visible.id,
      highlightAssetIds: [],
      places: [],
    });
    expect(JSON.stringify(card)).not.toContain(locked.id);

    // an explicit Locked request needs an elevated session, exactly as the buckets do
    await expect(
      sut.getTimelineHighlights(factory.auth({ user }), { grouping: 'month', visibility: AssetVisibility.Locked }),
    ).rejects.toThrow();
    const elevated = factory.auth({ user, session: { hasElevatedPermission: true } });
    const [lockedCard] = await sut.getTimelineHighlights(elevated, {
      grouping: 'month',
      visibility: AssetVisibility.Locked,
    });
    expect(lockedCard).toEqual(expect.objectContaining({ count: 1, keyAssetId: locked.id }));
  });

  it('leaves out hidden content and matches the buckets for the same session', async () => {
    const { sut, ctx } = setup();
    const { user } = await ctx.newUser();
    const visible = await newPhoto(ctx, user.id, '2024-06-01T10:00:00Z', { score: 0.1 });
    const hidden = await newPhoto(ctx, user.id, '2024-06-02T10:00:00Z', { score: 0.99, city: 'Hidden' });
    await ctx.newMetadata({ assetId: hidden.id, key: AssetMetadataKey.MlEnrichment, value: nsfw });

    const auth = { ...factory.auth({ user }), hideNsfwAssets: true };
    const [card] = await sut.getTimelineHighlights(auth, { grouping: 'month' });
    expect(card).toEqual(expect.objectContaining({ count: 1, keyAssetId: visible.id, places: [] }));
    await expect(sut.getTimeBuckets(auth, {})).resolves.toEqual([{ timeBucket: '2024-06-01', count: 1 }]);
  });

  it("includes partners' shared media but never their Locked media or their hidden locations", async () => {
    const { sut, ctx } = setup();
    const { user } = await ctx.newUser();
    const { user: partner } = await ctx.newUser();
    await ctx.get(PartnerRepository).create({
      sharedById: partner.id,
      sharedWithId: user.id,
      inTimeline: true,
      shareLocation: false,
    });

    const own = await newPhoto(ctx, user.id, '2024-07-01T10:00:00Z', { city: 'Lisbon' });
    const shared = await newPhoto(ctx, partner.id, '2024-07-02T10:00:00Z', { score: 0.5, city: 'PartnerHome' });
    const partnerLocked = await newPhoto(ctx, partner.id, '2024-07-03T10:00:00Z', {
      score: 0.99,
      visibility: AssetVisibility.Locked,
    });

    const elevated = factory.auth({ user, session: { hasElevatedPermission: true } });
    const dto = { userId: user.id, withPartners: true, visibility: AssetVisibility.Timeline };
    const [card] = await sut.getTimelineHighlights(elevated, { ...dto, grouping: 'month', highlightCount: 4 });
    expect(card).toEqual({
      timeBucket: '2024-07-01',
      count: 2,
      keyAssetId: shared.id,
      highlightAssetIds: [own.id],
      places: ['Lisbon'],
    });
    expect(JSON.stringify(card)).not.toContain(partnerLocked.id);
    await expect(sut.getTimeBuckets(elevated, dto)).resolves.toEqual([{ timeBucket: '2024-07-01', count: 2 }]);
  });

  it('names no places for a shared link that hides EXIF', async () => {
    const { sut, ctx } = setup();
    const { user } = await ctx.newUser();
    const asset = await newPhoto(ctx, user.id, '2024-08-01T10:00:00Z', { city: 'Austin', country: 'USA' });
    const { album } = await ctx.newAlbum({ ownerId: user.id });
    await ctx.newAlbumAsset({ albumId: album.id, assetId: asset.id });
    const { id: sharedLinkId } = await ctx.get(SharedLinkRepository).create({
      allowUpload: false,
      key: Buffer.from('fl33-highlights'),
      type: SharedLinkType.Album,
      userId: user.id,
      albumId: album.id,
    });

    const auth = factory.auth({ sharedLink: { id: sharedLinkId, showExif: false } });
    const [card] = await sut.getTimelineHighlights(auth, { grouping: 'month', albumId: album.id });
    expect(card).toEqual(expect.objectContaining({ count: 1, keyAssetId: asset.id, places: [] }));

    const owner = await sut.getTimelineHighlights(factory.auth({ user }), { grouping: 'month', albumId: album.id });
    expect(owner[0].places).toEqual(['Austin']);
  });

  it('reads Best Photos scores from the fork sidecar once it is authoritative', async () => {
    const { sut, ctx } = setup(await getActiveForkKyselyDB());
    const { user } = await ctx.newUser();
    const scored = await newPhoto(ctx, user.id, '2024-09-01T10:00:00Z', { score: 0.9 });
    await newPhoto(ctx, user.id, '2024-09-20T10:00:00Z', { rating: 5 });

    const [card] = await sut.getTimelineHighlights(factory.auth({ user }), { grouping: 'month' });
    expect(card).toEqual(expect.objectContaining({ count: 2, keyAssetId: scored.id }));
  });

  it('groups, breaks ties and orders by the date added when asked', async () => {
    const { sut, ctx } = setup();
    const { user } = await ctx.newUser();
    const { asset: takenLateAddedEarly } = await ctx.newAsset({
      ownerId: user.id,
      localDateTime: new Date('2024-05-30T10:00:00Z'),
      createdAt: new Date('2024-06-01T10:00:00Z'),
    });
    const { asset: takenEarlyAddedLate } = await ctx.newAsset({
      ownerId: user.id,
      localDateTime: new Date('2024-01-01T10:00:00Z'),
      createdAt: new Date('2024-06-20T10:00:00Z'),
    });
    for (const { id } of [takenLateAddedEarly, takenEarlyAddedLate]) {
      await ctx.newExif({ assetId: id, make: 'Canon' });
    }

    const cards = await sut.getTimelineHighlights(factory.auth({ user }), {
      grouping: 'month',
      dateType: TimeBucketDateType.Added,
    });
    // one June card; with nothing else to rank by, the most recently added photo is the key
    expect(cards).toEqual([
      {
        timeBucket: '2024-06-01',
        count: 2,
        keyAssetId: takenEarlyAddedLate.id,
        highlightAssetIds: [takenLateAddedEarly.id],
        places: [],
      },
    ]);
  });
});
