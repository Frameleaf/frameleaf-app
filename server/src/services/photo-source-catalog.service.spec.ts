import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { PhotoSourceCatalogItem } from 'src/dtos/photo-source.dto.js';
import { AlbumKind } from 'src/enum.js';
import { CATALOG_METADATA_KEY, type CatalogTarget } from 'src/repositories/photo-source.repository.js';
import {
  PhotoSourceCatalogService,
  catalogKeywordTag,
  catalogRating,
  catalogTags,
} from 'src/services/photo-source-catalog.service.js';
import { checkAccess } from 'src/utils/access.js';
import { authStub } from 'test/fixtures/auth.stub.js';

vi.mock('src/utils/access.js', () => ({
  requireAccess: vi.fn().mockResolvedValue(undefined),
  checkAccess: vi.fn((_access: unknown, { ids }: { ids: string[] }) => Promise.resolve(new Set(ids))),
}));

const sourceId = randomUUID();

const target = (overrides: Partial<CatalogTarget> = {}): CatalogTarget => {
  const assetId = randomUUID();
  return {
    id: randomUUID(),
    state: 'verified',
    copiedAssetId: assetId,
    assetId,
    rating: null,
    description: '',
    applied: null,
    ...overrides,
  };
};

/** A service over an in-memory library, so a second read-in sees what the first one wrote. */
const setup = (rows: CatalogTarget[]) => {
  // FL-1840: collection id → album id, null once the person removed the album
  const collectionAlbums = new Map<string, string | null>();
  const library = new Map(rows.map((row) => [row.id, row]));
  const byAsset = (assetId: string) => library.values().find((row) => row.assetId === assetId)!;
  const repository = {
    catalogTargets: vi.fn((_auth: unknown, _sourceId: string, ids: string[]) =>
      Promise.resolve(ids.flatMap((id) => (library.has(id) ? [{ ...library.get(id)! }] : []))),
    ),
    findCatalogAlbum: vi.fn().mockResolvedValue(undefined),
    getCatalogKey: vi.fn().mockResolvedValue('lightroom:catalog-1'),
    getCatalogCollectionAlbum: vi.fn((_owner: string, _catalog: string, id: string) =>
      Promise.resolve(collectionAlbums.has(id) ? { albumId: collectionAlbums.get(id)! } : undefined),
    ),
    setCatalogCollectionAlbum: vi.fn((_owner: string, _catalog: string, id: string, albumId: string) => {
      if (!collectionAlbums.has(id)) {
        collectionAlbums.set(id, albumId);
      }
      return Promise.resolve(collectionAlbums.get(id)!);
    }),
  };
  const assetRepository = {
    upsertMetadata: vi.fn((assetId: string, [{ value }]: [{ key: string; value: Record<string, unknown> }]) => {
      byAsset(assetId).applied = structuredClone(value);
      return Promise.resolve([]);
    }),
  };
  const assets = {
    update: vi.fn((_auth: unknown, assetId: string, dto: { rating?: number | null; description?: string }) => {
      const row = byAsset(assetId);
      if (dto.rating !== undefined) {
        row.rating = dto.rating;
      }
      if (dto.description !== undefined) {
        row.description = dto.description;
      }
      return Promise.resolve({});
    }),
  };
  const tags = {
    upsert: vi.fn((_auth: unknown, { tags }: { tags: string[] }) =>
      Promise.resolve(tags.map((value) => ({ id: `tag:${value}`, value }))),
    ),
    bulkTagAssets: vi.fn().mockResolvedValue({ count: 1 }),
  };
  const albums = {
    create: vi.fn((_auth: unknown, dto: { albumName: string }) => Promise.resolve({ id: `album:${dto.albumName}` })),
    addAssets: vi.fn().mockResolvedValue([]),
  };
  const service = new PhotoSourceCatalogService(
    repository as never,
    {} as never,
    assetRepository as never,
    assets as never,
    tags as never,
    albums as never,
    { setContext: vi.fn(), log: vi.fn() } as never,
  );
  const apply = (items: PhotoSourceCatalogItem[], auth = authStub.user1) => service.apply(auth, sourceId, { items });
  return { library, repository, assetRepository, assets, tags, albums, apply, collectionAlbums };
};

