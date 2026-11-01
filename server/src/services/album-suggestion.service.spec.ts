import { BadRequestException } from '@nestjs/common';
import { Mocked, vitest } from 'vitest';
import type {
  AlbumSuggestionRepository,
  CandidateRow,
  TripPhotoRow,
} from 'src/repositories/album-suggestion.repository.js';
import { JobName, JobStatus } from 'src/enum.js';
import { AlbumSuggestionService } from 'src/services/album-suggestion.service.js';
import { AlbumService } from 'src/services/album.service.js';
import { authStub } from 'test/fixtures/auth.stub.js';
import { newUuid } from 'test/small.factory.js';
import { ServiceMocks, newTestService } from 'test/utils.js';

const LAKE = { latitude: 51.4254, longitude: -116.1773 };
const hours = (iso: string, offset = -6) => ({
  takenAt: new Date(`${iso}Z`),
  localDateTime: new Date(new Date(`${iso}Z`).getTime() + offset * 3_600_000),
});
const tripPhoto = (id: string, iso: string): TripPhotoRow => ({
  id,
  ...hours(iso),
  ...LAKE,
  place: 'Lake Louise',
  make: 'Apple',
  model: 'iPhone 16 Pro',
});
const candidate = (id: string, iso: string, extra: Partial<CandidateRow> = {}): CandidateRow => ({
  ...tripPhoto(id, iso),
  make: 'Google',
  model: 'Pixel 9',
  originalFileName: `${id}.jpg`,
  hasCameraDetails: true,
  ...extra,
});

