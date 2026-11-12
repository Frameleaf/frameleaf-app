import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { Mocked, vitest } from 'vitest';
import type {
  AlbumSuggestionRepository,
  CandidateRow,
  TripPhotoRow,
} from 'src/repositories/album-suggestion.repository.js';
import { AssetFileType, AssetVisibility, JobName, JobStatus } from 'src/enum.js';
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
const tripPhoto = (id: string, iso: string, visibility = AssetVisibility.Timeline): TripPhotoRow => ({
  id,
  visibility,
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
      getFileNames: vitest.fn().mockResolvedValue(
        new Map([
          ['a3', 'Campfire evening.jpg'],
          ['a4', 'Moraine Lake.jpg'],
        ]),
      ),
      getOutfits: vitest.fn().mockResolvedValue([]),
      getFacesWithoutOutfit: vitest.fn().mockResolvedValue([]),
      saveOutfits: vitest.fn(),
      dismiss: vitest.fn(),
      isAutoAdd: vitest.fn().mockResolvedValue(false),
      setAutoAdd: vitest.fn(),
      getAutoAddAlbumIds: vitest.fn().mockResolvedValue([]),
      getTimeSpan: vitest.fn().mockResolvedValue({ from: trip[0].takenAt, to: trip.at(-1)!.takenAt }),
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

    it('leaves out a date that would come after the photo was received', async () => {
      // Looks like the trip and has the album's people, so it is dated "during the trip": noon on Aug 11,
      // Mountain time (18:00 UTC). It was received at 15:00 UTC that day, inside the trip window.
      suggestions.getUndatedNeighbours.mockResolvedValue([{ assetId: 'wa', referenceId: 'a1', distance: 0.2 }]);
      suggestions.getCandidates.mockResolvedValue([
        candidate('wa', '2026-09-01T12:00:00', {
          originalFileName: 'IMG-20260811-WA0001.jpg',
          hasCameraDetails: false,
          latitude: null,
          longitude: null,
          place: null,
        }),
      ]);
      suggestions.getPeople.mockResolvedValue(
        new Map([
          ['a1', [{ id: 'p', name: 'Emma' }]],
          ['wa', [{ id: 'p', name: 'Emma' }]],
        ]),
      );
      const { needDate } = await sut.getSuggestions(auth, albumId);
      // WhatsApp names give only the day (read as its last second, UTC), so this one is kept...
      expect(needDate.map(({ precision, dateTimeOriginal }) => [precision, dateTimeOriginal])).toEqual([
        ['trip', '2026-08-11T12:00:00-06:00'],
      ]);

      // ...but a Facebook save at 15:00 UTC on Aug 11 is before that noon, so it is left out.
      suggestions.getCandidates.mockResolvedValue([
        candidate('wa', '2026-09-01T12:00:00', {
          originalFileName: 'FB_IMG_1786460400000.jpg',
          hasCameraDetails: false,
          latitude: null,
          longitude: null,
          place: null,
        }),
      ]);
      await expect(sut.getSuggestions(auth, albumId)).resolves.toMatchObject({ needDate: [] });
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

  describe('outfits', () => {
    const received = () =>
      candidate('wa', '2026-09-01T12:00:00', {
        originalFileName: 'IMG-20260901-WA0001.jpg',
        hasCameraDetails: false,
        latitude: null,
        longitude: null,
        place: null,
      });
    const outfit = (assetId: string, embedding: number[] | null, encoded = true) => ({
      assetId,
      personId: 'p',
      name: 'Emma',
      embedding: embedding && JSON.stringify(embedding),
      encoded,
    });

    beforeEach(() => {
      suggestions.getUndatedNeighbours.mockResolvedValue([{ assetId: 'wa', referenceId: 'a1', distance: 0.2 }]);
      suggestions.getCandidates.mockResolvedValue([received()]);
      suggestions.getPeople.mockImplementation((_, ids) =>
        Promise.resolve(new Map(ids.filter((id) => id !== 'a3').map((id) => [id, [{ id: 'p', name: 'Emma' }]]))),
      );
    });

    it('dates a photo to the day someone wore the same clothes', async () => {
      suggestions.getOutfits.mockResolvedValue([
        outfit('wa', [1, 0, 0]),
        outfit('a2', [0, 1, 0]),
        outfit('a4', [0.99, 0.05, 0]),
      ]);
      const { needDate } = await sut.getSuggestions(auth, albumId);
      expect(suggestions.getOutfits).toHaveBeenCalledWith(auth.user.id, ['wa', 'a1', 'a2', 'a4'], expect.any(String));
      expect(needDate).toEqual([
        expect.objectContaining({
          precision: 'day',
          dateTimeOriginal: '2026-08-14T12:00:00-06:00',
          reasons: [
            { kind: 'looks-like' },
            { kind: 'people', names: ['Emma'] },
            {
              kind: 'same-outfit',
              names: ['Emma'],
              assetId: 'a4',
              date: '2026-08-14',
              fileName: 'Moraine Lake.jpg',
            },
          ],
        }),
      ]);
      expect(mocks.job.queueAll).not.toHaveBeenCalled();
    });

    it('still suggests dates when outfit crops cannot be queued', async () => {
      suggestions.getOutfits.mockResolvedValue([outfit('wa', null, false), outfit('a4', [1, 0, 0])]);
      mocks.job.queueAll.mockRejectedValue(new Error('queue down'));
      await expect(sut.getSuggestions(auth, albumId)).resolves.toMatchObject({ needDate: [{ precision: 'trip' }] });
    });

    it('never waits on a Hidden trip photo, which is never cropped', async () => {
      suggestions.getTripPhotos.mockResolvedValue([
        ...trip,
        tripPhoto('a5', '2026-08-14T18:00:00', AssetVisibility.Hidden),
      ]);
      suggestions.getOutfits.mockResolvedValue([outfit('wa', [1, 0, 0]), outfit('a4', [0.99, 0.05, 0])]);
      const { needDate } = await sut.getSuggestions(auth, albumId);
      expect(suggestions.getOutfits).toHaveBeenCalledWith(auth.user.id, ['wa', 'a1', 'a2', 'a4'], expect.any(String));
      expect(needDate).toMatchObject([{ precision: 'day' }]);
    });

    it("waits for all of a person's trip crops before matching their outfit", async () => {
      suggestions.getOutfits.mockResolvedValue([
        outfit('wa', [1, 0, 0]),
        outfit('a2', null, false),
        outfit('a4', [0.99, 0.05, 0]),
      ]);
      const { needDate } = await sut.getSuggestions(auth, albumId);
      expect(needDate).toMatchObject([{ precision: 'trip' }]);
      expect(mocks.job.queueAll).toHaveBeenCalledWith([{ name: JobName.AlbumSuggestionOutfit, data: { id: 'a2' } }]);
    });

    it('queues outfit crops for photos that have none yet', async () => {
      suggestions.getOutfits.mockResolvedValue([outfit('wa', null, false), outfit('a4', [1, 0, 0])]);
      const { needDate } = await sut.getSuggestions(auth, albumId);
      expect(mocks.job.queueAll).toHaveBeenCalledWith([{ name: JobName.AlbumSuggestionOutfit, data: { id: 'wa' } }]);
      expect(needDate).toMatchObject([{ precision: 'trip' }]);
    });

    it('looks for no outfits when nobody in the photo is in the album', async () => {
      suggestions.getPeople.mockResolvedValue(new Map());
      await sut.getSuggestions(auth, albumId);
      expect(suggestions.getOutfits).not.toHaveBeenCalled();
    });

    it('crops the torso under each face and embeds it with the CLIP model', async () => {
      mocks.assetJob.getForClipEncoding.mockResolvedValue({
        id: 'wa',
        ownerId: auth.user.id,
        visibility: AssetVisibility.Timeline,
        // Face boxes are in the unedited photo's space, so the unedited preview is cropped.
        files: [
          { id: 'f', path: '/preview.jpeg', type: AssetFileType.Preview, isEdited: false, isProgressive: false },
          { id: 'e', path: '/edited.jpeg', type: AssetFileType.Preview, isEdited: true, isProgressive: false },
        ],
      } as never);
      suggestions.getFacesWithoutOutfit.mockResolvedValue([
        // Detected on a 1000x750 image; the preview is 500x375.
        { id: 'face', imageWidth: 1000, imageHeight: 750, x1: 400, y1: 100, x2: 480, y2: 200 },
        { id: 'edge', imageWidth: 1000, imageHeight: 750, x1: 400, y1: 650, x2: 480, y2: 740 },
      ]);
      mocks.media.decodeImage.mockResolvedValue({
        data: Buffer.from(''),
        info: { width: 500, height: 375, channels: 3 } as never,
      });
      mocks.machineLearning.encodeImage.mockResolvedValue('[0.1,0.2]');

      await expect(sut.handleOutfit({ id: 'wa' })).resolves.toBe(JobStatus.Success);
      expect(mocks.media.decodeImage).toHaveBeenCalledWith('/preview.jpeg', expect.anything());
      expect(mocks.media.generateThumbnail).toHaveBeenCalledOnce();
      expect(mocks.media.generateThumbnail).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          edits: [{ action: 'crop', parameters: { x: 160, y: 100, width: 120, height: 150 } }],
        }),
        expect.stringMatching(/face\.jpg$/),
      );
      expect(suggestions.saveOutfits).toHaveBeenCalledWith([
        { faceId: 'face', modelName: expect.any(String), embedding: '[0.1,0.2]' },
        { faceId: 'edge', modelName: expect.any(String), embedding: null },
      ]);
    });

    it('skips a photo whose faces all have outfits', async () => {
      mocks.assetJob.getForClipEncoding.mockResolvedValue({
        id: 'wa',
        ownerId: auth.user.id,
        visibility: AssetVisibility.Timeline,
        files: [{ id: 'f', path: '/preview.jpeg', type: AssetFileType.Preview, isEdited: false, isProgressive: false }],
      } as never);
      await expect(sut.handleOutfit({ id: 'wa' })).resolves.toBe(JobStatus.Skipped);
      expect(mocks.media.decodeImage).not.toHaveBeenCalled();
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

    describe('connected apps (FL-1490)', () => {
      const app = {
        ...auth,
        oauthApp: {
          clientId: 'client',
          clientName: 'Test app',
          grantId: 'grant',
          scopes: ['albums:write'],
          resource: null,
        },
      } as typeof auth;

      it('refuses an app turning it on for a Locked album', async () => {
        mocks.album.getById.mockResolvedValue({ isLocked: true } as never);
        await expect(sut.setAutoAdd(app, albumId, { enabled: true })).rejects.toBeInstanceOf(ForbiddenException);
        expect(suggestions.setAutoAdd).not.toHaveBeenCalled();
      });

      it('lets an app turn it on for an unlocked album, and off for a Locked one', async () => {
        mocks.album.getById.mockResolvedValue({ isLocked: false } as never);
        await sut.setAutoAdd(app, albumId, { enabled: true });
        mocks.album.getById.mockResolvedValue({ isLocked: true } as never);
        await sut.setAutoAdd(app, albumId, { enabled: false });
        expect(suggestions.setAutoAdd.mock.calls).toEqual([
          [albumId, auth.user.id, true],
          [albumId, auth.user.id, false],
        ]);
      });

      it('leaves a signed-in person free to turn it on for their Locked album', async () => {
        mocks.album.getById.mockResolvedValue({ isLocked: true } as never);
        await sut.setAutoAdd(auth, albumId, { enabled: true });
        expect(suggestions.setAutoAdd).toHaveBeenCalledWith(albumId, auth.user.id, true);
      });
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

      // A saved or received photo waits for review even when it was saved during the trip, there.
      suggestions.getCandidates.mockResolvedValue([
        candidate('fb', '2026-08-13T18:00:00', {
          originalFileName: 'FB_IMG_1786640000000.jpg',
          hasCameraDetails: false,
        }),
      ]);
      await sut.handleAutoAdd({ id: 'fb' });
      expect(addAssets).not.toHaveBeenCalled();
    });

    it('does not read the album for photos taken far from the trip', async () => {
      const addAssets = vitest.spyOn(AlbumService.prototype, 'addAssets').mockResolvedValue([]);
      mocks.asset.getById.mockResolvedValue({ id: 'later', ownerId: auth.user.id } as never);
      mocks.user.get.mockResolvedValue({ ...auth.user, quotaUsageInBytes: 0, quotaSizeInBytes: null } as never);
      suggestions.getAutoAddAlbumIds.mockResolvedValue([albumId]);
      suggestions.getCandidates.mockResolvedValue([candidate('later', '2026-12-25T18:00:00')]);
      await sut.handleAutoAdd({ id: 'later' });
      expect(suggestions.getTripPhotos).not.toHaveBeenCalled();
      expect(addAssets).not.toHaveBeenCalled();
    });
  });
});