const writes = (ctx: ReturnType<typeof setup>) =>
  ctx.assets.update.mock.calls.length +
  ctx.assetRepository.upsertMetadata.mock.calls.length +
  ctx.tags.bulkTagAssets.mock.calls.length +
  ctx.albums.create.mock.calls.length +
  ctx.albums.addAssets.mock.calls.length;

describe(PhotoSourceCatalogService.name, () => {
  beforeEach(() => {
    vi.mocked(checkAccess).mockClear();
  });

  describe('mapping', () => {
    it('turns keyword hierarchies into nested tag values, keeping a slash inside a level', () => {
      expect(catalogKeywordTag('Places|France|Paris')).toBe('Places/France/Paris');
      expect(catalogKeywordTag(' People | AC/DC ')).toBe('People/AC|DC');
      expect(catalogKeywordTag('||')).toBeUndefined();
    });

    it('adds the colour label and a pick as tags', () => {
      expect(
        catalogTags({ itemId: randomUUID(), keywords: ['Dogs', 'Dogs'], colorLabel: 'Red/Orange', flag: 'pick' }),
      ).toEqual(['Dogs', 'Colour label/Red|Orange', 'Flag/Pick']);
    });

    it('lets a reject win over stars, and unrates when a reject is taken back without stars', () => {
      const itemId = randomUUID();
      expect(catalogRating({ itemId, rating: 4, flag: 'reject' }, {})).toBe(-1);
      expect(catalogRating({ itemId, rating: 4, flag: null }, { rating: -1 })).toBe(4);
      expect(catalogRating({ itemId, flag: null }, { rating: -1 })).toBe(0);
      expect(catalogRating({ itemId, flag: 'pick' }, { rating: 3 })).toBeUndefined();
      expect(catalogRating({ itemId }, {})).toBeUndefined();
    });
  });

  it('applies a first read-in and remembers what it wrote', async () => {
    const row = target();
    const ctx = setup([row]);

    const result = await ctx.apply([
      {
        itemId: row.id,
        rating: 4,
        colorLabel: 'Red',
        keywords: ['Places|France|Paris'],
        title: 'A title',
        caption: 'The caption',
        collections: [{ path: ['Travel', '2024'], name: 'Paris' }],
      },
    ]);

    expect(result.summary).toEqual({ applied: 1, unchanged: 0, keptEdits: 0, notReady: 0, notFound: 0 });
    expect(result.items).toEqual([
      { itemId: row.id, status: 'applied', applied: ['rating', 'description', 'tags', 'albums'], keptEdits: [] },
    ]);
    expect(ctx.assets.update).toHaveBeenCalledExactlyOnceWith(authStub.user1, row.assetId, {
      rating: 4,
      description: 'The caption',
    });
    expect(ctx.tags.upsert).toHaveBeenCalledWith(authStub.user1, { tags: ['Places/France/Paris', 'Colour label/Red'] });
    expect(ctx.tags.bulkTagAssets).toHaveBeenCalledExactlyOnceWith(authStub.user1, {
      tagIds: ['tag:Colour label/Red', 'tag:Places/France/Paris'],
      assetIds: [row.assetId],
    });
    // collection sets become nested collections; the collection itself an album inside them
    expect(ctx.albums.create.mock.calls.map(([, dto]) => dto)).toEqual([
      { albumName: 'Travel', kind: AlbumKind.Collection },
      { albumName: '2024', parentId: 'album:Travel', kind: AlbumKind.Collection },
      { albumName: 'Paris', parentId: 'album:2024', kind: AlbumKind.Album },
    ]);
    expect(ctx.albums.addAssets).toHaveBeenCalledExactlyOnceWith(authStub.user1, 'album:Paris', {
      ids: [row.assetId],
    });
    expect(ctx.assetRepository.upsertMetadata).toHaveBeenCalledExactlyOnceWith(row.assetId, [
      {
        key: CATALOG_METADATA_KEY,
        value: {
          rating: 4,
          description: 'The caption',
          tags: ['Places/France/Paris', 'Colour label/Red'],
          collections: [['Travel', '2024', 'Paris']],
        },
      },
    ]);
  });

  it('is idempotent: sending the same batch again writes nothing', async () => {
    const row = target();
    const ctx = setup([row]);
    const items: PhotoSourceCatalogItem[] = [
      {
        itemId: row.id,
        rating: 2,
        flag: 'pick',
        keywords: ['Dogs'],
        caption: 'Walk',
        collections: [{ path: [], name: 'Pets' }],
      },
    ];

    await ctx.apply(items);
    vi.clearAllMocks();
    const again = await ctx.apply(items);

    expect(again.summary).toEqual({ applied: 0, unchanged: 1, keptEdits: 0, notReady: 0, notFound: 0 });
    expect(again.items[0]).toEqual({ itemId: row.id, status: 'unchanged', applied: [], keptEdits: [] });
    expect(writes(ctx)).toBe(0);
    expect(ctx.tags.upsert).not.toHaveBeenCalled();
  });

  it('keeps a rating the person changed in Frameleaf after the import', async () => {
    const row = target();
    const ctx = setup([row]);
    await ctx.apply([{ itemId: row.id, rating: 3, caption: 'From the catalog' }]);
    // the person re-rates and re-captions in Frameleaf
    row.rating = 5;
    row.description = 'My own words';
    vi.clearAllMocks();

    const result = await ctx.apply([{ itemId: row.id, rating: 1, caption: 'Edited in the catalog' }]);

    expect(result.summary.keptEdits).toBe(1);
    expect(result.items[0]).toEqual({
      itemId: row.id,
      status: 'keptEdits',
      applied: [],
      keptEdits: ['rating', 'description'],
    });
    expect(ctx.assets.update).not.toHaveBeenCalled();
    expect(row.rating).toBe(5);
    expect(row.description).toBe('My own words');
  });

  it('follows a catalog change on a field the person has not touched', async () => {
    const row = target();
    const ctx = setup([row]);
    await ctx.apply([{ itemId: row.id, rating: 3 }]);
    vi.clearAllMocks();

    const result = await ctx.apply([{ itemId: row.id, rating: 0, flag: 'reject' }]);

    expect(result.items[0].status).toBe('applied');
    expect(ctx.assets.update).toHaveBeenCalledExactlyOnceWith(authStub.user1, row.assetId, { rating: -1 });
    expect(row.applied).toMatchObject({ rating: -1 });

    vi.clearAllMocks();
    await ctx.apply([{ itemId: row.id, flag: null }]);
    // the catalog took the reject back: unrated, never 0 (which Frameleaf does not store)
    expect(ctx.assets.update).toHaveBeenCalledExactlyOnceWith(authStub.user1, row.assetId, { rating: null });
  });

  it('leaves a value the item already had before any read-in, and records one that already agrees', async () => {
    const rated = target({ rating: 2, description: 'From the camera' });
    const agreeing = target({ rating: 4 });
    const ctx = setup([rated, agreeing]);

    const result = await ctx.apply([
      { itemId: rated.id, rating: 5, caption: 'Catalog caption' },
      { itemId: agreeing.id, rating: 4 },
    ]);

    expect(result.items.map(({ status }) => status)).toEqual(['keptEdits', 'unchanged']);
    expect(ctx.assets.update).not.toHaveBeenCalled();
    expect(ctx.assetRepository.upsertMetadata).toHaveBeenCalledExactlyOnceWith(agreeing.assetId, [
      { key: CATALOG_METADATA_KEY, value: { rating: 4 } },
    ]);
  });

  it('never adds back a tag or album the person removed, and adds only what is new', async () => {
    const row = target({
      applied: { tags: ['Dogs'], collections: [['Pets']] },
    });
    const ctx = setup([row]);
    ctx.repository.findCatalogAlbum.mockResolvedValue({ id: 'existing-walks' });

    const result = await ctx.apply([
      {
        itemId: row.id,
        keywords: ['Dogs', 'Parks'],
        collections: [
          { path: [], name: 'Pets' },
          { path: [], name: 'Walks' },
        ],
      },
    ]);

    expect(result.items[0].applied).toEqual(['tags', 'albums']);
    expect(ctx.tags.upsert).toHaveBeenCalledWith(authStub.user1, { tags: ['Parks'] });
    expect(ctx.tags.bulkTagAssets).toHaveBeenCalledExactlyOnceWith(authStub.user1, {
      tagIds: ['tag:Parks'],
      assetIds: [row.assetId],
    });
    // an album of the same name the owner already has is reused, not duplicated
    expect(ctx.repository.findCatalogAlbum).toHaveBeenCalledExactlyOnceWith('user-id', 'Walks', null, true);
    expect(ctx.albums.create).not.toHaveBeenCalled();
    expect(ctx.albums.addAssets).toHaveBeenCalledExactlyOnceWith(authStub.user1, 'existing-walks', {
      ids: [row.assetId],
    });
    expect(row.applied).toEqual({ tags: ['Dogs', 'Parks'], collections: [['Pets'], ['Walks']] });
  });

  describe('collections the catalog names by id (FL-1840)', () => {
    it('keeps a renamed collection going to the album it became', async () => {
      const first = target();
      const second = target();
      const ctx = setup([first, second]);

      await ctx.apply([{ itemId: first.id, collections: [{ path: ['Trips'], name: 'Paris', id: 'c1' }] }]);
      ctx.albums.create.mockClear();
      ctx.albums.addAssets.mockClear();
      await ctx.apply([{ itemId: second.id, collections: [{ path: [], name: 'Paris 2024', id: 'c1' }] }]);

      expect(ctx.repository.getCatalogKey).toHaveBeenCalledWith('user-id', sourceId);
      expect(ctx.albums.create).not.toHaveBeenCalled();
      expect(ctx.albums.addAssets).toHaveBeenCalledExactlyOnceWith(authStub.user1, 'album:Paris', {
        ids: [second.assetId],
      });
    });

    it('does not add an item again when only the collection’s name changed', async () => {
      const row = target();
      const ctx = setup([row]);

      await ctx.apply([{ itemId: row.id, collections: [{ path: [], name: 'Paris', id: 'c1' }] }]);
      expect(row.applied).toEqual({ collections: [['Paris']], collectionIds: ['c1'] });
      ctx.albums.addAssets.mockClear();

      const result = await ctx.apply([{ itemId: row.id, collections: [{ path: [], name: 'Paris 2024', id: 'c1' }] }]);

      expect(result.items[0].status).toBe('unchanged');
      expect(ctx.albums.addAssets).not.toHaveBeenCalled();
    });

    it('leaves an album the person removed gone', async () => {
      const row = target();
      const ctx = setup([row]);
      ctx.collectionAlbums.set('c1', null);

      await ctx.apply([{ itemId: row.id, collections: [{ path: [], name: 'Paris', id: 'c1' }] }]);

      expect(ctx.albums.create).not.toHaveBeenCalled();
      expect(ctx.albums.addAssets).not.toHaveBeenCalled();
    });

    it('remembers by id the album an earlier read-in found by name, without adding the item again', async () => {
      const row = target({ applied: { collections: [['Paris']] } });
      const ctx = setup([row]);
      ctx.repository.findCatalogAlbum.mockResolvedValue({ id: 'existing-paris' });

      await ctx.apply([{ itemId: row.id, collections: [{ path: [], name: 'Paris', id: 'c1' }] }]);

      expect(ctx.collectionAlbums.get('c1')).toBe('existing-paris');
      expect(ctx.albums.create).not.toHaveBeenCalled();
      expect(ctx.albums.addAssets).not.toHaveBeenCalled();
      expect(row.applied).toEqual({ collections: [['Paris']], collectionIds: ['c1'] });
    });
  });

  it('shares tags and albums across items in one batch', async () => {
    const first = target();
    const second = target();
    const ctx = setup([first, second]);

    await ctx.apply([
      { itemId: first.id, keywords: ['Dogs'], collections: [{ path: [], name: 'Pets' }] },
      { itemId: second.id, keywords: ['Dogs'], collections: [{ path: [], name: 'Pets' }] },
    ]);

    expect(ctx.tags.upsert).toHaveBeenCalledExactlyOnceWith(authStub.user1, { tags: ['Dogs'] });
    expect(ctx.tags.bulkTagAssets).toHaveBeenCalledExactlyOnceWith(authStub.user1, {
      tagIds: ['tag:Dogs'],
      assetIds: [first.assetId, second.assetId],
    });
    expect(ctx.albums.create).toHaveBeenCalledOnce();
    expect(ctx.albums.addAssets).toHaveBeenCalledExactlyOnceWith(authStub.user1, 'album:Pets', {
      ids: [first.assetId, second.assetId],
    });
  });

  it('reports items that are not verified yet as notReady without failing the batch', async () => {
    const planned = target({ state: 'planned', copiedAssetId: null, assetId: null });
    const ready = target();
    const gone = target({ assetId: null });
    const ctx = setup([planned, ready, gone]);
    const unknown = randomUUID();

    const result = await ctx.apply([
      { itemId: planned.id, rating: 5 },
      { itemId: ready.id, rating: 5 },
      { itemId: gone.id, rating: 5 },
      { itemId: unknown, rating: 5 },
    ]);

    expect(result.summary).toEqual({ applied: 1, unchanged: 0, keptEdits: 0, notReady: 1, notFound: 2 });
    expect(result.items.map(({ itemId, status }) => [itemId, status])).toEqual([
      [planned.id, 'notReady'],
      [ready.id, 'applied'],
      [gone.id, 'notFound'],
      [unknown, 'notFound'],
    ]);
    expect(ctx.assets.update).toHaveBeenCalledExactlyOnceWith(authStub.user1, ready.assetId, { rating: 5 });
  });

  it('leaves a photo the session may not change (such as a Locked one) alone', async () => {
    const row = target();
    const ctx = setup([row]);
    vi.mocked(checkAccess).mockResolvedValueOnce(new Set());

    const result = await ctx.apply([{ itemId: row.id, rating: 5, keywords: ['Dogs'] }]);

    expect(result.items[0].status).toBe('notFound');
    expect(writes(ctx)).toBe(0);
  });

  describe('only the owner', () => {
    it('refuses anything but a photo session', async () => {
      const row = target();
      const ctx = setup([row]);
      for (const auth of [
        authStub.admin,
        { ...authStub.user1, apiKey: { id: randomUUID(), permissions: [] } },
        authStub.adminSharedLink,
      ]) {
        await expect(ctx.apply([{ itemId: row.id, rating: 1 }], auth as never)).rejects.toBeInstanceOf(
          ForbiddenException,
        );
      }
      expect(ctx.repository.catalogTargets).not.toHaveBeenCalled();
    });

    it("passes the caller's own session to the source checks and writes nothing when they refuse", async () => {
      const row = target();
      const ctx = setup([row]);
      // another person's source, a revoked one or a changed device: the repository's source checks refuse
      ctx.repository.catalogTargets.mockRejectedValueOnce(new NotFoundException('Photo source unavailable'));

      await expect(ctx.apply([{ itemId: row.id, rating: 1 }])).rejects.toBeInstanceOf(NotFoundException);
      expect(ctx.repository.catalogTargets).toHaveBeenCalledWith(
        { ownerId: 'user-id', sessionId: 'token-id' },
        sourceId,
        [row.id],
      );
      expect(writes(ctx)).toBe(0);
    });
  });

  it('rejects a batch over 500 items or naming an item twice', async () => {
    const ctx = setup([]);
    const many = Array.from({ length: 501 }, () => ({ itemId: randomUUID() }));
    await expect(ctx.apply(many)).rejects.toThrow();
    const itemId = randomUUID();
    await expect(ctx.apply([{ itemId }, { itemId }])).rejects.toThrow();
    expect(ctx.repository.catalogTargets).not.toHaveBeenCalled();
  });
});
