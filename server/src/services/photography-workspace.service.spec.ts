import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import {
  PhotographyRatingDto,
  PhotographyWorkspaceSaveDto,
  type StoredShoot,
} from 'src/dtos/photography-workspace.dto.js';
import { AlbumKind, AssetVisibility } from 'src/enum.js';
import { PhotographyWorkspaceRepository } from 'src/repositories/photography-workspace.repository.js';
import { AlbumService } from 'src/services/album.service.js';
import { AssetMediaService } from 'src/services/asset-media.service.js';
import { AssetService } from 'src/services/asset.service.js';
import { PhotographyWorkspaceService } from 'src/services/photography-workspace.service.js';
import { SearchService } from 'src/services/search.service.js';
import { factory, newUuid } from 'test/small.factory.js';

const setup = () => {
  const auth = factory.auth({ session: {} });
  const shoot: StoredShoot = {
    id: newUuid(),
    albumId: newUuid(),
    name: 'Portrait',
    client: 'Jamie',
    type: 'Portrait',
    date: '2026-09-30',
    stage: 'Imported',
  };
  const revision = newUuid();
  const nextRevision = newUuid();
  const repository = {
    get: vi.fn().mockResolvedValue({ value: { shoots: [shoot] }, updateId: revision }),
    save: vi.fn().mockResolvedValue({ updateId: nextRevision }),
    currentRevisions: vi.fn().mockResolvedValue(new Map()),
  };
  const albums = {
    get: vi.fn().mockResolvedValue({
      albumUsers: [{ user: { id: auth.user.id } }],
      kind: AlbumKind.Album,
      albumThumbnailAssetId: null,
      assetCount: 0,
    }),
  };
  const search = { searchMetadata: vi.fn().mockResolvedValue({ assets: { items: [], nextCursor: null } }) };
  const assets = { update: vi.fn() };
  const sut = new PhotographyWorkspaceService(
    repository as unknown as PhotographyWorkspaceRepository,
    albums as unknown as AlbumService,
    search as unknown as SearchService,
    assets as unknown as AssetService,
    {} as AssetMediaService,
  );
  return { sut, auth, shoot, revision, nextRevision, repository, albums, search, assets };
};

