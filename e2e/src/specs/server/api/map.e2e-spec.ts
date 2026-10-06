import {
  AssetVisibility,
  createPartner,
  createUserAdmin,
  login,
  LoginResponseDto,
  signUpAdmin,
  updateAssets,
} from '@frameleaf/sdk';
import { readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { Socket } from 'socket.io-client';
import { withApiAssetReadiness } from 'src/api-asset-readiness.js';
import { createUserDto, loginDto, signupDto } from 'src/fixtures.js';
import { app, asBearerAuth, testAssetDir, utils } from 'src/utils.js';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const MAP_SETUP_TIMEOUT = process.env.CI ? 200_000 : 100_000;

const countOf = (buckets: { count: number }[]) => buckets.reduce((sum, bucket) => sum + bucket.count, 0);

describe('/map', () => {
  let websocket: Socket;
  let partnerWebsocket: Socket;
  let admin: LoginResponseDto;
  let partner: LoginResponseDto;
  let partnerArchivedAssetId: string;
  let adminArchivedAssetId: string;

  beforeAll(
    withApiAssetReadiness(MAP_SETUP_TIMEOUT, async (signal) => {
      await utils.resetDatabase(undefined, signal);
      await signUpAdmin({ signUpDto: signupDto.admin }, { signal });
      admin = await login({ loginCredentialDto: loginDto.admin }, { signal });
      await createUserAdmin(
        { userAdminCreateDto: createUserDto.user1 },
        { headers: asBearerAuth(admin.accessToken), signal },
      );
      partner = await login(
        { loginCredentialDto: { email: createUserDto.user1.email, password: createUserDto.user1.password } },
        { signal },
      );

      websocket = await utils.connectWebsocket(admin.accessToken, signal);
      partnerWebsocket = await utils.connectWebsocket(partner.accessToken, signal);

      const adminFiles = ['formats/heic/IMG_2682.heic', 'metadata/gps-position/thompson-springs.jpg'];
      const adminArchivedFile = 'metadata/dates/datetimeoriginal-gps.jpg';
      const partnerFile = 'metadata/gps-position/thompson-springs.jpg';
      utils.resetEvents();
      const uploadFile = async (accessToken: string, input: string) => {
        const filepath = join(testAssetDir, input);
        const { id } = await utils.createAsset(
          accessToken,
          {
            assetData: { bytes: await readFile(filepath, { signal }), filename: basename(filepath) },
          },
          { signal },
        );
        await utils.waitForWebsocketEvent({ event: 'assetUpload', id, signal });
        return id;
      };
      const adminUploads = await Promise.allSettled(adminFiles.map((f) => uploadFile(admin.accessToken, f)));
      for (const result of adminUploads) {
        if (result.status === 'rejected') {
          throw result.reason;
        }
      }
      const archivedUploads = await Promise.allSettled([
        uploadFile(admin.accessToken, adminArchivedFile),
        uploadFile(partner.accessToken, partnerFile),
      ]);
      [adminArchivedAssetId, partnerArchivedAssetId] = archivedUploads.map((result) => {
        if (result.status === 'rejected') {
          throw result.reason;
        }
        return result.value;
      });

      const updates = await Promise.allSettled([
        updateAssets(
          { assetBulkUpdateDto: { ids: [adminArchivedAssetId], visibility: AssetVisibility.Archive } },
          { headers: asBearerAuth(admin.accessToken), signal },
        ),
        updateAssets(
          { assetBulkUpdateDto: { ids: [partnerArchivedAssetId], visibility: AssetVisibility.Archive } },
          { headers: asBearerAuth(partner.accessToken), signal },
        ),
        createPartner(
          { partnerCreateDto: { sharedWithId: admin.userId } },
          { headers: asBearerAuth(partner.accessToken), signal },
        ),
      ]);
      for (const result of updates) {
        if (result.status === 'rejected') {
          throw result.reason;
        }
      }
    }),
    MAP_SETUP_TIMEOUT + 5000,
  );

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
    it('maps the recipient copy, refuses the source, and keeps the copy after unsharing', async () => {
      const { id: partnerLocatedId } = await utils.createAsset(partner.accessToken, {
        assetData: {
          // Unique in the recipient's library: the test must observe an actual new copy.
          bytes: await readFile(join(testAssetDir, 'metadata/gps-position/empty_gps.jpg')),
          filename: 'empty_gps.jpg',
        },
      });
      await utils.waitForWebsocketEvent({ event: 'assetUpload', id: partnerLocatedId });
      const copyId = await utils.waitForPartnerCopy(admin.userId, partnerLocatedId);
      await request(app)
        .put(`/assets/${partnerLocatedId}`)
        .set('Authorization', `Bearer ${partner.accessToken}`)
        .send({ latitude: 12.34, longitude: 56.78 })
        .expect(200);

      const markers = async () => {
        const { body } = await request(app)
          .get('/map/markers')
          .query({ withPartners: true })
          .set('Authorization', `Bearer ${admin.accessToken}`)
          .expect(200);
        return body as { id: string; lat: number; lon: number }[];
      };
      const markerIds = async () => {
        const rows = await markers();
        return rows.map(({ id }) => id);
      };
      const statistics = async () => {
        const { body } = await request(app)
          .get('/map/statistics')
          .set('Authorization', `Bearer ${admin.accessToken}`)
          .expect(200);
        return body;
      };
      const bucketsInBounds = async (bbox: string) => {
        const { body } = await request(app)
          .get('/timeline/buckets')
          .query({ bbox, visibility: AssetVisibility.Timeline })
          .set('Authorization', `Bearer ${admin.accessToken}`)
          .expect(200);
        return body as { count: number }[];
      };
      // Location propagation is also SQL work; row creation alone does not prove it finished.
      await expect
        .poll(markers, { timeout: 20_000 })
        .toContainEqual(expect.objectContaining({ id: copyId, lat: 12.34, lon: 56.78 }));
      const db = await utils.connectDatabase();
      const origin = async () => {
        const { rows } = await db.query(
          `SELECT copy.id, copy."ownerId", origin."sourceAssetId", origin."rootOwnerId", origin.following
           FROM public.asset_origin origin JOIN public.asset copy ON copy.id = origin."assetId"
           WHERE origin."sourceAssetId" = $1 AND origin."ownerId" = $2`,
          [partnerLocatedId, admin.userId],
        );
        return rows;
      };
      const expectedOrigin = {
        id: copyId,
        ownerId: admin.userId,
        sourceAssetId: partnerLocatedId,
        rootOwnerId: partner.userId,
      };
      expect(copyId).not.toBe(partnerLocatedId);
      expect(await origin()).toEqual([{ ...expectedOrigin, following: true }]);
      const { rows: receivedInventory } = await db.query(
        'SELECT id FROM public.asset WHERE "ownerId" = $1 ORDER BY id',
        [admin.userId],
      );
      const expectOnlyOwn = async () => {
        const ids = await markerIds();
        expect(ids).not.toContain(partnerLocatedId);
        expect(ids).toContain(copyId);
        expect(ids).toHaveLength(3);
        expect(await statistics()).toEqual({ archived: 1, partner: 0, unlocated: 0 });
        // The world holds the two uploads and the recipient's copy; an empty sea holds nothing,
        // and archived items stay out of the bounds as they stay off the timeline
        expect(countOf(await bucketsInBounds('-180,-90,180,90'))).toBe(3);
        expect(countOf(await bucketsInBounds('56,12,57,13'))).toBe(1);
        expect(await bucketsInBounds('-150,-65,-140,-55')).toEqual([]);
        await request(app)
          .get(`/assets/${partnerLocatedId}`)
          .set('Authorization', `Bearer ${admin.accessToken}`)
          .expect(400);
      };

      await expectOnlyOwn();
      const { status } = await request(app)
        .delete(`/partners/${admin.userId}`)
        .set('Authorization', `Bearer ${partner.accessToken}`);
      expect(status).toBe(204);
      await utils.waitForAllQueuesFinish(admin.accessToken);
      expect(await origin()).toEqual([{ ...expectedOrigin, following: false }]);
      await expectOnlyOwn();

      const later = await utils.createAsset(partner.accessToken);
      expect(later.id).toEqual(expect.any(String));
      const { rows: laterSource } = await db.query('SELECT id, "ownerId" FROM public.asset WHERE id = $1', [later.id]);
      expect(laterSource).toEqual([{ id: later.id, ownerId: partner.userId }]);
      // The postprocess job emits partner delivery. An empty active queue does not prove it ran.
      await expect
        .poll(
          async () => {
            const { rows: jobs } = await db.query<{ name: string; state: string }>(
              `SELECT name, state FROM public.job
               WHERE (name IN ('AssetExtractMetadata', 'AssetMetadataPostprocess') AND data->>'id' = $1)
                  OR "dedupKey" = 'partner-copy/' || $1 || '/' || $2
               ORDER BY name, id`,
              [later.id, admin.userId],
            );
            return {
              extracted: jobs.some(({ name, state }) => name === 'AssetExtractMetadata' && state === 'completed'),
              postprocessed: jobs.some(
                ({ name, state }) => name === 'AssetMetadataPostprocess' && state === 'completed',
              ),
              unfinished: jobs.filter(({ state }) => state !== 'completed'),
            };
          },
          { timeout: 20_000 },
        )
        .toEqual({ extracted: true, postprocessed: true, unfinished: [] });
      const { rows: laterOrigins } = await db.query(
        'SELECT "assetId" FROM public.asset_origin WHERE "sourceAssetId" = $1 AND "ownerId" = $2',
        [later.id, admin.userId],
      );
      expect(laterOrigins).toEqual([]);
      const { rows: retainedInventory } = await db.query(
        'SELECT id FROM public.asset WHERE "ownerId" = $1 ORDER BY id',
        [admin.userId],
      );
      expect(retainedInventory).toEqual(receivedInventory);
      expect(await origin()).toEqual([{ ...expectedOrigin, following: false }]);
      await request(app).get(`/assets/${later.id}`).set('Authorization', `Bearer ${admin.accessToken}`).expect(400);
      await expectOnlyOwn();
    }, 90_000);
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
