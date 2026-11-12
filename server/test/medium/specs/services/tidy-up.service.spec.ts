import { Kysely } from 'kysely';
import { AlbumKind, AssetVisibility, ClassificationMatchDecision } from 'src/enum.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { AlbumUserRepository } from 'src/repositories/album-user.repository.js';
import { AlbumRepository } from 'src/repositories/album.repository.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { ClassificationRepository } from 'src/repositories/classification.repository.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { EventRepository } from 'src/repositories/event.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MachineLearningRepository } from 'src/repositories/machine-learning.repository.js';
import { PartnerRepository } from 'src/repositories/partner.repository.js';
import { PersonRepository } from 'src/repositories/person.repository.js';
import { SearchRepository } from 'src/repositories/search.repository.js';
import { SmartAlbumRepository } from 'src/repositories/smart-album.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { TagRepository } from 'src/repositories/tag.repository.js';
import { UserRepository } from 'src/repositories/user.repository.js';
import { DB } from 'src/schema/index.js';
import { AlbumService } from 'src/services/album.service.js';
import { BaseService } from 'src/services/base.service.js';
import { ClassificationService } from 'src/services/classification.service.js';
import { TidyUpService } from 'src/services/tidy-up.service.js';
import { MediumTestContext, newMediumService } from 'test/medium.factory.js';
import { factory } from 'test/small.factory.js';
import { getKyselyDB } from 'test/utils.js';

let defaultDatabase: Kysely<DB>;

const setup = () => {
  const { sut: classification, ctx } = newMediumService(ClassificationService, {
    database: defaultDatabase,
    real: [
      AccessRepository,
      AlbumRepository,
      AlbumUserRepository,
      AssetRepository,
      ClassificationRepository,
      ConfigRepository,
      PersonRepository,
      PartnerRepository,
      SearchRepository,
      SmartAlbumRepository,
      SystemMetadataRepository,
      TagRepository,
      UserRepository,
    ],
    mock: [EventRepository, LoggingRepository, MachineLearningRepository],
  });
  ctx.getMock(EventRepository).emit.mockResolvedValue();
  const sut = new TidyUpService(
    { setContext: vi.fn(), warn: vi.fn() } as never,
    ctx.get(ClassificationRepository),
    classification,
    BaseService.create(AlbumService, classification),
    { createBulk: vi.fn() } as never,
  );
  return { sut, ctx };
};

const newOwner = async (ctx: MediumTestContext) => {
  const { user } = await ctx.newUser();
  return { user, auth: factory.auth({ user: { id: user.id } }) };
};

/** A photo saved from WhatsApp: a chat-app file name and no camera details. */
const forwarded = async (ctx: MediumTestContext, ownerId: string, extra: Record<string, unknown> = {}) => {
  const { asset } = await ctx.newAsset({ ownerId, originalFileName: 'IMG-20260412-WA0007.jpg', ...extra });
  await ctx.newExif({ assetId: asset.id, make: null, model: null });
  return asset;
};

const visibilityOf = async (ctx: MediumTestContext, assetId: string) =>
  (await ctx.database.selectFrom('asset').select('visibility').where('id', '=', assetId).executeTakeFirstOrThrow())
    .visibility;

const suggested = async (sut: TidyUpService, auth: ReturnType<typeof factory.auth>) =>
  (await sut.getSuggestions(auth, { page: 1, size: 100 })).items.map(({ assetId }) => assetId);

