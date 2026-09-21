import { Kysely } from 'kysely';
import { AssetImageEnrichmentAction } from 'src/dtos/asset.dto.js';
import { AssetVisibility } from 'src/enum.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { DatabaseRepository } from 'src/repositories/database.repository.js';
import { ForkPrivacyRepository } from 'src/repositories/fork-privacy.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { PartnerRepository } from 'src/repositories/partner.repository.js';
import { PersonRepository } from 'src/repositories/person.repository.js';
import { TagRepository } from 'src/repositories/tag.repository.js';
import { DB } from 'src/schema/index.js';
import { ImageEnrichmentService } from 'src/services/image-enrichment.service.js';
import { TimelineService } from 'src/services/timeline.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { factory } from 'test/small.factory.js';
import { getActiveForkKyselyDB, getKyselyDB } from 'test/utils.js';

let database: Kysely<DB>;
beforeAll(async () => {
  database = await getActiveForkKyselyDB();
});
afterAll(async () => database?.destroy());

const setup = async () => {
  const { sut, ctx } = newMediumService(TimelineService, {
    database,
    real: [AssetRepository, AccessRepository, PartnerRepository, TagRepository, PersonRepository],
    mock: [LoggingRepository],
  });
  const { sut: enrichment } = newMediumService(ImageEnrichmentService, {
    database,
    real: [AssetRepository, AccessRepository, DatabaseRepository, ConfigRepository],
    mock: [LoggingRepository],
  });
  Object.assign(enrichment, { db: database });
  const { user } = await ctx.newUser();
  const auth = factory.auth({ user, session: { hasElevatedPermission: true } });
  const asset = async (visibility = AssetVisibility.Timeline, ownerId = user.id) => {
    const { asset } = await ctx.newAsset({
      ownerId,
      visibility,
      localDateTime: new Date('2024-01-20'),
      fileCreatedAt: new Date('2024-01-20'),
    });
    await ctx.newExif({ assetId: asset.id, make: 'Synthetic' });
    return asset;
  };
  const mark = (id: string, action = AssetImageEnrichmentAction.MarkNsfw) =>
    enrichment.updateAssetEnrichment(auth, id, { action });
  const ids = async (options = {}) =>
    JSON.parse(await sut.getTimeBucket(auth, { sensitiveOnly: true, timeBucket: '2024-01-01', ...options })).id;
  return { sut, ctx, user, auth, asset, mark, ids };
};

it('returns sensitive timeline/archive assets, preserves organization and keeps legacy Locked separate', async () => {
  const { sut, ctx, user, auth, asset, mark, ids } = await setup();
  const marked = await asset();
  const archived = await asset(AssetVisibility.Archive);
  const legacy = await asset(AssetVisibility.Locked);
  await asset();
  const { album } = await ctx.newAlbum({ ownerId: user.id });
  await ctx.newAlbumAsset({ albumId: album.id, assetId: marked.id });
  await mark(marked.id);
  await mark(archived.id);
  await mark(legacy.id);
  expect(await ids()).toEqual(expect.arrayContaining([marked.id, archived.id]));
  expect(await ids()).toHaveLength(2);
  await expect(sut.getTimeBuckets(auth, { sensitiveOnly: true })).resolves.toEqual([
    { count: 2, timeBucket: '2024-01-01' },
  ]);
  expect(
    JSON.parse(await sut.getTimeBucket(auth, { visibility: AssetVisibility.Locked, timeBucket: '2024-01-01' })).id,
  ).toEqual([legacy.id]);
  await mark(marked.id, AssetImageEnrichmentAction.MarkSafe);
  expect(await ids()).toEqual([archived.id]);
  await expect(
    database.selectFrom('album_asset').select('albumId').where('assetId', '=', marked.id).execute(),
  ).resolves.toEqual([{ albumId: album.id }]);
  await expect(
    database.selectFrom('asset').select(['visibility', 'originalPath']).where('id', '=', marked.id).executeTakeFirst(),
  ).resolves.toEqual({ visibility: AssetVisibility.Timeline, originalPath: marked.originalPath });
});

