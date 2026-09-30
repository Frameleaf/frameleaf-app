import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import type { StoredPinnedCollection } from 'src/dtos/pinned-collection.dto.js';
import { PinnedCollectionsUpdateDto } from 'src/dtos/pinned-collection.dto.js';
import { UserRepository } from 'src/repositories/user.repository.js';
import { AlbumService } from 'src/services/album.service.js';
import { MemoryService } from 'src/services/memory.service.js';
import { PersonService } from 'src/services/person.service.js';
import { PetService } from 'src/services/pet.service.js';
import { PinnedCollectionService } from 'src/services/pinned-collection.service.js';
import { SearchService } from 'src/services/search.service.js';
import { UserService } from 'src/services/user.service.js';
import { factory, newUuid } from 'test/small.factory.js';

const setup = () => {
  const cover = newUuid();
  const mocks = {
    users: { getPinnedCollections: vi.fn(), setPinnedCollections: vi.fn() },
    albums: {
      get: vi
        .fn()
        .mockResolvedValue({ albumName: 'Album', assetCount: 2, albumThumbnailAssetId: cover, isSmart: true }),
    },
    people: { getById: vi.fn().mockResolvedValue({ name: 'Person' }) },
    pets: { get: vi.fn().mockResolvedValue({ name: 'Pet', assetCount: 999, featuredAssetId: newUuid() }) },
    memories: { get: vi.fn().mockResolvedValue({ title: 'Memory title', assets: [{ id: cover }] }) },
    search: {
      searchStatistics: vi.fn().mockResolvedValue({ total: 3 }),
      searchMetadata: vi.fn().mockResolvedValue({ assets: { total: 3, items: [{ id: cover }] } }),
      searchSmartStatistics: vi.fn().mockResolvedValue({ total: 100_000, capped: true }),
      searchSmart: vi.fn().mockResolvedValue({ assets: { items: [{ id: cover }] } }),
    },
    preferences: {
      getMyPreferences: vi
        .fn()
        .mockResolvedValue({ savedSearches: [{ name: 'Snow', query: { isFavorite: true, page: 7, size: 40 } }] }),
    },
  };
  const sut = new PinnedCollectionService(
    mocks.users as unknown as UserRepository,
    mocks.albums as unknown as AlbumService,
    mocks.people as unknown as PersonService,
    mocks.pets as unknown as PetService,
    mocks.memories as unknown as MemoryService,
    mocks.search as unknown as SearchService,
    mocks.preferences as unknown as UserService,
  );
  return { sut, mocks, cover, auth: factory.auth({ session: {} }) };
};

const ref = (kind: StoredPinnedCollection['kind'], targetId = newUuid()): StoredPinnedCollection => ({
  id: newUuid(),
  kind,
  targetId,
});

