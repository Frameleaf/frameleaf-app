import { NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { AlbumKind, AlbumUserRole, AssetType, AssetVisibility, CacheControl } from 'src/enum.js';
import { DesktopOfflineAlbumService } from 'src/services/desktop-offline-album.service.js';

const owner = { id: 'owner' };
const auth = { user: owner, session: { id: 'browser-session', hasElevatedPermission: false } } as AuthDto;
const host = '127.0.0.1:2283';
const approved = {
  id: 'asset',
  ownerId: owner.id,
  isLocked: false,
  deletedAt: null,
  visibility: AssetVisibility.Timeline,
  type: AssetType.Image,
  originalFileName: 'Trip.jpg',
  checksum: Buffer.alloc(20, 1),
};

describe(DesktopOfflineAlbumService.name, () => {
  const authService = { authorizeOfflineAlbumSession: vi.fn() };
  const album = {
    kind: AlbumKind.Album,
    isLocked: false,
    albumName: 'Trip',
    albumUsers: [{ role: AlbumUserRole.Owner, user: owner }],
  };
  const albums = { getById: vi.fn() };
  const members = { getAlbumAssets: vi.fn() };
  const media = { downloadOriginal: vi.fn() };
  const metadata = { get: vi.fn() };
  let service: DesktopOfflineAlbumService;

  beforeEach(() => {
    vi.resetAllMocks();
    authService.authorizeOfflineAlbumSession.mockResolvedValue(auth);
    albums.getById.mockResolvedValue(album);
    members.getAlbumAssets.mockResolvedValue([approved]);
    metadata.get.mockResolvedValue({ id: 'library' });
    service = new DesktopOfflineAlbumService(
      authService as never,
      albums as never,
      members as never,
      media as never,
      metadata as never,
    );
  });

  it('redeems a handoff once, only for the exact album and loopback endpoint', async () => {
    const { token } = await service.issue(auth, 'album', host);
    await expect(service.redeem('different', host, token)).rejects.toThrow(NotFoundException);
    await expect(service.redeem('album', '127.0.0.1:2284', token)).rejects.toThrow(NotFoundException);
    const access = await service.redeem('album', host, token);
    expect(access).toMatchObject({
      serverId: 'library',
      scopeId: expect.stringMatching(/^[a-f0-9]{64}$/),
      plan: {
        id: 'album',
        items: [
          {
            id: approved.id,
            name: approved.originalFileName,
            mime: 'image/jpeg',
            checksum: approved.checksum.toString('base64'),
          },
        ],
      },
    });
    expect(access).not.toHaveProperty('sessionId');
    await expect(service.redeem('album', host, token)).rejects.toThrow(NotFoundException);
    await expect(service.plan('different', host, access.grant)).rejects.toThrow(NotFoundException);
  });

  it('refuses a handoff if the browser session ended before redemption', async () => {
    const { token } = await service.issue(auth, 'album', host);
    authService.authorizeOfflineAlbumSession.mockResolvedValue(undefined);
    await expect(service.redeem('album', host, token)).rejects.toThrow(NotFoundException);
    authService.authorizeOfflineAlbumSession.mockResolvedValue(auth);
    await expect(service.redeem('album', host, token)).rejects.toThrow(NotFoundException);
  });

  it('refuses other credential types, nonowners, and locked albums', async () => {
    await expect(service.issue({ ...auth, sharedLink: {} as never }, 'album', host)).rejects.toThrow(NotFoundException);
    albums.getById.mockResolvedValue({ ...album, albumUsers: [{ role: AlbumUserRole.Editor, user: owner }] });
    await expect(service.issue(auth, 'album', host)).rejects.toThrow(NotFoundException);
    albums.getById.mockResolvedValue({ ...album, isLocked: true });
    await expect(service.issue(auth, 'album', host)).rejects.toThrow(NotFoundException);
  });

  it('admits only eligible own originals and rechecks the exact set and browser session', async () => {
    members.getAlbumAssets.mockResolvedValue([
      approved,
      { ...approved, id: 'locked', isLocked: true },
      { ...approved, id: 'hidden', visibility: AssetVisibility.Hidden },
      { ...approved, id: 'trash', deletedAt: new Date() },
      { ...approved, id: 'contributed', ownerId: 'other' },
    ]);
    const { token } = await service.issue(auth, 'album', host);
    const access = await service.redeem('album', host, token);
    expect(access.plan.items.map((item) => item.id)).toEqual([approved.id]);
    await expect(service.original('album', 'contributed', host, access.grant, vi.fn())).rejects.toThrow(
      NotFoundException,
    );
    expect(media.downloadOriginal).not.toHaveBeenCalled();

    members.getAlbumAssets.mockResolvedValue([]);
    await expect(service.original('album', approved.id, host, access.grant, vi.fn())).rejects.toThrow(
      NotFoundException,
    );
    await expect(service.plan('album', host, access.grant)).rejects.toThrow(NotFoundException);
    members.getAlbumAssets.mockResolvedValue([approved]);
    authService.authorizeOfflineAlbumSession.mockResolvedValue(undefined);
    await expect(service.plan('album', host, access.grant)).rejects.toThrow(NotFoundException);
  });

  it('keeps temporary service failure distinct from observed access loss', async () => {
    const { token } = await service.issue(auth, 'album', host);
    const access = await service.redeem('album', host, token);
    const temporary = new ServiceUnavailableException();
    authService.authorizeOfflineAlbumSession.mockRejectedValueOnce(temporary);
    await expect(service.plan('album', host, access.grant)).rejects.toBe(temporary);
    await expect(service.plan('album', host, access.grant)).resolves.toEqual(access.plan);
    albums.getById.mockResolvedValue({ ...album, isLocked: true });
    await expect(service.plan('album', host, access.grant)).rejects.toThrow(NotFoundException);
  });

  it('serves the selected unedited original and cuts off reads when the owner signs out', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'frameleaf-offline-album-'));
    const path = join(dir, 'Trip.jpg');
    try {
      await writeFile(path, 'fixture image');
      media.downloadOriginal.mockResolvedValue({ path, contentType: 'image/jpeg', viewerId: owner.id });
      const { token } = await service.issue(auth, 'album', host);
      const access = await service.redeem('album', host, token);
      const abort = vi.fn();
      const original = await service.original('album', approved.id, host, access.grant, abort);
      expect(media.downloadOriginal).toHaveBeenCalledWith(
        auth,
        approved.id,
        { edited: false },
        expect.any(AbortSignal),
      );
      expect(original.file.cacheControl).toEqual(CacheControl.PrivateWithoutCache);
      expect(original.file.viewerId).toBeUndefined();
      service.onSessionDelete({ sessionId: 'different' });
      expect(abort).not.toHaveBeenCalled();
      service.onSessionDelete({ sessionId: auth.session!.id });
      expect(abort).toHaveBeenCalledOnce();
      await expect(service.plan('album', host, access.grant)).rejects.toThrow(NotFoundException);
      original.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