it('does not interpret tag-only suppression as sensitive, even when suppression preferences are active', async () => {
  const { sut, ctx, user, auth, asset, mark } = await setup();
  const sensitive = await asset();
  const tagged = await asset();
  await mark(sensitive.id);
  const { tag } = await ctx.newTag({ userId: user.id, value: 'private-rule' });
  await ctx.newTagAsset({ tagIds: [tag.id], assetIds: [tagged.id] });
  const scoped = {
    ...auth,
    suppressedContent: { userId: user.id, includeNsfw: true, tagIds: [tag.id], personIds: [], scope: 'owned' as const },
  };
  await expect(sut.getTimeBuckets(scoped, { sensitiveOnly: true })).resolves.toEqual([
    { count: 1, timeBucket: '2024-01-01' },
  ]);
  await expect(sut.getTimeBuckets(scoped, { suppressedOnly: true })).resolves.toEqual([
    { count: 2, timeBucket: '2024-01-01' },
  ]);
});

it('rejects unelevated, shared-link, partner and cross-owner requests for counts and rows', async () => {
  const { sut, auth } = await setup();
  for (const badAuth of [
    factory.auth({ user: auth.user }),
    factory.auth({ user: auth.user, sharedLink: {}, session: { hasElevatedPermission: true } }),
  ]) {
    await expect(sut.getTimeBuckets(badAuth, { sensitiveOnly: true })).rejects.toThrow();
    await expect(sut.getTimeBucket(badAuth, { sensitiveOnly: true, timeBucket: '2024-01-01' })).rejects.toThrow();
  }
  for (const options of [{ userId: factory.uuid() }, { withPartners: true }, { suppressedOnly: true }]) {
    await expect(
      sut.getTimeBuckets({ ...auth, user: { ...auth.user, isAdmin: true } }, { sensitiveOnly: true, ...options }),
    ).rejects.toThrow();
    await expect(
      sut.getTimeBucket(auth, { sensitiveOnly: true, timeBucket: '2024-01-01', ...options }),
    ).rejects.toThrow();
  }
});

it('keeps missing privacy rows quarantined in the owner view and excludes another owner in a shared album', async () => {
  const { sut, ctx, user, auth, asset, ids } = await setup();
  const own = await asset();
  await new ForkPrivacyRepository(database).delete([own.id]);
  const { user: other } = await ctx.newUser();
  const foreign = await asset(AssetVisibility.Timeline, other.id);
  await new ForkPrivacyRepository(database).delete([foreign.id]);
  const { album } = await ctx.newAlbum({ ownerId: user.id });
  await ctx.newAlbumAsset({ albumId: album.id, assetId: own.id });
  await ctx.newAlbumAsset({ albumId: album.id, assetId: foreign.id });
  const { person } = await ctx.newPerson({ ownerId: user.id });
  await ctx.newAssetFace({ assetId: own.id, personGroupId: person.personGroupId });
  await ctx.newAssetFace({ assetId: foreign.id, personGroupId: person.personGroupId });
  expect(await ids({ personId: person.personGroupId })).toEqual([own.id]);
  await expect(sut.getTimeBuckets(auth, { sensitiveOnly: true, personId: person.personGroupId })).resolves.toEqual([
    { count: 1, timeBucket: '2024-01-01' },
  ]);
  expect(await ids({ albumId: album.id })).toEqual([own.id]);
  await expect(sut.getTimeBuckets(auth, { sensitiveOnly: true, albumId: album.id })).resolves.toEqual([
    { count: 1, timeBucket: '2024-01-01' },
  ]);
});

it('uses the legacy classification authority before active-sidecar cutover', async () => {
  const legacyDatabase = await getKyselyDB();
  try {
    const { sut, ctx } = newMediumService(TimelineService, {
      database: legacyDatabase,
      real: [AssetRepository, AccessRepository, PartnerRepository],
      mock: [LoggingRepository],
    });
    const { user } = await ctx.newUser();
    const auth = factory.auth({ user, session: { hasElevatedPermission: true } });
    const { asset } = await ctx.newAsset({ ownerId: user.id, localDateTime: new Date('2024-01-20'), is_nsfw: true });
    await ctx.newExif({ assetId: asset.id, make: 'Synthetic' });
    await ctx.newAsset({ ownerId: user.id, localDateTime: new Date('2024-01-20'), is_nsfw: false });
    await expect(sut.getTimeBuckets(auth, { sensitiveOnly: true })).resolves.toEqual([
      { count: 1, timeBucket: '2024-01-01' },
    ]);
    expect(JSON.parse(await sut.getTimeBucket(auth, { sensitiveOnly: true, timeBucket: '2024-01-01' })).id).toEqual([
      asset.id,
    ]);
  } finally {
    await legacyDatabase.destroy();
  }
});
