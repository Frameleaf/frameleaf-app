import { Kysely } from 'kysely';
import { randomUUID } from 'node:crypto';
import { AuthDto } from 'src/dtos/auth.dto.js';
import { MetadataSearchDto } from 'src/dtos/search.dto.js';
import {
  AlbumUserRole,
  AssetFileType,
  ClassificationMatchDecision,
  ClassificationMediaType,
  ClassificationRuleAction,
  LibraryScope,
} from 'src/enum.js';
import { AssetPaletteRepository } from 'src/repositories/asset-palette.repository.js';
import { ClassificationRepository } from 'src/repositories/classification.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { SearchRepository } from 'src/repositories/search.repository.js';
import { TagRepository } from 'src/repositories/tag.repository.js';
import { TrashRepository } from 'src/repositories/trash.repository.js';
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import { rgbToOklab } from 'src/utils/asset-palette.js';
import { TrashReviewAction } from 'src/utils/trash-review.js';
import { newMediumService } from 'test/medium.factory.js';
import { getActiveForkKyselyDB } from 'test/utils.js';

let db: Kysely<DB>;
beforeAll(async () => {
  db = await getActiveForkKyselyDB();
});
afterAll(async () => {
  await db?.destroy();
});
const setup = () => newMediumService(BaseService, { database: db, real: [], mock: [LoggingRepository] }).ctx;
const palette = async (id: string, hex: string, transparent = false) => {
  const repo = new AssetPaletteRepository(db);
  const source = await repo.source(id);
  if (!source) throw new Error('Missing palette source');
  const rgb = [1, 3, 5].map((index) => Number.parseInt(hex.slice(index, index + 2), 16) / 255);
  await repo.publish(id, source.sourceRevision, {
    version: 1,
    sourceRevision: source.sourceRevision,
    status: 'ready',
    hasTransparency: transparent,
    representative: 'image',
    swatches: [{ hex, weight: 1, oklab: rgbToOklab(rgb[0], rgb[1], rgb[2]) }],
  });
};
const scope = (id: string, sharedLink = false) => ({ userIds: [id], lockedOwnerId: id, viewingUserId: id, sharedLink });

