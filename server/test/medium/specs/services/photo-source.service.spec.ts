import { Kysely } from 'kysely';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { PhotoSourceController } from 'src/controllers/photo-source.controller.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { AssetUploadResourceRepository } from 'src/repositories/asset-upload-resource.repository.js';
import { CryptoRepository } from 'src/repositories/crypto.repository.js';
import { DesktopDeviceRepository } from 'src/repositories/desktop-device.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { PhotoSourceRepository } from 'src/repositories/photo-source.repository.js';
import { SessionRepository } from 'src/repositories/session.repository.js';
import { StorageRepository } from 'src/repositories/storage.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import { PhotoSourceService } from 'src/services/photo-source.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { controllerSetup, getKyselyDB } from 'test/utils.js';

const WINDOW = '2030-01-01 00:00:00+00';
let db: Kysely<DB>;
let root: string;
beforeAll(async () => {
  db = await getKyselyDB();
  root = await mkdtemp(join(tmpdir(), 'frameleaf-source-proof-'));
});
afterAll(async () => {
  await db?.destroy();
  if (root) await rm(root, { recursive: true, force: true });
});
async function setup() {
  const { ctx } = newMediumService(BaseService, { database: db, real: [], mock: [LoggingRepository] });
  const { user } = await ctx.newUser();
  const photo = await new SessionRepository(db).create({ userId: user.id, token: Buffer.alloc(32, 7) });
  const device = (await new DesktopDeviceRepository(db).enroll({
    userId: user.id,
    installationId: randomUUID(),
    publicKey: Buffer.alloc(32, 7).toString('base64'),
    name: 'Fixture',
    platform: 'linux',
    architecture: 'x86_64',
    mode: 'client-worker',
    state: 'awaiting-approval',
  }))!;
  const authority = { ownerId: user.id, sessionId: photo.id };
  const auth = { user, session: { ...photo, hasElevatedPermission: false } } as AuthDto;
  const repository = new PhotoSourceRepository(db);
  const crypto = new CryptoRepository();
  const access = new AccessRepository(db);
  const limits = {
    hit: vi.fn().mockResolvedValue({ count: 1, resetSeconds: 900, windowExpiresAt: WINDOW }),
    release: vi.fn().mockResolvedValue(undefined),
  };
  const service = new PhotoSourceService(
    repository,
    access,
    new StorageRepository(LoggingRepository.create()),
    crypto,
    new SystemMetadataRepository(db),
    limits as never,
    LoggingRepository.create(),
  );
  const source = await service.create(auth, {
    id: randomUUID(),
    deviceId: device.id,
    kind: 'folder',
    mode: 'copy',
    name: 'Fixture',
    scopeFingerprint: 'a'.repeat(64),
  });
  const run = await service.run(auth, source.id, { id: randomUUID(), maxItems: 10, maxBytes: 1024 });
  const bytes = Buffer.from('synthetic original');
  const checksum = createHash('sha256').update(bytes).digest();
  const path = join(root, `${randomUUID()}.jpg`);
  await writeFile(path, bytes);
  const { asset } = await ctx.newAsset({
    ownerId: user.id,
    originalPath: path,
    checksum,
    isExternal: false,
    libraryId: null,
  });
  await ctx.newExif({ assetId: asset.id, fileSizeInByte: bytes.length });
  const upload = await new AssetUploadResourceRepository(db).create(randomUUID(), user.id, {
    checksum,
    size: bytes.length,
    contentType: 'image/jpeg',
    metadata: { filename: 'fixture.jpg', fileCreatedAt: new Date(), fileModifiedAt: new Date() },
  });
  await db
    .updateTable('asset_upload_resource')
    .set({
      state: 'published',
      ingested: true,
      resultAssetId: asset.id,
      resultStatus: 'duplicate',
      verifiedChecksum: checksum,
      offset: bytes.length,
    })
    .where('id', '=', upload.id)
    .execute();
  const item = {
    id: randomUUID(),
    resourceKey: 'b'.repeat(64),
    version: 'c'.repeat(64),
    sha256: checksum.toString('hex'),
    bytes: bytes.length,
  };
  await service.plan(auth, source.id, run.id, item);
  return {
    ctx,
    authority,
    auth,
    repository,
    service,
    crypto,
    access,
    limits,
    source,
    run,
    item,
    asset,
    path,
    bytes,
    upload,
  };
}
it('records real healthy managed bytes and preserves distinct source associations after deduplication', async () => {
  const f = await setup();
  const receipt = await f.service.verify(f.auth, f.source.id, f.run.id, f.item.id, { uploadResourceId: f.upload.id });
  expect(receipt).toMatchObject({
    sourceId: f.source.id,
    runId: f.run.id,
    itemId: f.item.id,
    assetId: f.asset.id,
    ownerId: f.auth.user.id,
    sha256: f.item.sha256,
    bytes: f.bytes.length,
    storage: 'managed',
  });
  expect(JSON.stringify(receipt)).not.toContain(root);
  expect(await readFile(f.path)).toEqual(f.bytes);
  expect(
    (await f.service.setState(f.auth, f.source.id, f.run.id, { state: 'complete', inventoryComplete: false }))
      .inventoryComplete,
  ).toBe(false);
  const second = await f.service.create(f.auth, {
    id: randomUUID(),
    deviceId: f.source.deviceId,
    kind: 'folder',
    mode: 'copy',
    name: 'Another source',
    scopeFingerprint: 'd'.repeat(64),
  });
  const run = await f.service.run(f.auth, second.id, { id: randomUUID(), maxItems: 1, maxBytes: 1024 });
  const item = { ...f.item, id: randomUUID() };
  await f.service.plan(f.auth, second.id, run.id, item);
  const other = await f.service.verify(f.auth, second.id, run.id, item.id, { uploadResourceId: f.upload.id });
  expect(other.assetId).toBe(receipt.assetId);
  expect(
    await db.selectFrom('photo_source_resource').select('id').where('assetId', '=', f.asset.id).execute(),
  ).toHaveLength(2);
});
it('corrupt or missing managed duplicates retain a planned item and never receive a healthy-copy receipt', async () => {
  for (const missing of [false, true]) {
    const f = await setup();
    if (missing) await unlink(f.path);
    else await writeFile(f.path, Buffer.alloc(f.bytes.length, 1));
    await expect(
      f.service.verify(f.auth, f.source.id, f.run.id, f.item.id, { uploadResourceId: f.upload.id }),
    ).rejects.toThrow('photo_source_managed_original_unhealthy');
    expect(
      await db
        .selectFrom('photo_source_resource')
        .select(['state', 'assetId'])
        .where('id', '=', f.item.id)
        .executeTakeFirstOrThrow(),
    ).toEqual({ state: 'planned', assetId: null });
    expect(f.limits.release).toHaveBeenCalled();
  }
});
it('an external-only result can never satisfy a managed copy', async () => {
  const f = await setup();
  await db.updateTable('asset').set({ isExternal: true }).where('id', '=', f.asset.id).execute();
  await expect(
    f.service.verify(f.auth, f.source.id, f.run.id, f.item.id, { uploadResourceId: f.upload.id }),
  ).rejects.toThrow('photo_source_managed_original_unavailable');
  expect(await readFile(f.path)).toEqual(f.bytes);
});
it('revocation during hashing fences the final receipt and leaves existing media untouched', async () => {
  const f = await setup();
  const original = f.crypto.hashFileMatching.bind(f.crypto);
  vi.spyOn(f.crypto, 'hashFileMatching').mockImplementationOnce(async (path, checksum) => {
    const digest = await original(path, checksum);
    await f.repository.revoke(f.authority, f.source.id);
    return digest;
  });
  await expect(
    f.service.verify(f.auth, f.source.id, f.run.id, f.item.id, { uploadResourceId: f.upload.id }),
  ).rejects.toThrow();
  expect(
    await db.selectFrom('photo_source_resource').select('state').where('id', '=', f.item.id).executeTakeFirstOrThrow(),
  ).toEqual({ state: 'planned' });
  expect(await readFile(f.path)).toEqual(f.bytes);
});
it('cancellation prevents byte hashing and cannot finish a copy', async () => {
  const f = await setup();
  const hash = vi.spyOn(f.crypto, 'hashFileMatching');
  const cancel = new AbortController();
  cancel.abort();
  await expect(
    f.service.verify(f.auth, f.source.id, f.run.id, f.item.id, { uploadResourceId: f.upload.id }, cancel.signal),
  ).rejects.toThrow();
  expect(hash).not.toHaveBeenCalled();
});
it('API keys, shared links and ML/system authority cannot create or verify photo sources', async () => {
  const f = await setup();
  for (const extra of [{ apiKey: {} }, { sharedLink: {} }, { system: true }, { session: undefined }]) {
    await expect(
      f.service.verify({ ...f.auth, ...extra } as never, f.source.id, f.run.id, f.item.id, {
        uploadResourceId: f.upload.id,
      }),
    ).rejects.toThrow('photo_source_photo_session_required');
    await expect(
      f.service.create({ ...f.auth, ...extra } as never, {
        id: randomUUID(),
        deviceId: f.source.deviceId,
        kind: 'folder',
        mode: 'copy',
        name: 'Not approved',
        scopeFingerprint: 'a'.repeat(64),
      }),
    ).rejects.toThrow('photo_source_photo_session_required');
  }
});
it('a photo session that expires during hashing cannot adopt a healthy result', async () => {
  const f = await setup();
  const original = f.crypto.hashFileMatching.bind(f.crypto);
  vi.spyOn(f.crypto, 'hashFileMatching').mockImplementationOnce(async (path, checksum) => {
    const digest = await original(path, checksum);
    await db
      .updateTable('session')
      .set({ expiresAt: new Date(0) })
      .where('id', '=', f.authority.sessionId)
      .execute();
    return digest;
  });
  await expect(
    f.service.verify(f.auth, f.source.id, f.run.id, f.item.id, { uploadResourceId: f.upload.id }),
  ).rejects.toThrow();
  expect(
    await db.selectFrom('photo_source_resource').select('state').where('id', '=', f.item.id).executeTakeFirstOrThrow(),
  ).toEqual({ state: 'planned' });
});
it('an original changed during its byte proof cannot satisfy a managed copy', async () => {
  const f = await setup();
  const original = f.crypto.hashFileMatching.bind(f.crypto);
  vi.spyOn(f.crypto, 'hashFileMatching').mockImplementationOnce(async (path, checksum) => {
    const digest = await original(path, checksum);
    await writeFile(f.path, Buffer.alloc(f.bytes.length, 1));
    return digest;
  });
  await expect(
    f.service.verify(f.auth, f.source.id, f.run.id, f.item.id, { uploadResourceId: f.upload.id }),
  ).rejects.toThrow('photo_source_managed_original_unhealthy');
});
it('verification admission is bounded and is always released on refusal', async () => {
  const f = await setup();
  f.limits.hit.mockResolvedValueOnce({ count: 2, resetSeconds: 900, windowExpiresAt: WINDOW });
  const hash = vi.spyOn(f.crypto, 'hashFileMatching');
  await expect(
    f.service.verify(f.auth, f.source.id, f.run.id, f.item.id, { uploadResourceId: f.upload.id }),
  ).rejects.toThrow('photo_source_verification_busy');
  expect(hash).not.toHaveBeenCalled();
  expect(f.limits.release).toHaveBeenCalledExactlyOnceWith(`photo-source-verify:${f.auth.user.id}`, WINDOW);
});

