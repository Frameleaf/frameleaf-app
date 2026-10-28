import { Kysely, sql } from 'kysely';
import type { LibraryCursor } from 'src/utils/library-search-cursor.js';
import { LibraryItemSearchDto } from 'src/dtos/library-search.dto.js';
import { AlbumUserRole, AssetLockReason, AssetType, LibraryScope } from 'src/enum.js';
import { AssetPaletteRepository } from 'src/repositories/asset-palette.repository.js';
import { BookmarkRepository } from 'src/repositories/bookmark.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import { rgbToOklab } from 'src/utils/asset-palette.js';
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
const scope = (id: string) => ({ userIds: [id], lockedOwnerId: '', viewingUserId: id });

describe('mixed library search universe', () => {
  it('counts both kinds and pages equal timestamps without losing microsecond precision or repeating IDs', async () => {
    const ctx = setup();
    const { user } = await ctx.newUser();
    const auth = { user };
    const repo = new BookmarkRepository(db);
    const wanted: Array<{ id: string; kind: 'asset' | 'bookmark' }> = [];
    const instant = '2026-10-28T12:00:00.123456Z';
    for (let index = 0; index < 2; index++) {
      const { asset } = await ctx.newAsset({ ownerId: user.id, libraryScope: LibraryScope.Design });
      const bookmark = await repo.create(user.id, {
        url: `https://example.org/${index}`,
        title: `Reference ${index}`,
        libraryScope: LibraryScope.Design,
      });
      await db
        .updateTable('asset')
        .set({ createdAt: sql<Date>`${instant}::timestamptz` })
        .where('id', '=', asset.id)
        .execute();
      await db
        .updateTable('bookmark')
        .set({ createdAt: sql<Date>`${instant}::timestamptz` })
        .where('id', '=', bookmark.id)
        .execute();
      wanted.push({ id: asset.id, kind: 'asset' }, { id: bookmark.id, kind: 'bookmark' });
    }
    wanted.sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));
    const request = LibraryItemSearchDto.schema.parse({ filter: { libraryScope: 'design' }, limit: 1 });
    const seen: typeof wanted = [];
    let cursor: Extract<LibraryCursor, { mode: 'text' }> | undefined;
    for (let index = 0; index < 4; index++) {
      const result = await repo.searchLibrary(auth, request, scope(user.id), true, cursor);
      expect(result.count).toBe(4);
      expect(result.candidates[0].dateKey).toBe(instant);
      const row = result.candidates[0];
      seen.push({ id: row.id, kind: row.kind });
      cursor = {
        mode: 'text',
        queryHash: 'a'.repeat(64),
        id: row.id,
        kind: row.kind,
        after: { sort: 'added', value: row.dateKey },
      };
    }
    expect(seen).toEqual(wanted);
    expect((await repo.searchLibrary(auth, request, scope(user.id), true, cursor)).candidates).toEqual([]);
  });
  it('does not match another owner’s private bookmark notes in a shared album', async () => {
    const ctx = setup();
    const owner = await ctx.newUser();
    const viewer = await ctx.newUser();
    const repo = new BookmarkRepository(db);
    const { album } = await ctx.newAlbum({ ownerId: owner.user.id });
    await db
      .insertInto('album_user')
      .values({ albumId: album.id, userId: viewer.user.id, role: AlbumUserRole.Viewer })
      .execute();
    const bookmark = await repo.create(owner.user.id, {
      url: 'https://example.org/reference',
      title: 'Public reference',
      note: 'private-project',
      libraryScope: LibraryScope.Design,
    });
    await repo.addToAlbum({ user: owner.user }, album.id, [bookmark.id]);
    const request = LibraryItemSearchDto.schema.parse({
      query: 'private-project',
      filter: { albumIds: { any: [album.id] } },
    });
    expect((await repo.searchLibrary({ user: owner.user }, request, scope(owner.user.id), true)).count).toBe(1);
    expect((await repo.searchLibrary({ user: viewer.user }, request, scope(viewer.user.id), true)).count).toBe(0);
    expect(
      (
        await repo.searchLibrary(
          { user: viewer.user },
          { ...request, query: 'Public reference' },
          scope(viewer.user.id),
          true,
        )
      ).count,
    ).toBe(1);
  });
  it('matches only current, owned, visible bookmark previews and pages equal color ranks', async () => {
    const ctx = setup();
    const { user } = await ctx.newUser();
    const foreign = await ctx.newUser();
    const repo = new BookmarkRepository(db);
    const palettes = new AssetPaletteRepository(db);
    const wanted: Array<{ id: string; kind: 'asset' | 'bookmark' }> = [];
    for (const variant of ['personal', 'design', 'foreign', 'locked', 'trashed', 'missing'] as const) {
      let previewAssetId: string | null = null;
      if (variant !== 'missing') {
        const { asset } = await ctx.newAsset({
          ownerId: variant === 'foreign' ? foreign.user.id : user.id,
          libraryScope: variant === 'personal' ? LibraryScope.Personal : LibraryScope.Design,
        });
        previewAssetId = asset.id;
        const source = await palettes.source(asset.id);
        if (!source) throw new Error('Missing preview source');
        await palettes.publish(asset.id, source.sourceRevision, {
          version: 1,
          sourceRevision: source.sourceRevision,
          status: 'ready',
          representative: 'image',
          hasTransparency: true,
          swatches: [{ hex: '#ff0000', weight: 1, oklab: rgbToOklab(1, 0, 0) }],
        });
        switch (variant) {
          case 'locked': {
            await db.insertInto('asset_lock').values({ assetId: asset.id, reason: AssetLockReason.Marked }).execute();
            break;
          }
          case 'trashed': {
            await db.updateTable('asset').set({ deletedAt: new Date() }).where('id', '=', asset.id).execute();
            break;
          }
          case 'design': {
            wanted.push({ id: asset.id, kind: 'asset' });
            break;
          }
          // No default
        }
      }
      const bookmark = await repo.create(user.id, {
        url: `https://example.org/${variant}`,
        title: variant,
        libraryScope: LibraryScope.Design,
        previewAssetId,
      });
      if (variant === 'personal' || variant === 'design') wanted.push({ id: bookmark.id, kind: 'bookmark' });
    }
    wanted.sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));
    const request = LibraryItemSearchDto.schema.parse({
      filter: { libraryScope: 'design', color: { hex: '#ff0000' }, hasTransparency: { eq: true } },
      sort: 'color',
      limit: 1,
    });
    const seen: typeof wanted = [];
    let cursor: Extract<LibraryCursor, { mode: 'text' }> | undefined;
    for (let index = 0; index < wanted.length; index++) {
      const result = await repo.searchLibrary({ user }, request, scope(user.id), true, cursor);
      expect(result.count).toBe(wanted.length);
      const row = result.candidates[0];
      seen.push({ id: row.id, kind: row.kind });
      cursor = {
        mode: 'text',
        queryHash: 'a'.repeat(64),
        id: row.id,
        kind: row.kind,
        after: { sort: 'color', value: row.rank },
      };
    }
    expect(seen).toEqual(wanted);
    expect(
      (
        await repo.searchLibrary(
          { user },
          { ...request, filter: { ...request.filter, type: { eq: AssetType.Image } } },
          scope(user.id),
          true,
        )
      ).candidates.every(({ kind }) => kind === 'asset'),
    ).toBe(true);
  });
  it('does not count bookmark rows when the current key lacks BookmarkRead', async () => {
    const ctx = setup();
    const { user } = await ctx.newUser();
    const repo = new BookmarkRepository(db);
    await repo.create(user.id, {
      url: 'https://example.org/reference',
      title: 'Reference',
      libraryScope: LibraryScope.Design,
    });
    const request = LibraryItemSearchDto.schema.parse({ filter: { libraryScope: 'design' } });
    expect((await repo.searchLibrary({ user }, request, scope(user.id), false)).count).toBe(0);
    expect((await repo.searchLibrary({ user }, request, scope(user.id), true)).count).toBe(1);
  });
});
