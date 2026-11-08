import { BadRequestException } from '@nestjs/common';
import { AlbumKind, AlbumUserRole } from 'src/enum.js';
import { AlbumMergeService, chooseMergeWinner } from 'src/services/album-merge.service.js';
import { factory, newUuid } from 'test/small.factory.js';
import { newTestService, ServiceMocks } from 'test/utils.js';

const older = { id: 'b-older', createdAt: new Date('2020-01-01T00:00:00Z') };
const newer = { id: 'a-newer', createdAt: new Date('2024-01-01T00:00:00Z') };

describe(chooseMergeWinner.name, () => {
  it('picks the album with the most photos, whichever it was started from', () => {
    const counts = new Map([
      [older.id, 2],
      [newer.id, 5],
    ]);
    expect(chooseMergeWinner(older, newer, counts)).toEqual({ winner: newer, loser: older });
    expect(chooseMergeWinner(newer, older, counts)).toEqual({ winner: newer, loser: older });
  });

  it('gives a tie to the older album', () => {
    const counts = new Map([
      [older.id, 3],
      [newer.id, 3],
    ]);
    expect(chooseMergeWinner(newer, older, counts)).toEqual({ winner: older, loser: newer });
  });

  it('treats an album with no counted photos as empty', () => {
    expect(chooseMergeWinner(older, newer, new Map([[newer.id, 1]]))).toEqual({ winner: newer, loser: older });
    expect(chooseMergeWinner(newer, older, new Map())).toEqual({ winner: older, loser: newer });
  });

  it('settles a tie in age by id, so both directions agree', () => {
    const a = { id: 'a', createdAt: older.createdAt };
    const b = { id: 'b', createdAt: older.createdAt };
    expect(chooseMergeWinner(a, b, new Map())).toEqual({ winner: a, loser: b });
    expect(chooseMergeWinner(b, a, new Map())).toEqual({ winner: a, loser: b });
  });
});

describe(AlbumMergeService.name, () => {
  let sut: AlbumMergeService;
  let mocks: ServiceMocks;
  const auth = factory.auth();
  const [firstId, secondId] = [newUuid(), newUuid()];

  const album = (id: string, overrides: Record<string, unknown> = {}) =>
    ({
      id,
      kind: AlbumKind.Album,
      createdAt: older.createdAt,
      albumUsers: [{ role: AlbumUserRole.Owner, user: { id: auth.user.id } }],
      sharedLinks: [],
      ...overrides,
    }) as never;

  const allow = (...albums: unknown[]) => {
    mocks.access.album.checkOwnerAccess.mockResolvedValue(new Set([firstId, secondId]));
    for (const value of albums) {
      mocks.album.getById.mockResolvedValueOnce(value as never);
    }
  };

  beforeEach(() => {
    ({ sut, mocks } = newTestService(AlbumMergeService));
    mocks.smartAlbum.getSmartBackedAlbumKinds.mockResolvedValue(new Map());
    mocks.classification.getRuleAlbumIds.mockResolvedValue(new Set());
    mocks.partnerOrigin.getOriginLabels.mockResolvedValue(new Map());
    mocks.album.getOwnerAssetCounts.mockResolvedValue(new Map());
    mocks.album.getMergeCounts.mockResolvedValue({ total: 0, inBoth: 0 });
    mocks.album.getLinkedToSpaceIds.mockResolvedValue(new Set());
  });

  it('refuses the same album without looking anything up', async () => {
    await expect(sut.getPreview(auth, firstId, firstId)).rejects.toBeInstanceOf(BadRequestException);
    expect(mocks.access.album.checkOwnerAccess).not.toHaveBeenCalled();
  });

  it('refuses an album the person does not own', async () => {
    mocks.access.album.checkOwnerAccess.mockResolvedValue(new Set([firstId]));

    await expect(sut.getPreview(auth, firstId, secondId)).rejects.toBeInstanceOf(BadRequestException);
    expect(mocks.album.getById).not.toHaveBeenCalled();
  });

  it.each([AlbumKind.Collection, AlbumKind.Space])('refuses a %s', async (kind) => {
    allow(album(firstId), album(secondId, { kind }));

    await expect(sut.getPreview(auth, firstId, secondId)).rejects.toThrow('Only albums can be merged');
  });

  it('refuses a built-in smart album', async () => {
    allow(album(firstId), album(secondId));
    mocks.smartAlbum.getSmartBackedAlbumKinds.mockResolvedValue(new Map([[secondId, 'screenshots']]));

    await expect(sut.getPreview(auth, firstId, secondId)).rejects.toThrow('Smart albums');
  });

  it('refuses a rule-based smart album', async () => {
    allow(album(firstId), album(secondId));
    mocks.classification.getRuleAlbumIds.mockResolvedValue(new Set([firstId]));

    await expect(sut.getPreview(auth, firstId, secondId)).rejects.toThrow('Smart albums');
  });

  it('refuses a partner copy', async () => {
    allow(album(firstId), album(secondId));
    mocks.partnerOrigin.getOriginLabels.mockResolvedValue(
      new Map([[secondId, { rootOwnerId: newUuid(), rootOwnerName: 'Sam' }]]),
    );

    await expect(sut.getPreview(auth, firstId, secondId)).rejects.toThrow('partner');
  });

  it('counts for the winner as the owner, and for the total as this session', async () => {
    allow(album(firstId), album(secondId));
    mocks.album.getOwnerAssetCounts.mockResolvedValue(new Map([[secondId, 4]]));
    mocks.album.getMergeCounts.mockResolvedValue({ total: 2, inBoth: 1 });

    await expect(sut.getPreview(auth, firstId, secondId)).resolves.toEqual({
      winnerId: secondId,
      total: 2,
      inBoth: 1,
      winnerShared: false,
      loserShared: false,
    });
    expect(mocks.album.getOwnerAssetCounts).toHaveBeenCalledWith([firstId, secondId], auth.user.id);
    expect(mocks.album.getMergeCounts.mock.calls[0][2]).not.toHaveProperty('lockedOwnerId');
  });

  it('calls an album shared when it has members, a public link, or a shared space', async () => {
    const member = { role: AlbumUserRole.Viewer, user: { id: newUuid() } };
    allow(
      album(firstId, { albumUsers: [{ role: AlbumUserRole.Owner, user: { id: auth.user.id } }, member] }),
      album(secondId),
    );
    mocks.album.getOwnerAssetCounts.mockResolvedValue(new Map([[firstId, 2]]));
    await expect(sut.getPreview(auth, firstId, secondId)).resolves.toMatchObject({
      winnerShared: true,
      loserShared: false,
    });

    allow(album(firstId), album(secondId, { sharedLinks: [{ id: 'link' }] }));
    await expect(sut.getPreview(auth, firstId, secondId)).resolves.toMatchObject({ loserShared: true });

    allow(album(firstId), album(secondId));
    mocks.album.getLinkedToSpaceIds.mockResolvedValue(new Set([secondId]));
    await expect(sut.getPreview(auth, firstId, secondId)).resolves.toMatchObject({ loserShared: true });
  });
});
