import { ForbiddenException } from '@nestjs/common';
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
import { MlAdmissionRefusal } from 'src/enum.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { DatabaseRepository } from 'src/repositories/database.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MapRepository } from 'src/repositories/map.repository.js';
import { MediaOperationRepository } from 'src/repositories/media-operation.repository.js';
import { PhotoLocationsRepository } from 'src/repositories/photo-locations.repository.js';
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import { PhotoLocationsService } from 'src/services/photo-locations.service.js';
import { cloudMlJobSpentUsd } from 'src/utils/cloud-ml-job.js';
import { FrameleafCloudError } from 'src/utils/frameleaf-cloud.js';
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
  await db?.destroy();
  if (directory) await rm(directory, { recursive: true, force: true });
});

it('uploads only opaque GPS input, adopts the owner result, and acknowledges after durable cleanup', async () => {
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
    new DatabaseRepository(db, logger, new ConfigRepository()),
    {} as never,
    {} as never,
    metadata as never,
    logger,
    { spendPermission: vi.fn().mockResolvedValue({ canConfirm: true, reason: null }) } as never,
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
  let settled = false;
  const billing = () => ({
    currency: 'USD',
    unitPriceMicros: 5000,
    heldMicros: 5000,
    checkedPhotos: settled ? 1 : 0,
    chargedMicros: settled ? 5000 : null,
    releasedMicros: settled ? 0 : null,
    state: settled ? 'settled' : 'held',
  });
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
    billing: billing(),
  });
  const request = vi.fn(
    async (schema: z.ZodType, path: string, options: Omit<FrameleafCloudRequest, 'url' | 'dpop'> = {}) => {
      if (path === '/v1/locations/status') return schema.parse({ enabled: true, available: true });
      if (path === '/v1/locations/estimates') {
        return schema.parse({
          estimateId: randomUUID(),
          expiresAt: new Date(Date.now() + 900_000).toISOString(),
          currency: 'USD',
          unitPriceMicros: 5000,
          eligiblePhotos: 1,
          selectedPhotos: 1,
          remainingPhotos: 0,
          holdMicros: 5000,
          availableMicros: 1_000_000,
        });
      }
      if (path === '/v1/locations/scans') {
        expect(options.method).toBe('POST');
        const body = z
          .strictObject({
            scanId: z.uuid(),
            estimateId: z.uuid(),
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
      if (path === `/v1/locations/scans/${scanId}`) {
        settled = true;
        return schema.parse(remoteStatus('completed'));
      }
      if (path === `/v1/locations/scans/${scanId}/billing`) return schema.parse({ scanId, billing: billing() });
      if (path === `/v1/locations/scans/${scanId}/results?offset=0&limit=500`) {
        const input = JSON.parse(gunzipSync(uploaded).toString());
        return schema.parse({
          scanId,
          algorithmVersion: 1,
          items: [{ itemKey: input.points[0].itemKey, state: 'matched', match }],
          nextOffset: null,
          complete: true,
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
        ).toHaveLength(1);
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

  expect(await service.status(auth)).toEqual({ enabled: true, available: true, scan: null });
  expect(await repository.latest(user.id)).toBeUndefined();
  const estimate = await service.estimate(auth, { refresh: false, maxSpendMicros: 5000 });
  expect(estimate).toMatchObject({ canStart: true, estimatedMicros: 5000, selectedPhotos: 1 });
  expect(await repository.latest(user.id)).toBeUndefined();
  const started = await service.start(auth, { consent: true, estimateId: estimate.estimateId! });
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
  expect((await repository.get(id, user.id))?.billing).toMatchObject({
    state: 'settled',
    chargedMicros: 5000,
    releasedMicros: 0,
  });
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
    '/v1/locations/status',
    '/v1/locations/estimates',
    '/v1/locations/estimates',
    '/v1/locations/scans',
    `/v1/locations/scans/${id}/upload`,
    `/v1/locations/scans/${id}/start`,
    `/v1/locations/scans/${id}`,
    `/v1/locations/scans/${id}/results?offset=0&limit=500`,
    '/v1/locations/status',
    `/v1/locations/scans/${id}/billing`,
    `/v1/locations/scans/${id}/ack`,
    '/v1/locations/status',
  ]);
  for (const call of [...Object.values(metadata), ...Object.values(cloud), logger.warn]) {
    expect(call).not.toHaveBeenCalled();
  }
});

async function unpolledPaidScan() {
  vi.spyOn(StorageCore, 'getMediaLocation').mockReturnValue(directory);
  const { ctx } = newMediumService(BaseService, { database: db, real: [], mock: [LoggingRepository] });
  const { user } = await ctx.newUser();
  const assets = [];
  for (let index = 0; index < 2; index++) {
    const { asset } = await ctx.newAsset({ ownerId: user.id });
    await db
      .insertInto('asset_exif')
      .values({ assetId: asset.id, latitude: 49, longitude: -123, gpsAccuracyM: 5 })
      .execute();
    assets.push(asset);
  }
  const repository = new PhotoLocationsRepository(db);
  const binding = { cloudUrl: 'https://cloud.invalid', instanceId: randomUUID(), linkedAt: 'test' };
  const created = await repository.create(user.id, false, binding, {
    estimateId: randomUUID(),
    expiresAt: new Date(Date.now() + 900_000).toISOString(),
    currency: 'USD',
    unitPriceMicros: 5000,
    eligiblePhotos: 2,
    selectedPhotos: 2,
    remainingPhotos: 0,
    holdMicros: 10_000,
    availableMicros: 1_000_000,
  });
  const token = randomUUID();
  await db
    .updateTable('photo_location_scan')
    .set({ leaseToken: token, leaseUntil: new Date(Date.now() + 300_000) })
    .where('id', '=', created.id)
    .execute();
  await repository.freeze({ ...created, leaseToken: token });
  await db
    .updateTable('photo_location_scan')
    .set({
      status: 'running',
      leaseToken: null,
      leaseUntil: null,
      state: { pointCount: 2, cloudCreateAttempted: true, cloudCreated: true, cloudStarted: true },
    })
    .where('id', '=', created.id)
    .execute();
  const points = await repository.points((await repository.get(created.id, user.id))!);
  const logger = ctx.getMock(LoggingRepository);
  const service = new PhotoLocationsService(
    repository,
    {} as never,
    {} as never,
    new DatabaseRepository(db, logger, new ConfigRepository()),
    {} as never,
    {} as never,
    {} as never,
    logger,
    {} as never,
  );
  const request = vi.fn();
  vi.spyOn(service as unknown as { gateway: () => Promise<unknown> }, 'gateway').mockResolvedValue({
    ...binding,
    request,
  });
  const billing = {
    currency: 'USD',
    unitPriceMicros: 5000,
    heldMicros: 10_000,
    checkedPhotos: 1,
    chargedMicros: 5000,
    releasedMicros: 5000,
    state: 'settled',
  };
  return { user, repository, service, request, billing, points, id: created.id };
}

it('retains work checked before cancellation even when the App has not polled, without double adoption on retry', async () => {
  const { user, repository, service, request, billing, points, id } = await unpolledPaidScan();
  const base = `/v1/locations/scans/${id}`;
  const match = {
    provider: 'google',
    placeId: 'checked-before-cancel',
    name: 'Retained cafe',
    address: null,
    mapsUrl: 'https://www.google.com/maps/search/?api=1&query=Cafe&query_place_id=checked-before-cancel',
    relation: 'near',
    confidence: 'medium',
    distanceM: 20,
    matchedAt: '2026-10-31T12:00:00Z',
    attributions: [],
  };
  let acknowledgements = 0;
  request.mockImplementation(async (schema: z.ZodType, path: string) => {
    if (path === `${base}/cancel`) return {};
    if (path === base)
      return schema.parse({
        scanId: id,
        state: 'cancelled',
        counts: { total: 2, processed: 1, matched: 1, unmatched: 0 },
        uploadOffset: 10,
        compressedBytes: 10,
        algorithmVersion: 1,
        expiresAt: '2099-01-01T00:00:00Z',
        billing,
      });
    if (path === `${base}/billing`) return schema.parse({ scanId: id, billing });
    if (path === `${base}/results?offset=0&limit=500`) {
      expect((await repository.get(id, user.id))?.status).toBe('cancelled');
      expect(
        await db.selectFrom('photo_location_scan_item').selectAll().where('scanId', '=', id).execute(),
      ).toHaveLength(2);
      return schema.parse({
        scanId: id,
        algorithmVersion: 1,
        items: [{ itemKey: points[0].itemKey, state: 'matched', match }],
        nextOffset: null,
        complete: true,
      });
    }
    if (path === `${base}/ack`) {
      if (++acknowledgements === 1) throw new Error('Synthetic lost acknowledgement');
      return {};
    }
    throw new Error(`Unexpected Cloud request: ${path}`);
  });
  await service.cancel({ user } as AuthDto, id);
  expect(request).not.toHaveBeenCalled();
  expect(cloudMlJobSpentUsd(await new MediaOperationRepository(db).listCloudMlJobSpend(user.id, new Date(0)))).toBe(
    0.01,
  );

  await service.tick();
  expect(await repository.get(id, user.id)).toMatchObject({
    status: 'cancelled',
    processed: 1,
    matched: 1,
    unmatched: 0,
    state: { cleanupPending: true },
    billing,
  });
  expect(
    await db
      .selectFrom('asset_location_insight')
      .select(['assetId', 'insight'])
      .where('assetId', '=', points[0].assetId)
      .execute(),
  ).toEqual([{ assetId: points[0].assetId, insight: match }]);
  await db
    .updateTable('photo_location_scan')
    .set({ nextAttemptAt: new Date(0) })
    .where('id', '=', id)
    .execute();
  await service.tick();

  expect(acknowledgements).toBe(2);
  expect(await repository.get(id, user.id)).toMatchObject({
    status: 'cancelled',
    processed: 1,
    matched: 1,
    unmatched: 0,
    state: {},
    billing,
  });
  expect(await db.selectFrom('photo_location_scan_item').selectAll().where('scanId', '=', id).execute()).toEqual([]);
  expect(cloudMlJobSpentUsd(await new MediaOperationRepository(db).listCloudMlJobSpend(user.id, new Date(0)))).toBe(
    0.005,
  );
});

it('recovers a nine-day-old charge after Cloud private metadata expiry and releases the local monthly reservation', async () => {
  const { user, repository, service, request, billing, id } = await unpolledPaidScan();
  const base = `/v1/locations/scans/${id}`;
  await service.cancel({ user } as AuthDto, id);
  await db
    .updateTable('photo_location_scan')
    .set({ createdAt: new Date(Date.now() - 9 * 86_400_000) })
    .where('id', '=', id)
    .execute();
  request.mockImplementation((schema: z.ZodType, path: string) => {
    if (path === `${base}/billing`) return Promise.resolve(schema.parse({ scanId: id, billing }));
    throw new FrameleafCloudError(MlAdmissionRefusal.CloudUnavailable, 410, 'Private parent expired');
  });
  const operations = new MediaOperationRepository(db);
  expect(cloudMlJobSpentUsd(await operations.listCloudMlJobSpend(user.id, new Date(0)))).toBe(0.01);

  await service.tick();

  expect(await repository.get(id, user.id)).toMatchObject({ state: {}, billing });
  expect(cloudMlJobSpentUsd(await operations.listCloudMlJobSpend(user.id, new Date(0)))).toBe(0.005);
  expect(await db.selectFrom('photo_location_scan_item').selectAll().where('scanId', '=', id).execute()).toEqual([]);
  expect(request.mock.calls.map(([, path]) => path)).toEqual([`${base}/cancel`, base, `${base}/billing`]);
});

it('reconciles a same-instance relink using only the retained receipt and releases the monthly reservation', async () => {
  const { user, repository, service, request, billing, id } = await unpolledPaidScan();
  await service.cancel({ user } as AuthDto, id);
  const scan = (await repository.get(id, user.id))!;
  vi.mocked((service as unknown as { gateway: (ownerId: string, expected?: unknown) => Promise<unknown> }).gateway)
    .mockRejectedValueOnce(new ForbiddenException('The Frameleaf Cloud link changed'))
    .mockResolvedValue({ request, cloudUrl: scan.cloudUrl, instanceId: scan.instanceId, linkedAt: 'new-link' });
  request.mockImplementation((schema: z.ZodType, path: string) => {
    if (path === `/v1/locations/scans/${id}/billing`) return Promise.resolve(schema.parse({ scanId: id, billing }));
    throw new Error(`Unexpected Cloud request after relinking: ${path}`);
  });
  const operations = new MediaOperationRepository(db);
  expect(cloudMlJobSpentUsd(await operations.listCloudMlJobSpend(user.id, new Date(0)))).toBe(0.01);

  await service.tick();

  expect(request.mock.calls.map(([, path]) => path)).toEqual([`/v1/locations/scans/${id}/billing`]);
  expect(await repository.get(id, user.id)).toMatchObject({ state: {}, billing, processed: 0 });
  expect(cloudMlJobSpentUsd(await operations.listCloudMlJobSpend(user.id, new Date(0)))).toBe(0.005);
  expect(await db.selectFrom('photo_location_scan_item').selectAll().where('scanId', '=', id).execute()).toEqual([]);
});
