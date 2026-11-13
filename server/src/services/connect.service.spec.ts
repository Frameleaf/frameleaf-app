import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { ConnectService } from 'src/services/connect.service.js';
import { newTestService } from 'test/utils.js';
import { authStub } from 'test/fixtures/auth.stub.js';

const albumId = randomUUID();
const assetId = randomUUID();
const auth: AuthDto = {
  user: authStub.user1.user,
  oauthApp: {
    grantId: randomUUID(),
    clientId: randomUUID(),
    clientName: 'App',
    resource: 'https://library.example/api/connect',
    scopes: ['library:read', 'albums:write', 'tags:write'],
    accessPolicy: {
      version: 1,
      readAlbumIds: [albumId],
      allLibraryRead: false,
      writableAlbumIds: [albumId],
      writeWorkspaces: ['photo'],
    },
  },
};

describe('ConnectService additive writes', () => {
  const setup = () => {
    const { sut } = newTestService(ConnectService);
    const repo = {
      withGrantWrite: vi.fn((_auth, work) => work(auth)),
      requireWritableAlbum: vi.fn().mockResolvedValue(undefined),
      requireReadableAssets: vi.fn().mockResolvedValue(undefined),
    };
    const albums = { addAssets: vi.fn().mockResolvedValue([{ id: assetId, success: true }]) };
    const tags = {
      create: vi.fn().mockResolvedValue({ id: 'tag' }),
      addAssets: vi.fn().mockResolvedValue([{ id: assetId, success: true }]),
    };
    Object.assign(sut, { connectRepository: repo, albumService: albums, tagService: tags });
    return { sut, repo, albums, tags };
  };

  it('refuses an unreadable source before an additive album write', async () => {
    const { sut, repo, albums } = setup();
    repo.requireReadableAssets.mockRejectedValue(new NotFoundException());
    await expect(sut.addAssets(auth, albumId, { assetIds: [assetId] })).rejects.toBeInstanceOf(NotFoundException);
    expect(albums.addAssets).not.toHaveBeenCalled();
  });
  it('refuses a destination that is no longer writable', async () => {
    const { sut, repo, albums } = setup();
    repo.requireWritableAlbum.mockRejectedValue(new ForbiddenException());
    await expect(sut.addAssets(auth, albumId, { assetIds: [assetId] })).rejects.toBeInstanceOf(ForbiddenException);
    expect(albums.addAssets).not.toHaveBeenCalled();
  });
  it('adds only the authorized assets through the existing album service', async () => {
    const { sut, albums } = setup();
    await expect(sut.addAssets(auth, albumId, { assetIds: [assetId] })).resolves.toEqual([
      { id: assetId, success: true },
    ]);
    expect(albums.addAssets).toHaveBeenCalledWith(auth, albumId, { ids: [assetId] });
  });
  it('requires both read and write-target membership before tagging', async () => {
    const { sut, repo, tags } = setup();
    repo.requireReadableAssets.mockRejectedValue(new NotFoundException());
    await expect(sut.addTags(auth, assetId, { tags: ['Holiday'] })).rejects.toBeInstanceOf(NotFoundException);
    expect(tags.create).not.toHaveBeenCalled();
    expect(repo.requireReadableAssets).toHaveBeenCalledWith(auth, [assetId], true);
  });
  it('reports tag failure rather than claiming the asset was tagged', async () => {
    const { sut, tags } = setup();
    tags.addAssets.mockResolvedValue([{ id: assetId, success: false }] as never);
    await expect(sut.addTags(auth, assetId, { tags: ['Holiday'] })).rejects.toThrow();
  });
});