describe(PhotographyWorkspaceService.name, () => {
  it('starts empty without synthesizing shoots', async () => {
    const { sut, auth, repository } = setup();
    repository.get.mockResolvedValue(undefined);
    await expect(sut.get(auth)).resolves.toEqual({ revision: null, shoots: [] });
    expect(repository.get).toHaveBeenCalledWith(auth.user.id);
  });

  it('rejects shared links, API keys and absent sessions before storage reads', async () => {
    const { sut, auth, repository } = setup();
    for (const denied of [
      { ...auth, session: undefined },
      { ...auth, sharedLink: {} },
      { ...auth, apiKey: {} },
    ]) {
      await expect(sut.get(denied as typeof auth)).rejects.toBeInstanceOf(ForbiddenException);
    }
    expect(repository.get).not.toHaveBeenCalled();
  });

  it('hydrates only an owned standard album and redacts a lost reference', async () => {
    const { sut, auth, shoot, albums } = setup();
    albums.get.mockResolvedValue({
      albumUsers: [{ user: { id: newUuid() } }],
      kind: AlbumKind.Album,
      albumThumbnailAssetId: newUuid(),
      assetCount: 17,
    });
    expect((await sut.get(auth)).shoots).toEqual([
      { ...shoot, albumId: null, unavailable: true, coverAssetId: null, assetCount: null },
    ]);
  });

  it('propagates storage failures instead of claiming the shoot is empty or unavailable', async () => {
    const { sut, auth, albums } = setup();
    const failure = new Error('offline');
    albums.get.mockRejectedValue(failure);
    await expect(sut.get(auth)).rejects.toBe(failure);
  });

  it('writes client and stage with actor-scoped CAS and current ownership validation', async () => {
    const { sut, auth, shoot, revision, nextRevision, repository } = setup();
    const updated = { ...shoot, client: 'Northbound', stage: 'Selected' as const };
    await expect(sut.save(auth, { expectedRevision: revision, shoots: [updated] })).resolves.toMatchObject({
      revision: nextRevision,
      shoots: [updated],
    });
    expect(repository.save).toHaveBeenCalledWith(auth.user.id, [updated], revision, [shoot.albumId]);
  });

  it('refuses stale read and raced write revisions', async () => {
    const { sut, auth, shoot, revision, repository } = setup();
    await expect(sut.save(auth, { expectedRevision: null, shoots: [shoot] })).rejects.toBeInstanceOf(ConflictException);
    expect(repository.save).not.toHaveBeenCalled();
    repository.save.mockResolvedValue(undefined);
    await expect(sut.save(auth, { expectedRevision: revision, shoots: [shoot] })).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('denies shared, smart and collection album references', async () => {
    const { sut, auth, shoot, revision, repository, albums } = setup();
    for (const album of [
      { albumUsers: [{ user: { id: newUuid() } }], kind: AlbumKind.Album },
      { albumUsers: [{ user: { id: auth.user.id } }], kind: AlbumKind.Album, isSmart: true },
      { albumUsers: [{ user: { id: auth.user.id } }], kind: AlbumKind.Collection },
    ]) {
      albums.get.mockResolvedValue(album);
      await expect(sut.save(auth, { expectedRevision: revision, shoots: [shoot] })).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    }
    expect(repository.save).not.toHaveBeenCalled();
  });

  it('retains unavailable records by opaque ID without accepting changed private fields', async () => {
    const { sut, auth, shoot, revision, repository } = setup();
    await sut.save(auth, { expectedRevision: revision, shoots: [{ ...shoot, albumId: null, client: 'Injected' }] });
    expect(repository.save).toHaveBeenCalledWith(auth.user.id, [shoot], revision, []);
    await expect(
      sut.save(auth, { expectedRevision: revision, shoots: [{ ...shoot, id: newUuid(), albumId: null }] }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('never reads another user’s shoot by ID', async () => {
    const { sut, auth, search } = setup();
    await expect(sut.photos(auth, newUuid(), {})).rejects.toThrow('Shoot not found');
    expect(search.searchMetadata).not.toHaveBeenCalled();
  });

  it('excludes Locked content even with an elevated PIN session and preserves paging, rating and stack identity', async () => {
    const { sut, auth, shoot, search, repository } = setup();
    const id = newUuid();
    const current = newUuid();
    search.searchMetadata.mockResolvedValue({
      assets: {
        items: [
          {
            id,
            ownerId: auth.user.id,
            originalFileName: 'photo.CR3',
            originalPath: '/private/original',
            exifInfo: { rating: -1 },
            stack: { assetCount: 3 },
          },
        ],
        nextCursor: 'cursor',
      },
    });
    repository.currentRevisions.mockResolvedValue(new Map([[id, current]]));
    await expect(
      sut.photos({ ...auth, session: { ...auth.session!, hasElevatedPermission: true } }, shoot.id, {}),
    ).resolves.toEqual({
      nextCursor: 'cursor',
      photos: [
        {
          id,
          fileName: 'photo.CR3',
          rating: -1,
          stackCount: 3,
          currentRevisionId: current,
          canRate: true,
          camera: '',
          capturedAt: null,
          isRaw: true,
          stackId: null,
          width: null,
          height: null,
          eligible: false,
          exclusion: 'rejected',
          processing: 'pending',
        },
      ],
    });
    expect(search.searchMetadata).toHaveBeenCalledWith(
      expect.objectContaining({ session: expect.objectContaining({ hasElevatedPermission: false }) }),
      expect.objectContaining({
        filter: expect.objectContaining({
          visibility: { ne: AssetVisibility.Locked },
          albumIds: { any: [shoot.albumId] },
        }),
      }),
    );
  });

  it('denies absent, cross-shoot or foreign-owned photos before culling', async () => {
    const { sut, auth, shoot, search, assets } = setup();
    const assetId = newUuid();
    for (const items of [[], [{ id: assetId, ownerId: newUuid() }]]) {
      search.searchMetadata.mockResolvedValue({ assets: { items } });
      await expect(sut.rate(auth, shoot.id, { assetId, rating: -1 })).rejects.toBeInstanceOf(ForbiddenException);
    }
    expect(assets.update).not.toHaveBeenCalled();
  });

  it('reuses the existing asset rating writer after current album membership validation', async () => {
    const { sut, auth, shoot, search, assets } = setup();
    const assetId = newUuid();
    search.searchMetadata.mockResolvedValue({ assets: { items: [{ id: assetId, ownerId: auth.user.id }] } });
    await sut.rate(auth, shoot.id, { assetId, rating: -1 });
    expect(assets.update).toHaveBeenCalledWith(expect.objectContaining({ user: auth.user }), assetId, { rating: -1 });
  });

  it('validates duplicate IDs, real calendar dates, unknown keys and rating bounds', () => {
    const { shoot } = setup();
    const save = (shoots: unknown[]) =>
      PhotographyWorkspaceSaveDto.schema.safeParse({ expectedRevision: null, shoots }).success;
    expect(save([shoot])).toBe(true);
    expect(save([shoot, shoot])).toBe(false);
    expect(save([{ ...shoot, date: '2026-02-30' }])).toBe(false);
    expect(save([{ ...shoot, ownerId: newUuid() }])).toBe(false);
    for (const rating of [0, 6, -2]) {
      expect(PhotographyRatingDto.schema.safeParse({ assetId: newUuid(), rating }).success).toBe(false);
    }
  });
});