describe(PinnedCollectionService.name, () => {
  it('hydrates mixed pin types in their stored order through the existing access-filtered domains', async () => {
    const { sut, mocks, auth, cover } = setup();
    const refs = [
      ref('album'),
      ref('smart-album'),
      ref('person'),
      ref('pet'),
      ref('memory'),
      ref('saved-search', 'Snow'),
      ref('builtin', 'favourites'),
    ];
    const revision = newUuid();
    mocks.users.getPinnedCollections.mockResolvedValue({ updateId: revision, value: { pins: refs } });
    const snapshot = await sut.get(auth);
    expect(snapshot.revision).toBe(revision);
    expect(snapshot.pins.map(({ id }) => id)).toEqual(refs.map(({ id }) => id));
    expect(snapshot.pins.every(({ unavailable, coverAssetId }) => !unavailable && coverAssetId === cover)).toBe(true);
    expect(snapshot.pins.map(({ title, count }) => [title, count])).toEqual([
      ['Album', 2],
      ['Album', 2],
      ['Person', 3],
      ['Pet', 3],
      ['Memory title', 1],
      ['Snow', 3],
      ['Favourites', 3],
    ]);
    expect(mocks.search.searchMetadata).toHaveBeenCalledWith(auth, { isFavorite: true, size: 1 }, true);
  });

  it('redacts a lost target and a suppressed saved search without changing the stored revision', async () => {
    const { sut, mocks, auth } = setup();
    const pins = [ref('album'), ref('saved-search', 'Snow')];
    const revision = newUuid();
    mocks.users.getPinnedCollections.mockResolvedValue({ updateId: revision, value: { pins } });
    expect((await sut.get(auth)).pins.every(({ unavailable }) => !unavailable)).toBe(true);
    mocks.albums.get.mockRejectedValue(new ForbiddenException('Private album name'));
    mocks.preferences.getMyPreferences.mockResolvedValue({ savedSearches: [] });
    expect(await sut.get(auth)).toEqual({
      revision,
      pins: pins.map(({ id, kind }) => ({
        id,
        kind,
        targetId: null,
        unavailable: true,
        title: null,
        count: null,
        coverAssetId: null,
        countCapped: false,
      })),
    });
  });

  it('redacts a built-in Locked destination when its search refuses access', async () => {
    const { sut, mocks, auth } = setup();
    mocks.users.getPinnedCollections.mockResolvedValue({
      updateId: newUuid(),
      value: { pins: [ref('builtin', 'locked')] },
    });
    mocks.search.searchMetadata.mockRejectedValue(new ForbiddenException('Unlock required'));
    expect((await sut.get(auth)).pins[0]).toMatchObject({
      unavailable: true,
      targetId: null,
      title: null,
      count: null,
      coverAssetId: null,
    });
  });

  it('does not disguise operational failures as unavailable collections', async () => {
    const { sut, mocks, auth } = setup();
    const failure = new Error('database unavailable');
    mocks.users.getPinnedCollections.mockResolvedValue({ value: { pins: [ref('album')] }, updateId: newUuid() });
    mocks.albums.get.mockRejectedValue(failure);
    await expect(sut.get(auth)).rejects.toBe(failure);
  });

  it('retains a private target by opaque pin ID while reordering an unavailable pin', async () => {
    const { sut, mocks, auth } = setup();
    const pin = ref('album');
    const revision = newUuid();
    const next = newUuid();
    mocks.users.getPinnedCollections.mockResolvedValue({ value: { pins: [pin] }, updateId: revision });
    mocks.users.setPinnedCollections.mockResolvedValue({ updateId: next });
    mocks.albums.get.mockRejectedValue(new ForbiddenException());
    await expect(
      sut.set(auth, { expectedRevision: revision, pins: [{ ...pin, targetId: null }] }),
    ).resolves.toMatchObject({ revision: next, pins: [{ id: pin.id, targetId: null, unavailable: true }] });
    expect(mocks.users.setPinnedCollections).toHaveBeenCalledWith(auth.user.id, [pin], revision);
  });

  it('rejects stale read revisions and atomic-write conflicts without overwriting', async () => {
    const { sut, mocks, auth } = setup();
    const revision = newUuid();
    mocks.users.getPinnedCollections.mockResolvedValue({ updateId: revision, value: { pins: [] } });
    await expect(sut.set(auth, { expectedRevision: null, pins: [] })).rejects.toBeInstanceOf(ConflictException);
    expect(mocks.users.setPinnedCollections).not.toHaveBeenCalled();
    mocks.users.setPinnedCollections.mockResolvedValue(undefined);
    await expect(sut.set(auth, { expectedRevision: revision, pins: [] })).rejects.toBeInstanceOf(ConflictException);
  });

  it('refuses fabricated unavailable pins and duplicate collection references', async () => {
    const { sut, mocks, auth } = setup();
    const pin = ref('builtin', 'favourites');
    await expect(sut.set(auth, { expectedRevision: null, pins: [{ ...pin, targetId: null }] })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(
      sut.set(auth, { expectedRevision: null, pins: [pin, { ...pin, id: newUuid() }] }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(mocks.users.setPinnedCollections).not.toHaveBeenCalled();
    expect(PinnedCollectionsUpdateDto.schema.safeParse({ expectedRevision: null, pins: [pin, pin] }).success).toBe(
      false,
    );
  });

  it('uses the existing semantic-search count cap and authorised semantic cover', async () => {
    const { sut, mocks, auth, cover } = setup();
    mocks.users.getPinnedCollections.mockResolvedValue({
      updateId: newUuid(),
      value: { pins: [ref('saved-search', 'Snow')] },
    });
    mocks.preferences.getMyPreferences.mockResolvedValue({
      savedSearches: [{ name: 'Snow', query: { query: 'snowy mountains' } }],
    });
    await expect(sut.get(auth)).resolves.toMatchObject({
      pins: [{ title: 'Snow', count: 100_000, countCapped: true, coverAssetId: cover }],
    });
    expect(mocks.search.searchSmart).toHaveBeenCalledWith(auth, { query: 'snowy mountains', size: 1 });
  });

  it('rejects non-session callers before reading private storage', async () => {
    const { sut, mocks } = setup();
    await expect(sut.get(factory.auth({ apiKey: {} }))).rejects.toBeInstanceOf(ForbiddenException);
    await expect(sut.get(factory.auth({ session: {}, sharedLink: {} }))).rejects.toBeInstanceOf(ForbiddenException);
    expect(mocks.users.getPinnedCollections).not.toHaveBeenCalled();
  });
});
