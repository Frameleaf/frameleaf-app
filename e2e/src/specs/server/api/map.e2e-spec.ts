import { AssetVisibility, LoginResponseDto } from '@immich/sdk';
import { readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { Socket } from 'socket.io-client';
import { createUserDto } from 'src/fixtures.js';
import { app, testAssetDir, utils } from 'src/utils.js';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const countOf = (buckets: { count: number }[]) => buckets.reduce((sum, bucket) => sum + bucket.count, 0);

describe('/map', () => {
  let websocket: Socket;
  let partnerWebsocket: Socket;
  let admin: LoginResponseDto;
  let partner: LoginResponseDto;
  let partnerArchivedAssetId: string;
  let adminArchivedAssetId: string;

  beforeAll(async () => {
    await utils.resetDatabase();
    admin = await utils.adminSetup({ onboarding: false });
    partner = await utils.userSetup(admin.accessToken, createUserDto.user1);

    websocket = await utils.connectWebsocket(admin.accessToken);
    partnerWebsocket = await utils.connectWebsocket(partner.accessToken);

    const adminFiles = ['formats/heic/IMG_2682.heic', 'metadata/gps-position/thompson-springs.jpg'];
    const adminArchivedFile = 'metadata/dates/datetimeoriginal-gps.jpg';
    const partnerFile = 'metadata/gps-position/thompson-springs.jpg';
    utils.resetEvents();
    const uploadFile = async (accessToken: string, input: string) => {
      const filepath = join(testAssetDir, input);
      const { id } = await utils.createAsset(accessToken, {
        assetData: { bytes: await readFile(filepath), filename: basename(filepath) },
      });
      await utils.waitForWebsocketEvent({ event: 'assetUpload', id });
      return id;
    };
    await Promise.all(adminFiles.map((f) => uploadFile(admin.accessToken, f)));
    [adminArchivedAssetId, partnerArchivedAssetId] = await Promise.all([
      uploadFile(admin.accessToken, adminArchivedFile),
      uploadFile(partner.accessToken, partnerFile),
    ]);

    await Promise.all([
      utils.archiveAssets(admin.accessToken, [adminArchivedAssetId]),
      utils.archiveAssets(partner.accessToken, [partnerArchivedAssetId]),
      utils.createPartner(partner.accessToken, admin.userId),
    ]);
  });

  afterAll(() => {
    utils.disconnectWebsocket(websocket);
    utils.disconnectWebsocket(partnerWebsocket);
  });

  describe('GET /map/markers', () => {
    it('should get map markers for all non-archived assets', async () => {
      const { status, body } = await request(app)
        .get('/map/markers')
        .query({ visibility: AssetVisibility.Timeline })
        .set('Authorization', `Bearer ${admin.accessToken}`);

      expect(status).toBe(200);
      expect(body).toHaveLength(2);
      expect(body).toEqual([
        {
          city: 'Palisade',
          country: 'United States of America',
          id: expect.any(String),
          lat: expect.closeTo(39.115),
          lon: expect.closeTo(-108.400968),
          state: 'Colorado',
          originalFileName: expect.any(String),
          type: 'IMAGE',
          fileCreatedAt: expect.any(String),
          localDateTime: expect.any(String),
        },
        {
          city: 'Ralston',
          country: 'United States of America',
          id: expect.any(String),
          lat: expect.closeTo(41.2203),
          lon: expect.closeTo(-96.071625),
          state: 'Nebraska',
          originalFileName: expect.any(String),
          type: 'IMAGE',
          fileCreatedAt: expect.any(String),
          localDateTime: expect.any(String),
        },
      ]);
    });

    it('should not expose partner archived asset locations', async () => {
      const { status, body } = await request(app)
        .get('/map/markers')
        .query({ withPartners: true, isArchived: true })
        .set('Authorization', `Bearer ${admin.accessToken}`);

      expect(status).toBe(200);
      const ids = body.map((m: { id: string }) => m.id);
      expect(ids).not.toContain(partnerArchivedAssetId);
      expect(ids).toContain(adminArchivedAssetId);
    });

    it('should include own archived asset locations', async () => {
      const { status, body } = await request(app)
        .get('/map/markers')
        .query({ isArchived: true })
        .set('Authorization', `Bearer ${admin.accessToken}`);

      expect(status).toBe(200);
      expect(body.map((m: { id: string }) => m.id)).toContain(adminArchivedAssetId);
    });

    it('should get all map markers', async () => {
      const { status, body } = await request(app)
        .get('/map/markers')
        .set('Authorization', `Bearer ${admin.accessToken}`);

      expect(status).toBe(200);
      expect(body).toEqual([
        {
          city: 'Palisade',
          country: 'United States of America',
          id: expect.any(String),
          lat: expect.closeTo(39.115),
          lon: expect.closeTo(-108.400968),
          state: 'Colorado',
          originalFileName: expect.any(String),
          type: 'IMAGE',
          fileCreatedAt: expect.any(String),
          localDateTime: expect.any(String),
        },
        {
          city: 'Ralston',
          country: 'United States of America',
          id: expect.any(String),
          lat: expect.closeTo(41.2203),
          lon: expect.closeTo(-96.071625),
          state: 'Nebraska',
          originalFileName: expect.any(String),
          type: 'IMAGE',
          fileCreatedAt: expect.any(String),
          localDateTime: expect.any(String),
        },
      ]);
    });
  });

  describe('GET /map/statistics (FL-51)', () => {
    it("counts the viewer's own archived items and never a partner's archived ones", async () => {
      const { status, body } = await request(app)
        .get('/map/statistics')
        .set('Authorization', `Bearer ${admin.accessToken}`);

      expect(status).toBe(200);
      expect(body).toEqual({ archived: 1, partner: 0, unlocated: 0 });
    });

    it('requires authentication', async () => {
      const { status } = await request(app).get('/map/statistics');
      expect(status).toBe(401);
    });
  });

  // FL-326: a partner's items reach the viewer only as the viewer's own copies, so the partner's own
  // rows never show on the viewer's map, counts or bounds, shared or not
  describe('partner items and bounds (FL-51, FL-326)', () => {
    it("never shows a partner's own located item in the markers, the counts or the bounds", async () => {
      const { id: partnerLocatedId } = await utils.createAsset(partner.accessToken, {
        assetData: {
          // the admin already holds this file (archived), so the partnership makes no copy of it
          bytes: await readFile(join(testAssetDir, 'metadata/dates/datetimeoriginal-gps.jpg')),
          filename: 'datetimeoriginal-gps.jpg',
        },
      });
      await utils.waitForWebsocketEvent({ event: 'assetUpload', id: partnerLocatedId });

      const markerIds = async () => {
        const { body } = await request(app)
          .get('/map/markers')
          .query({ withPartners: true })
          .set('Authorization', `Bearer ${admin.accessToken}`);
        return body.map((marker: { id: string }) => marker.id);
      };
      const statistics = async () => {
        const { body } = await request(app).get('/map/statistics').set('Authorization', `Bearer ${admin.accessToken}`);
        return body;
      };
      const bucketsInBounds = async (bbox: string) => {
        const { body } = await request(app)
          .get('/timeline/buckets')
          .query({ bbox, visibility: AssetVisibility.Timeline })
          .set('Authorization', `Bearer ${admin.accessToken}`);
        return body as { count: number }[];
      };
      const expectOnlyOwn = async () => {
        expect(await markerIds()).not.toContain(partnerLocatedId);
        expect(await statistics()).toEqual(expect.objectContaining({ partner: 0 }));
        // the whole world holds the admin's two located timeline items; an empty sea holds nothing,
        // and archived items stay out of the bounds as they stay off the timeline
        expect(countOf(await bucketsInBounds('-180,-90,180,90'))).toBe(2);
        expect(await bucketsInBounds('-150,-65,-140,-55')).toEqual([]);
      };

      await expectOnlyOwn();
      const { status } = await request(app)
        .delete(`/partners/${admin.userId}`)
        .set('Authorization', `Bearer ${partner.accessToken}`);
      expect(status).toBe(204);
      await expectOnlyOwn();
    });
  });

  describe('batch location changes (FL-51)', () => {
    it('refuses invalid coordinates and foreign items, and the markers follow a move and a removal', async () => {
      const markers = async () => {
        const { body } = await request(app).get('/map/markers').set('Authorization', `Bearer ${admin.accessToken}`);
        return body as { id: string; lat: number; lon: number }[];
      };
      const [first, second] = await markers();
      const put = (body: object) =>
        request(app).put('/assets').set('Authorization', `Bearer ${admin.accessToken}`).send(body);

      for (const coordinates of [
        { latitude: 91, longitude: 0 },
        { latitude: 0, longitude: -181 },
        { latitude: 10 },
        { latitude: null, longitude: 10 },
      ]) {
        const { status } = await put({ ids: [first.id], ...coordinates });
        expect(status).toBe(400);
      }
      // the partner's archived item is not the admin's to change: the whole batch is refused
      const { status: foreign } = await put({ ids: [first.id, partnerArchivedAssetId], latitude: 1, longitude: 2 });
      expect(foreign).toBe(400);
      expect(await markers()).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: first.id, lat: first.lat })]),
      );

      const { status: moved } = await put({ ids: [first.id], latitude: 12.5, longitude: 34.5 });
      expect(moved).toBe(204);
      const { status: removed } = await put({ ids: [second.id], latitude: null, longitude: null });
      expect(removed).toBe(204);

      const after = await markers();
      expect(after).toContainEqual(expect.objectContaining({ id: first.id, lat: 12.5, lon: 34.5 }));
      expect(after.map(({ id }) => id)).not.toContain(second.id);
      const { body } = await request(app).get('/map/statistics').set('Authorization', `Bearer ${admin.accessToken}`);
      expect(body).toEqual(expect.objectContaining({ unlocated: 1 }));
    });
  });

  describe('GET /map/reverse-geocode', () => {
    const reverseGeocodeTestCases = [
      {
        name: 'Vaucluse',
        lat: -33.85897705866313,
        lon: 151.27849073027048,
        results: [{ city: 'Vaucluse', state: 'New South Wales', country: 'Australia' }],
      },
      {
        name: 'Ravenhall',
        lat: -37.76573239917475,
        lon: 144.7524531648833,
        results: [{ city: 'Ravenhall', state: 'Victoria', country: 'Australia' }],
      },
      {
        name: 'Scarborough',
        lat: -31.894346156789997,
        lon: 115.75761710390464,
        results: [{ city: 'Scarborough', state: 'Western Australia', country: 'Australia' }],
      },
    ];

    it.each(reverseGeocodeTestCases)(`should resolve to $name`, async ({ lat, lon, results }) => {
      const { status, body } = await request(app)
        .get(`/map/reverse-geocode?lat=${lat}&lon=${lon}`)
        .set('Authorization', `Bearer ${admin.accessToken}`);
      expect(status).toBe(200);
      expect(Array.isArray(body)).toBe(true);
      expect(body.length).toBe(results.length);
      expect(body).toEqual(results);
    });
  });
});
