import { Mocked, vitest } from 'vitest';
import type { AlbumSuggestionRepository, HealPhotoRow } from 'src/repositories/album-suggestion.repository.js';
import { MAX_HEAL_PHOTOS } from 'src/repositories/album-suggestion.repository.js';
import { AlbumDateHealService } from 'src/services/album-date-heal.service.js';
import { factory, newUuid } from 'test/small.factory.js';
import { ServiceMocks, newTestService } from 'test/utils.js';

const day = (index: number) => new Date(`2019-07-${String(3 + index).padStart(2, '0')}T12:00:00Z`);

describe(AlbumDateHealService.name, () => {
  let sut: AlbumDateHealService;
  let mocks: ServiceMocks;
  let suggestions: Mocked<AlbumSuggestionRepository>;
  const auth = factory.auth();
  const albumId = newUuid();
  const lostId = newUuid();

  const row = (id: string, overrides: Partial<HealPhotoRow> = {}): HealPhotoRow => ({
    id,
    ownerId: auth.user.id,
    originalFileName: `${id}.jpg`,
    takenAt: day(0),
    localDateTime: day(0),
    hasCameraDetails: true,
    dateEstimated: false,
    dateSet: false,
    isLocked: false,
    ...overrides,
  });
  const album = () => [
    ...[0, 1, 2, 3, 4, 5].map((index) => row(`dated-${index}`, { takenAt: day(index), localDateTime: day(index) })),
    row(lostId, {
      originalFileName: 'x.jpg',
      hasCameraDetails: false,
      takenAt: new Date('2023-02-14T10:00:00Z'),
      localDateTime: new Date('2023-02-14T10:00:00Z'),
    }),
  ];

  beforeEach(() => {
    ({ sut, mocks } = newTestService(AlbumDateHealService));
    suggestions = {
      getHealPhotos: vitest.fn().mockResolvedValue(album()),
    } as unknown as Mocked<AlbumSuggestionRepository>;
    Object.assign(mocks.album, { suggestions });
    mocks.access.album.checkOwnerAccess.mockResolvedValue(new Set([albumId]));
  });

  it('reads the album for the session, passing the viewer as Locked owner only when elevated', async () => {
    await sut.getLostDates(auth, albumId);
    expect(suggestions.getHealPhotos).toHaveBeenCalledWith(albumId, auth.user.id, undefined, expect.anything());

    const pin = factory.auth({ session: { hasElevatedPermission: true } });
    mocks.access.album.checkOwnerAccess.mockResolvedValue(new Set([albumId]));
    await sut.getLostDates(pin, albumId);
    expect(suggestions.getHealPhotos).toHaveBeenLastCalledWith(albumId, pin.user.id, pin.user.id, expect.anything());
  });

  it('treats an album too large to read as too wide', async () => {
    suggestions.getHealPhotos.mockResolvedValue(Array.from({ length: MAX_HEAL_PHOTOS + 1 }, () => row('a')));
    await expect(sut.getLostDates(auth, albumId)).resolves.toMatchObject({ eligible: false, reason: 'wide' });
  });

  it('needs album access before reading anything', async () => {
    mocks.access.album.checkOwnerAccess.mockResolvedValue(new Set());
    await expect(sut.getLostDates(auth, albumId)).rejects.toThrow();
    expect(suggestions.getHealPhotos).not.toHaveBeenCalled();
  });

  it('heals nothing, opens no run and writes nothing when no approved photo qualifies', async () => {
    await expect(sut.heal(auth, { albums: [{ albumId, assetIds: ['dated-0'] }] })).resolves.toEqual({
      runId: null,
      healed: 0,
      skipped: 1,
    });
    expect(mocks.partnerOrigin.withOriginEdit).not.toHaveBeenCalled();
    expect(mocks.albumChangeRun.createRun).not.toHaveBeenCalled();
  });

  it('counts a repeated id once', async () => {
    suggestions.getHealPhotos.mockResolvedValue([]);
    await expect(sut.heal(auth, { albums: [{ albumId, assetIds: ['a', 'a', 'b'] }] })).resolves.toMatchObject({
      skipped: 2,
    });
  });

  it('plans from a fresh read and keeps the date the server worked out', async () => {
    const plan = await sut.plan(auth, { albums: [{ albumId, assetIds: [lostId] }] });
    expect(plan).toEqual([
      expect.objectContaining({
        albumId,
        assetId: lostId,
        expectedTakenAt: new Date('2023-02-14T10:00:00Z'),
        dateTimeOriginal: expect.stringMatching(/^2019-07-06T12:00:00\+00:00$/),
        isLocked: false,
      }),
    ]);
  });
});