describe(AlbumSuggestionService.name, () => {
  let sut: AlbumSuggestionService;
  let mocks: ServiceMocks;
  let suggestions: Mocked<AlbumSuggestionRepository>;
  const albumId = newUuid();
  const auth = authStub.admin;
  const trip = [
    tripPhoto('a1', '2026-08-11T18:00:00'),
    tripPhoto('a2', '2026-08-12T16:00:00'),
    tripPhoto('a3', '2026-08-13T20:00:00'),
    tripPhoto('a4', '2026-08-14T17:00:00'),
  ];

  beforeEach(() => {
    ({ sut, mocks } = newTestService(AlbumSuggestionService));
    suggestions = {
      getTripPhotos: vitest.fn().mockResolvedValue(trip),
      getTripCandidates: vitest.fn().mockResolvedValue([]),
      getCandidates: vitest.fn().mockResolvedValue([]),
      getVisualDistances: vitest.fn().mockResolvedValue(new Map()),
      getUndatedNeighbours: vitest.fn().mockResolvedValue([]),
      getPeople: vitest.fn().mockResolvedValue(new Map()),
      getFileNames: vitest.fn().mockResolvedValue(new Map([['a3', 'Campfire evening.jpg']])),
      dismiss: vitest.fn(),
      isAutoAdd: vitest.fn().mockResolvedValue(false),
      setAutoAdd: vitest.fn(),
      getAutoAddAlbumIds: vitest.fn().mockResolvedValue([]),
    } as unknown as Mocked<AlbumSuggestionRepository>;
    Object.assign(mocks.album, { suggestions });
    mocks.access.album.checkOwnerAccess.mockResolvedValue(new Set([albumId]));
  });

  describe('getSuggestions', () => {
    it('requires permission to add to the album', async () => {
      mocks.access.album.checkOwnerAccess.mockResolvedValue(new Set());
      mocks.access.album.checkSharedAlbumAccess.mockResolvedValue(new Set());
      await expect(sut.getSuggestions(auth, albumId)).rejects.toBeInstanceOf(BadRequestException);
      expect(suggestions.getTripPhotos).not.toHaveBeenCalled();
    });

    it('suggests nothing for an album that is not a trip', async () => {
      suggestions.getTripPhotos.mockResolvedValue([trip[0]]);
      await expect(sut.getSuggestions(auth, albumId)).resolves.toEqual({
        autoAdd: false,
        tripStart: null,
        tripEnd: null,
        places: [],
        fromTrip: [],
        needDate: [],
      });
    });

    it('describes the trip and groups photos taken during it', async () => {
      suggestions.getTripCandidates.mockResolvedValue([
        candidate('here', '2026-08-13T18:00:00'),
        candidate('nowhere', '2026-08-13T19:00:00', { latitude: null, longitude: null, place: null }),
        candidate('phone', '2026-08-12T19:00:00', {
          latitude: null,
          longitude: null,
          place: null,
          make: 'Apple',
          model: 'iPhone 16 Pro',
        }),
      ]);
      const result = await sut.getSuggestions(auth, albumId);
      expect(result).toMatchObject({ tripStart: '2026-08-11', tripEnd: '2026-08-14', places: ['Lake Louise'] });
      expect(result.fromTrip).toEqual([
        {
          assetId: 'here',
          fileName: 'here.jpg',
          likely: true,
          reasons: [
            { kind: 'during-trip', date: '2026-08-13' },
            { kind: 'place', place: 'Lake Louise' },
          ],
        },
        {
          assetId: 'phone',
          fileName: 'phone.jpg',
          likely: false,
          reasons: [{ kind: 'during-trip', date: '2026-08-12' }, { kind: 'same-camera' }],
        },
      ]);
      expect(suggestions.getVisualDistances).toHaveBeenCalledWith(['nowhere', 'phone'], ['a1', 'a2', 'a3', 'a4']);
    });

    it('suggests a date for a saved copy of an album photo', async () => {
      suggestions.getUndatedNeighbours.mockResolvedValue([
        { assetId: 'fb', referenceId: 'a3', distance: 0.02 },
        { assetId: 'fb', referenceId: 'a4', distance: 0.05 },
      ]);
      suggestions.getCandidates.mockResolvedValue([
        candidate('fb', '2026-09-04T16:53:32', {
          originalFileName: 'FB_IMG_1788540812000.jpg',
          hasCameraDetails: false,
          latitude: null,
          longitude: null,
          place: null,
        }),
      ]);
      const { needDate } = await sut.getSuggestions(auth, albumId);
      expect(needDate).toEqual([
        {
          assetId: 'fb',
          fileName: 'FB_IMG_1788540812000.jpg',
          source: 'facebook',
          fileDate: '2026-09-04',
          savedAt: '2026-09-04T16:53:32.000Z',
          precision: 'moment',
          dateTimeOriginal: '2026-08-13T14:00:00-06:00',
          reasons: [{ kind: 'near-identical', assetId: 'a3', date: '2026-08-13', fileName: 'Campfire evening.jpg' }],
        },
      ]);
    });

    it('leaves out a photo saved before the trip started', async () => {
      suggestions.getUndatedNeighbours.mockResolvedValue([
        { assetId: 'wa', referenceId: 'a3', distance: 0.02 },
        { assetId: 'wa', referenceId: 'a4', distance: 0.03 },
      ]);
      suggestions.getCandidates.mockResolvedValue([
        candidate('wa', '2026-08-01T12:00:00', {
          originalFileName: 'IMG-20260801-WA0001.jpg',
          hasCameraDetails: false,
        }),
      ]);
      await expect(sut.getSuggestions(auth, albumId)).resolves.toMatchObject({ needDate: [] });
    });
  });

  describe('dismiss', () => {
    it('only dismisses your own photos', async () => {
      const ids = [newUuid()];
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set(ids));
      await sut.dismiss(auth, albumId, { ids });
      expect(suggestions.dismiss).toHaveBeenCalledWith(albumId, ids);

      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set());
      await expect(sut.dismiss(auth, albumId, { ids })).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('auto-add', () => {
    it('stores the choice per person', async () => {
      await sut.setAutoAdd(auth, albumId, { enabled: true });
      expect(suggestions.setAutoAdd).toHaveBeenCalledWith(albumId, auth.user.id, true);
    });

    it('queues a check only for people who turned it on', async () => {
      await sut.onMetadataExtracted({ assetId: 'x', userId: auth.user.id });
      expect(mocks.job.queue).not.toHaveBeenCalled();
      suggestions.getAutoAddAlbumIds.mockResolvedValue([albumId]);
      await sut.onMetadataExtracted({ assetId: 'x', userId: auth.user.id });
      expect(mocks.job.queue).toHaveBeenCalledWith({ name: JobName.AlbumSuggestionAutoAdd, data: { id: 'x' } });
    });

    it('adds only very likely photos, through the normal album path', async () => {
      const addAssets = vitest.spyOn(AlbumService.prototype, 'addAssets').mockResolvedValue([]);
      mocks.asset.getById.mockResolvedValue({ id: 'here', ownerId: auth.user.id } as never);
      mocks.user.get.mockResolvedValue({ ...auth.user, quotaUsageInBytes: 0, quotaSizeInBytes: null } as never);
      suggestions.getAutoAddAlbumIds.mockResolvedValue([albumId]);
      suggestions.getCandidates.mockResolvedValue([candidate('here', '2026-08-13T18:00:00')]);

      await expect(sut.handleAutoAdd({ id: 'here' })).resolves.toBe(JobStatus.Success);
      expect(addAssets).toHaveBeenCalledWith(
        expect.objectContaining({ user: expect.objectContaining({ id: auth.user.id }) }),
        albumId,
        { ids: ['here'] },
      );

      addAssets.mockClear();
      suggestions.getCandidates.mockResolvedValue([
        candidate('phone', '2026-08-12T19:00:00', {
          latitude: null,
          longitude: null,
          place: null,
          make: 'Apple',
          model: 'iPhone 16 Pro',
        }),
      ]);
      await sut.handleAutoAdd({ id: 'phone' });
      expect(addAssets).not.toHaveBeenCalled();
    });
  });
});