describe('shared color and subtree search', () => {
  it('ANDs color, text, tag, design scope and subtree before pagination and counts', async () => {
    const ctx = setup();
    const { user } = await ctx.newUser();
    const { album: root } = await ctx.newAlbum({ ownerId: user.id, libraryScope: LibraryScope.Design });
    const { album: child } = await ctx.newAlbum({
      ownerId: user.id,
      libraryScope: LibraryScope.Design,
      parentId: root.id,
    });
    const tag = await new TagRepository(db, LoggingRepository.create()).create({ userId: user.id, value: 'Packaging' });
    const wanted: string[] = [];
    for (const [index, color, libraryScope, name] of [
      [0, '#609060', LibraryScope.Design, 'packaging-a.png'],
      [1, '#609060', LibraryScope.Both, 'packaging-b.png'],
      [2, '#ff0000', LibraryScope.Design, 'packaging-red.png'],
      [3, '#609060', LibraryScope.Personal, 'packaging-personal.png'],
      [4, '#609060', LibraryScope.Design, 'unrelated.png'],
    ] as const) {
      const { asset } = await ctx.newAsset({ ownerId: user.id, libraryScope, originalFileName: name });
      await ctx.newAlbumAsset({ albumId: index === 1 ? child.id : root.id, assetId: asset.id });
      await db.insertInto('tag_asset').values({ assetId: asset.id, tagId: tag.id }).execute();
      await palette(asset.id, color, true);
      if (index < 2) wanted.push(asset.id);
    }
    const filter = MetadataSearchDto.schema.parse({
      filter: {
        libraryScope: 'design',
        color: { hex: '#609060' },
        hasTransparency: { eq: true },
        originalFileName: { like: 'packaging' },
        tagIds: { any: [tag.id] },
        albumSubtreeIds: { any: [root.id] },
      },
    }).filter!;
    const repo = new SearchRepository(db);
    const page = await repo.searchMetadataV3({ take: 100 }, { filter }, scope(user.id));
    expect(page.items.map(({ id }) => id).sort()).toEqual(wanted.sort());
    expect((await repo.searchStatisticsV3({ filter }, scope(user.id))).total).toBe(2);
  });
  it('uses the same combined predicates for existing smart rules without materializing private working colors', async () => {
    const ctx = setup();
    const { user } = await ctx.newUser();
    const wanted = await ctx.newAsset({
      ownerId: user.id,
      libraryScope: LibraryScope.Design,
      originalFileName: 'packaging.png',
    });
    const working = await ctx.newAsset({
      ownerId: user.id,
      libraryScope: LibraryScope.Design,
      originalFileName: 'packaging-private.png',
    });
    await ctx.newAsset({ ownerId: user.id, originalFileName: 'packaging-personal.png' });
    await palette(wanted.asset.id, '#609060');
    await palette(working.asset.id, '#609060');
    await db.updateTable('asset_palette').set({ ownerOnly: true }).where('assetId', '=', working.asset.id).execute();
    const criteria = {
      ownerId: user.id,
      personIds: [],
      tagIds: [],
      takenAfter: null,
      takenBefore: null,
      mediaType: ClassificationMediaType.Any,
      visualQueries: [],
      threshold: 0.25,
      filter: MetadataSearchDto.schema.parse({
        filter: { libraryScope: 'design', color: { hex: '#609060' }, originalFileName: { like: 'packaging' } },
      }).filter!,
    };
    const repo = new ClassificationRepository(db);
    expect((await repo.findMatches(criteria, [])).map(({ assetId }) => assetId)).toEqual([wanted.asset.id]);
    expect(await repo.countMatches(criteria, [])).toBe(1);
    const alternate = {
      ...criteria,
      filter: MetadataSearchDto.schema.parse({
        filter: {
          libraryScope: 'design',
          or: [{ color: { hex: '#ff0000' } }, { originalFileName: { like: 'private' } }],
        },
      }).filter!,
    };
    expect((await repo.findMatches(alternate, [])).map(({ assetId }) => assetId)).toEqual([working.asset.id]);
  });
  it('persists, updates and applies shared query rules to design assets through the existing review flow', async () => {
    const ctx = setup();
    const { user } = await ctx.newUser();
    const { asset } = await ctx.newAsset({ ownerId: user.id, libraryScope: LibraryScope.Design });
    await palette(asset.id, '#609060');
    const { album } = await ctx.newAlbum({ ownerId: user.id, libraryScope: LibraryScope.Design });
    const repo = new ClassificationRepository(db);
    const filter = MetadataSearchDto.schema.parse({
      filter: { libraryScope: 'design', color: { hex: '#609060' } },
    }).filter!;
    const rule = await repo.createRule({
      ownerId: user.id,
      albumId: album.id,
      action: ClassificationRuleAction.Review,
      filter,
    });
    expect((await repo.getRule(rule.id))?.filter).toEqual(filter);
    const matches = await repo.findMatches(rule, []);
    expect(matches.map(({ assetId }) => assetId)).toEqual([asset.id]);
    expect(
      await repo.apply(rule, [asset.id], new Map(matches.map(({ assetId, score }) => [assetId, score]))),
    ).toMatchObject({ suggested: 1, missing: [] });
    expect(
      (
        await repo.getMatchPage(rule.id, user.id, {
          decision: ClassificationMatchDecision.Suggested,
          offset: 0,
          limit: 100,
        })
      ).total,
    ).toBe(1);
    await repo.updateRule(rule.id, { filter: { ...filter, color: { ...filter.color!, hex: '#ff0000' } } });
    const updated = await repo.getRule(rule.id);
    if (!updated) throw new Error('Missing rule');
    expect(await repo.findMatches(updated, [])).toEqual([]);
    expect(await repo.getUndoableAssetIds(updated)).toEqual([asset.id]);
    expect(await repo.apply(updated, [asset.id], new Map())).toMatchObject({ removed: 1 });
  });
  it('combines source dimensions, aspect ratio and millisecond duration without inventing missing metadata', async () => {
    const ctx = setup();
    const { user } = await ctx.newUser();
    const wanted = await ctx.newAsset({ ownerId: user.id, duration: 10_000 });
    const square = await ctx.newAsset({ ownerId: user.id, duration: 10_000 });
    const missing = await ctx.newAsset({ ownerId: user.id });
    await ctx.newExif({ assetId: wanted.asset.id, exifImageWidth: 1920, exifImageHeight: 1080 });
    await ctx.newExif({ assetId: square.asset.id, exifImageWidth: 1920, exifImageHeight: 1920 });
    const filter = MetadataSearchDto.schema.parse({
      filter: {
        width: { gte: 1920 },
        height: { gte: 1080 },
        aspectRatio: { gte: 1.7, lte: 1.8 },
        durationMs: { lte: 30_000 },
      },
    }).filter!;
    const repo = new SearchRepository(db);
    expect((await repo.searchMetadataV3({ take: 100 }, { filter }, scope(user.id))).items.map(({ id }) => id)).toEqual([
      wanted.asset.id,
    ]);
    const absent = { id: { eq: missing.asset.id }, aspectRatio: { eq: null }, durationMs: { eq: null } };
    expect((await repo.searchStatisticsV3({ filter: absent }, scope(user.id))).total).toBe(1);
  });
  it('does not match a previously ready palette after its asset is trashed or goes offline', async () => {
    const ctx = setup();
    const { user } = await ctx.newUser();
    const { asset } = await ctx.newAsset({ ownerId: user.id });
    await palette(asset.id, '#609060');
    const filter = MetadataSearchDto.schema.parse({
      filter: { id: { eq: asset.id }, color: { hex: '#609060' } },
    }).filter!;
    const repo = new SearchRepository(db);
    await db.updateTable('asset').set({ deletedAt: new Date() }).where('id', '=', asset.id).execute();
    const trashed = await repo.searchStatisticsV3({ filter }, scope(user.id));
    await db.updateTable('asset').set({ deletedAt: null, isOffline: true }).where('id', '=', asset.id).execute();
    const offline = await repo.searchStatisticsV3({ filter }, scope(user.id));
    expect([trashed.total, offline.total]).toEqual([0, 0]);
  });
  it('returns a trashed Design item to its scope, source and color match when it is restored', async () => {
    const ctx = setup();
    const { user } = await ctx.newUser();
    const { session } = await ctx.newSession({ userId: user.id });
    const auth = { user, session: { ...session, hasElevatedPermission: false } } as AuthDto;
    const { asset } = await ctx.newAsset({ ownerId: user.id, libraryScope: LibraryScope.Design });
    await db
      .insertInto('asset_source')
      .values({
        assetId: asset.id,
        captureId: randomUUID(),
        pageUrl: 'https://example.org/lodge',
        title: 'Lodge',
        capturedAt: new Date(),
        note: 'restored-reference',
      })
      .execute();
    await palette(asset.id, '#609060');
    const filter = (extra: object) =>
      MetadataSearchDto.schema.parse({
        // Callers exclude Trash themselves, as the Pro library search does.
        filter: { id: { eq: asset.id }, libraryScope: LibraryScope.Design, trashedAt: { eq: null }, ...extra },
      }).filter!;
    const search = new SearchRepository(db);
    const totals = () =>
      Promise.all(
        [{ color: { hex: '#609060' } }, { source: { contains: 'restored-reference' } }].map(async (extra) => {
          const { total } = await search.searchStatisticsV3({ filter: filter(extra) }, scope(user.id));
          return total;
        }),
      );
    const trash = new TrashRepository(db);
    expect(await trash.applyReviewed(user.id, TrashReviewAction.Trash, [asset.id], {}, () => true, auth)).toEqual([
      asset.id,
    ]);
    const trashed = await totals();
    expect(await trash.restoreAll([asset.id], auth)).toEqual([asset.id]);
    const restored = await db
      .selectFrom('asset')
      .select(['libraryScope', 'deletedAt'])
      .where('id', '=', asset.id)
      .executeTakeFirstOrThrow();
    expect({ trashed, restored: await totals(), row: restored }).toEqual({
      trashed: [0, 0],
      restored: [1, 1],
      row: { libraryScope: LibraryScope.Design, deletedAt: null },
    });
  });
  it('searches private provenance only for its owner, without exposing it through shared counts', async () => {
    const ctx = setup();
    const owner = await ctx.newUser();
    const viewer = await ctx.newUser();
    const privateItem = await ctx.newAsset({ ownerId: owner.user.id });
    await ctx.newAsset({ ownerId: owner.user.id });
    const { album } = await ctx.newAlbum({ ownerId: owner.user.id }, [privateItem.asset.id]);
    await db
      .insertInto('album_user')
      .values({ albumId: album.id, userId: viewer.user.id, role: AlbumUserRole.Viewer })
      .execute();
    await db
      .insertInto('asset_source')
      .values({
        assetId: privateItem.asset.id,
        captureId: randomUUID(),
        pageUrl: 'https://example.org/reference',
        title: 'Reference',
        capturedAt: new Date(),
        note: 'private-project',
      })
      .execute();
    const filter = MetadataSearchDto.schema.parse({ filter: { source: { contains: 'private-project' } } }).filter!;
    const sharedFilter = { ...filter, albumIds: { any: [album.id] } };
    const repo = new SearchRepository(db);
    const counts = await Promise.all([
      repo.searchStatisticsV3({ filter }, scope(owner.user.id)),
      repo.searchStatisticsV3({ filter: sharedFilter }, scope(viewer.user.id)),
      repo.searchStatisticsV3({ filter: sharedFilter }, scope(owner.user.id, true)),
    ]);
    expect(counts.map(({ total }) => total)).toEqual([1, 0, 0]);
  });
  it('does not inherit access to private descendants from a shared parent', async () => {
    const ctx = setup();
    const owner = await ctx.newUser();
    const viewer = await ctx.newUser();
    const { album: root } = await ctx.newAlbum({ ownerId: owner.user.id });
    const { album: child } = await ctx.newAlbum({ ownerId: owner.user.id, parentId: root.id });
    await db
      .insertInto('album_user')
      .values({ albumId: root.id, userId: viewer.user.id, role: AlbumUserRole.Viewer })
      .execute();
    const visible = await ctx.newAsset({ ownerId: owner.user.id });
    const hidden = await ctx.newAsset({ ownerId: owner.user.id });
    await ctx.newAlbumAsset({ albumId: root.id, assetId: visible.asset.id });
    await ctx.newAlbumAsset({ albumId: child.id, assetId: hidden.asset.id });
    await palette(visible.asset.id, '#609060');
    await palette(hidden.asset.id, '#609060');
    const filter = MetadataSearchDto.schema.parse({
      filter: { color: { hex: '#609060' }, albumSubtreeIds: { any: [root.id] } },
    }).filter!;
    const repo = new SearchRepository(db);
    expect(
      (await repo.searchMetadataV3({ take: 100 }, { filter }, scope(viewer.user.id))).items.map(({ id }) => id),
    ).toEqual([visible.asset.id]);
  });
  it('excludes stale palettes and owner-private working colors from shared color matches', async () => {
    const ctx = setup();
    const owner = await ctx.newUser();
    const viewer = await ctx.newUser();
    const item = await ctx.newAsset({ ownerId: owner.user.id });
    const { album } = await ctx.newAlbum({ ownerId: owner.user.id }, [item.asset.id]);
    await db
      .insertInto('album_user')
      .values({ albumId: album.id, userId: viewer.user.id, role: AlbumUserRole.Viewer })
      .execute();
    await palette(item.asset.id, '#609060');
    await db.updateTable('asset_palette').set({ ownerOnly: true }).where('assetId', '=', item.asset.id).execute();
    const filter = MetadataSearchDto.schema.parse({
      filter: { color: { hex: '#609060' }, albumIds: { any: [album.id] } },
    }).filter!;
    const repo = new SearchRepository(db);
    expect((await repo.searchStatisticsV3({ filter }, scope(viewer.user.id))).total).toBe(0);
    expect((await repo.searchStatisticsV3({ filter }, scope(owner.user.id, true))).total).toBe(0);
    expect((await repo.searchStatisticsV3({ filter }, scope(owner.user.id))).total).toBe(1);
    await ctx.newAssetFile({
      assetId: item.asset.id,
      type: AssetFileType.Preview,
      path: '/synthetic/replaced.png',
      isEdited: false,
    });
    expect((await repo.searchStatisticsV3({ filter }, scope(owner.user.id))).total).toBe(0);
  });
});