describe(TidyUpService.name, () => {
  beforeAll(async () => {
    defaultDatabase = await getKyselyDB();
  });

  it('suggests forwarded images, but never a favourite, a starred photo, one with a face or one already archived', async () => {
    const { sut, ctx } = setup();
    const { user, auth } = await newOwner(ctx);
    const plain = await forwarded(ctx, user.id);
    await forwarded(ctx, user.id, { isFavorite: true });
    const starred = await forwarded(ctx, user.id);
    await ctx.database.updateTable('asset_exif').set({ rating: 4 }).where('assetId', '=', starred.id).execute();
    const withFace = await forwarded(ctx, user.id);
    await ctx.newAssetFace({ assetId: withFace.id });
    await forwarded(ctx, user.id, { visibility: AssetVisibility.Archive });
    const { asset: camera } = await ctx.newAsset({ ownerId: user.id, originalFileName: 'IMG-20260412-WA0008.jpg' });
    await ctx.newExif({ assetId: camera.id, make: 'Apple', model: 'iPhone 16' });

    const status = await sut.setKind(auth, 'chat', { enabled: true });

    expect(status).toMatchObject({ kind: 'chat', enabled: true, automatic: false, waiting: 1 });
    await expect(suggested(sut, auth)).resolves.toEqual([plain.id]);
    // Suggesting changes nothing.
    await expect(visibilityOf(ctx, plain.id)).resolves.toBe(AssetVisibility.Timeline);

    const collection = await ctx.database
      .selectFrom('album')
      .innerJoin('album as child', 'child.parentId', 'album.id')
      .select(['album.albumName', 'album.kind', 'child.albumName as child'])
      .where('child.id', '=', status.albumId!)
      .executeTakeFirstOrThrow();
    expect(collection).toEqual({
      albumName: 'Tidied away',
      kind: AlbumKind.Collection,
      child: 'Forwarded chat images',
    });
  });

  it('archives on request, undoes back to review, and keep puts a photo back for good', async () => {
    const { sut, ctx } = setup();
    const { user, auth } = await newOwner(ctx);
    const photo = await forwarded(ctx, user.id);
    await sut.setKind(auth, 'chat', { enabled: true });

    await sut.decide(auth, { assetIds: [photo.id], decision: 'archive' });
    await expect(visibilityOf(ctx, photo.id)).resolves.toBe(AssetVisibility.Archive);
    await expect(sut.getTidiedAway(auth, { page: 1, size: 100 })).resolves.toMatchObject({
      total: 1,
      items: [{ assetId: photo.id, kinds: ['chat'], automatic: false }],
    });
    await expect(suggested(sut, auth)).resolves.toEqual([]);

    await sut.decide(auth, { assetIds: [photo.id], decision: 'undo' });
    await expect(visibilityOf(ctx, photo.id)).resolves.toBe(AssetVisibility.Timeline);
    await expect(suggested(sut, auth)).resolves.toEqual([photo.id]);

    await sut.decide(auth, { assetIds: [photo.id], decision: 'archive' });
    await sut.decide(auth, { assetIds: [photo.id], decision: 'keep' });
    await expect(visibilityOf(ctx, photo.id)).resolves.toBe(AssetVisibility.Timeline);
    await expect(suggested(sut, auth)).resolves.toEqual([]);
    const decision = await ctx.database
      .selectFrom('classification_match')
      .select('decision')
      .where('assetId', '=', photo.id)
      .executeTakeFirstOrThrow();
    expect(decision.decision).toBe(ClassificationMatchDecision.Rejected);
  });

  it('a photo kept for one kind is not suggested by another', async () => {
    const { sut, ctx } = setup();
    const { user, auth } = await newOwner(ctx);
    const { asset } = await ctx.newAsset({ ownerId: user.id, originalFileName: 'IMG-20260412-WA0001.png' });
    await ctx.newExif({ assetId: asset.id, make: null, model: null });
    await sut.setKind(auth, 'chat', { enabled: true });
    await sut.decide(auth, { assetIds: [asset.id], decision: 'keep' });

    // A PNG without camera details is also how iPhones save screenshots.
    await sut.setKind(auth, 'screenshots', { enabled: true });
    const status = await sut.getStatus(auth);
    expect(status.kinds.find(({ kind }) => kind === 'screenshots')).toMatchObject({ enabled: true, waiting: 0 });
    await expect(suggested(sut, auth)).resolves.toEqual([]);
  });

  it('turning a kind off leaves the Archive alone and stops suggesting', async () => {
    const { sut, ctx } = setup();
    const { user, auth } = await newOwner(ctx);
    const [first, second] = [await forwarded(ctx, user.id), await forwarded(ctx, user.id)];
    await sut.setKind(auth, 'chat', { enabled: true });
    await sut.decide(auth, { assetIds: [first.id], decision: 'archive' });

    await sut.setKind(auth, 'chat', { enabled: false });

    await expect(visibilityOf(ctx, first.id)).resolves.toBe(AssetVisibility.Archive);
    await expect(visibilityOf(ctx, second.id)).resolves.toBe(AssetVisibility.Timeline);
    await expect(sut.getStatus(auth)).resolves.toMatchObject({ waiting: 0, tidiedAway: 1 });
  });

  it('only finds very low quality shots for Accidental shots', async () => {
    const { sut, ctx } = setup();
    const { user, auth } = await newOwner(ctx);
    const scored = async (technicalScore: number | null) => {
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      await ctx.newExif({ assetId: asset.id, make: 'Apple' });
      if (technicalScore !== null) {
        await ctx.database
          .insertInto('asset_best_photo_score')
          .values({
            assetId: asset.id,
            ownerId: user.id,
            score: 0.1,
            technicalScore,
            scoreVersion: 1,
            computedAt: new Date(),
          })
          .execute();
      }
      return asset;
    };
    const dark = await scored(0.05);
    await scored(0.6);
    await scored(null);

    await sut.setKind(auth, 'accidental', { enabled: true });

    await expect(suggested(sut, auth)).resolves.toEqual([dark.id]);
  });
});
