import { Kysely } from 'kysely';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import z from 'zod';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import type { FrameleafCloudRequest } from 'src/repositories/frameleaf-cloud.repository.js';
import { StorageCore } from 'src/cores/storage.core.js';
import { mapAsset } from 'src/dtos/asset-response.dto.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MapRepository } from 'src/repositories/map.repository.js';
import { PhotoLocationsRepository } from 'src/repositories/photo-locations.repository.js';
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import { PhotoLocationsService } from 'src/services/photo-locations.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { getActiveForkKyselyDB } from 'test/utils.js';

let db: Kysely<DB>;
let directory: string;

beforeAll(async () => {
  db = await getActiveForkKyselyDB();
  directory = await mkdtemp(join(tmpdir(), 'frameleaf-location-flow-'));
}, 60_000);

afterAll(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await db?.destroy();
  if (directory) await rm(directory, { recursive: true, force: true });
});

it('uploads only opaque GPS input, adopts the owner result, and acknowledges after durable cleanup', async () => {
  vi.stubEnv('FRAMELEAF_PHOTO_LOCATIONS_ENABLED', 'true');
  vi.spyOn(StorageCore, 'getMediaLocation').mockReturnValue(directory);
  const { ctx } = newMediumService(BaseService, { database: db, real: [], mock: [LoggingRepository] });
  const { user } = await ctx.newUser();
  const auth = { user } as AuthDto;
  const { asset } = await ctx.newAsset({
    ownerId: user.id,
    originalFileName: 'private-family-name.jpg',
    originalPath: '/synthetic/private-family-photo.jpg',
  });
  await db
    .insertInto('asset_exif')
    .values({ assetId: asset.id, latitude: 49, longitude: -123, gpsAccuracyM: 5, city: 'Original city' })
    .execute();
  const exifBefore = await db.selectFrom('asset_exif').selectAll().where('assetId', '=', asset.id).executeTakeFirst();
  const maps = ctx.get(MapRepository);
  const markersBefore = await maps.getMapMarkers(user.id, [user.id], []);
  const repository = new PhotoLocationsRepository(db);
  const metadata = { readTags: vi.fn(), writeTags: vi.fn() };
  const cloud = { discovery: vi.fn(), accessToken: vi.fn(), requestJson: vi.fn() };
  const logger = ctx.getMock(LoggingRepository);
  const service = new PhotoLocationsService(
    repository,
    cloud as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    metadata as never,
    logger,
  );
  const match = {
    provider: 'google',
    placeId: 'synthetic-cafe',
    name: 'Cafe',
    address: 'Main Street',
    mapsUrl: 'https://www.google.com/maps/search/?api=1&query=Cafe&query_place_id=synthetic-cafe',
    relation: 'near',
    confidence: 'medium',
    distanceM: 30,
    matchedAt: '2026-10-31T12:00:00Z',
    attributions: [{ displayName: 'Synthetic provider', uri: 'https://example.com/attribution' }],
  };
  let scanId = '';
  let compressedBytes = 0;
  let uploaded = Buffer.alloc(0);
  const remoteStatus = (state: 'uploading' | 'queued' | 'completed') => ({
    scanId,
    state,
    counts: {
      total: 1,
      processed: state === 'completed' ? 1 : 0,
      matched: state === 'completed' ? 1 : 0,
      unmatched: 0,
    },
    uploadOffset: uploaded.length,
    compressedBytes,
    algorithmVersion: 1,
    expiresAt: '2099-01-01T00:00:00Z',
  });
  const request = vi.fn(
    async (schema: z.ZodType, path: string, options: Omit<FrameleafCloudRequest, 'url' | 'dpop'> = {}) => {
      if (path === '/v1/locations/status') return schema.parse({ enabled: true, available: true });
      if (path === '/v1/locations/scans') {
        expect(options.method).toBe('POST');
        const body = z
          .strictObject({
            scanId: z.uuid(),
            locale: z.literal('en'),
            compressedBytes: z.number().int().positive(),
            pointCount: z.literal(1),
            sha256: z.string().length(64),
            refresh: z.literal(false),
          })
          .parse(options.body);
        scanId = body.scanId;
        compressedBytes = body.compressedBytes;
        return schema.parse(remoteStatus('uploading'));
      }
      if (path === `/v1/locations/scans/${scanId}/upload`) {
        expect(options.method).toBe('PUT');
        expect(options.headers).toEqual({ 'Upload-Offset': String(uploaded.length) });
        expect(options.raw?.contentType).toBe('application/gzip');
        uploaded = Buffer.concat([uploaded, z.instanceof(Uint8Array).parse(options.raw?.body)]);
        return schema.parse({ scanId, uploadOffset: uploaded.length, compressedBytes });
      }
      if (path === `/v1/locations/scans/${scanId}/start`) {
        expect(options).toEqual({ method: 'POST', body: {} });
        expect(uploaded.length).toBe(compressedBytes);
        return schema.parse(remoteStatus('queued'));
      }
      if (path === `/v1/locations/scans/${scanId}`) return schema.parse(remoteStatus('completed'));
      if (path === `/v1/locations/scans/${scanId}/results?offset=0&limit=500`) {
        const input = JSON.parse(gunzipSync(uploaded).toString());
        return schema.parse({
          scanId,
          algorithmVersion: 1,
          items: [{ itemKey: input.points[0].itemKey, state: 'matched', match }],
          nextOffset: null,
        });
      }
      if (path === `/v1/locations/scans/${scanId}/ack`) {
        expect(options).toEqual({ method: 'POST', body: {} });
        await expect(
          readFile(join(directory, 'frameleaf', 'location-scans', `${scanId}.json.gz`)),
        ).rejects.toMatchObject({
          code: 'ENOENT',
        });
        expect(
          await db.selectFrom('photo_location_scan_item').selectAll().where('scanId', '=', scanId).execute(),
        ).toEqual([]);
        return schema.parse({});
      }
      throw new Error(`Unexpected Cloud request: ${path}`);
    },
  );
  vi.spyOn(service as unknown as { gateway: () => Promise<unknown> }, 'gateway').mockResolvedValue({
    cloudUrl: 'https://cloud.invalid',
    instanceId: randomUUID(),
    linkedAt: '2026-10-31T00:00:00Z',
    request,
  });

  const started = await service.start(auth, { consent: true, refresh: false });
  expect(started.scan).toMatchObject({ status: 'queued', total: 0, processed: 0 });
  const id = started.scan!.id;
  await service.tick();
  expect(scanId).toBe(id);
  const running = await repository.get(id, user.id);
  expect(running).toMatchObject({ status: 'running', total: 1, state: { cloudCreated: true, cloudStarted: true } });
  const inputPath = join(directory, 'frameleaf', 'location-scans', `${id}.json.gz`);
  expect(await readFile(inputPath)).toEqual(uploaded);
  expect(running?.state.sha256).toBe(createHash('sha256').update(uploaded).digest('hex'));
  const mappings = await db.selectFrom('photo_location_scan_item').selectAll().where('scanId', '=', id).execute();
  expect(mappings).toHaveLength(1);
  const itemKey = mappings[0].itemKey;
  expect([asset.id, user.id, id]).not.toContain(itemKey);
  const inputText = gunzipSync(uploaded).toString();
  expect(JSON.parse(inputText)).toEqual({
    schemaVersion: 1,
    scanId: id,
    points: [{ itemKey, latitude: 49, longitude: -123, accuracyM: 5 }],
  });
  for (const privateValue of [asset.id, user.id, asset.originalFileName, asset.originalPath]) {
    expect(inputText).not.toContain(privateValue);
  }

  await db
    .updateTable('photo_location_scan')
    .set({ nextAttemptAt: new Date(0) })
    .where('id', '=', id)
    .execute();
  await service.tick();
  expect(await service.status(auth)).toMatchObject({
    enabled: true,
    available: true,
    scan: { id, status: 'completed', total: 1, processed: 1, matched: 1, unmatched: 0, skipped: 0, failed: 0 },
  });
  const stored = (await new AssetRepository(db).getById(asset.id, { exifInfo: true }))!;
  expect(mapAsset(stored).locationInsight).toEqual(match);
  expect(mapAsset(stored, { stripMetadata: true })).not.toHaveProperty('locationInsight');
  expect(await readFile(inputPath)).toEqual(uploaded);
  expect((await repository.get(id, user.id))?.state.cleanupPending).toBe(true);

  await db
    .updateTable('photo_location_scan')
    .set({ nextAttemptAt: new Date(0) })
    .where('id', '=', id)
    .execute();
  await service.tick();
  expect((await repository.get(id, user.id))?.state).toEqual({});
  await expect(readFile(inputPath)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await db.selectFrom('photo_location_scan_item').selectAll().where('scanId', '=', id).execute()).toEqual([]);
  expect(await db.selectFrom('asset_exif').selectAll().where('assetId', '=', asset.id).executeTakeFirst()).toEqual(
    exifBefore,
  );
  expect(await maps.getMapMarkers(user.id, [user.id], [])).toEqual(markersBefore);
  const { user: otherOwner } = await ctx.newUser();
  expect((await service.status({ user: otherOwner } as AuthDto)).scan).toBeNull();
  expect(request.mock.calls.map(([, path]) => path)).toEqual([
    '/v1/locations/status',
    '/v1/locations/scans',
    `/v1/locations/scans/${id}/upload`,
    `/v1/locations/scans/${id}/start`,
    `/v1/locations/scans/${id}`,
    `/v1/locations/scans/${id}/results?offset=0&limit=500`,
    '/v1/locations/status',
    `/v1/locations/scans/${id}/ack`,
    '/v1/locations/status',
  ]);
  for (const call of [...Object.values(metadata), ...Object.values(cloud), logger.warn]) {
    expect(call).not.toHaveBeenCalled();
  }
});