it('serves a real copy receipt through the HTTP boundary and rejects paths and malformed cursors', async () => {
  const f = await setup();
  const http = await controllerSetup(PhotoSourceController, [{ provide: PhotoSourceService, useValue: f.service }]);
  try {
    http.authenticate.mockResolvedValue(f.auth);
    const base = `/photo-sources/${f.source.id}/runs/${f.run.id}`;
    const before = await request(http.getHttpServer()).get(base);
    expect(before.status).toBe(200);
    expect(before.body.items[0].state).toBe('planned');
    expect(JSON.stringify(before.body)).not.toContain(f.asset.id);
    expect((await request(http.getHttpServer()).get(base).query({ after: '../private' })).status).toBe(400);
    expect(
      (
        await request(http.getHttpServer())
          .post('/photo-sources')
          .send({
            id: randomUUID(),
            deviceId: f.source.deviceId,
            kind: 'folder',
            mode: 'copy',
            name: 'Unsafe',
            scopeFingerprint: 'a'.repeat(64),
            root: '/private',
          })
      ).status,
    ).toBe(400);
    const response = await request(http.getHttpServer())
      .post(`${base}/items/${f.item.id}/verify`)
      .send({ uploadResourceId: f.upload.id });
    expect(response.status).toBe(200);
    expect(response.body.assetId).toBe(f.asset.id);
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(response.body.storage).toBe('managed');
    expect(JSON.stringify(response.body)).not.toContain(root);
  } finally {
    await http.close();
  }
});
