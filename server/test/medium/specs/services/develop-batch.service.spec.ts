import { Kysely, sql } from 'kysely';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import sharp from 'sharp';
import { StorageCore } from 'src/cores/storage.core.js';
import { AssetDevelopRevisionStatus } from 'src/dtos/asset-develop.dto.js';
import { AssetLockReason, AssetType, ChecksumAlgorithm, JobStatus, Permission } from 'src/enum.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { AssetDevelopRepository } from 'src/repositories/asset-develop.repository.js';
import { AssetJobRepository } from 'src/repositories/asset-job.repository.js';
import { AssetPaletteRepository } from 'src/repositories/asset-palette.repository.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { CryptoRepository } from 'src/repositories/crypto.repository.js';
import { DevelopBatchRepository } from 'src/repositories/develop-batch.repository.js';
import { DownloadRepository } from 'src/repositories/download.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MediaOperationRepository } from 'src/repositories/media-operation.repository.js';
import { MediaRepository } from 'src/repositories/media.repository.js';
import { PhotoToolsRepository } from 'src/repositories/photo-tools.repository.js';
import { PhysicalFileRepository } from 'src/repositories/physical-file.repository.js';
import { StorageRepository } from 'src/repositories/storage.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { DB } from 'src/schema/index.js';
import { AssetDevelopService } from 'src/services/asset-develop.service.js';
import { BaseService } from 'src/services/base.service.js';
import { DevelopBatchService, batchStagingFolder } from 'src/services/develop-batch.service.js';
import { defaultDevelopRecipe } from 'src/utils/develop-recipe.js';
import { lockedFixture } from 'test/fixtures/locked.stub.js';
import { newMediumService } from 'test/medium.factory.js';
import { factory } from 'test/small.factory.js';
import { getKyselyDB } from 'test/utils.js';

let db: Kysely<DB>, root: string, previous: string;
const logger = () =>
  ({
    setContext: () => {},
    log: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    verbose: () => {},
  }) as never;
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const image = (background = '#a08060') =>
  sharp({ create: { width: 64, height: 48, channels: 3, background } })
    .png()
    .toBuffer();
const setup = () => {
  const { ctx } = newMediumService(BaseService, { database: db, real: [], mock: [LoggingRepository] });
  const revisions = new AssetDevelopRepository(db),
    repository = new DevelopBatchRepository(db),
    assets = new AssetRepository(db),
    access = new AccessRepository(db),
    crypto = new CryptoRepository(),
    storage = new StorageRepository(logger()),
    media = new MediaRepository(logger());
  const jobs = { queue: vi.fn().mockResolvedValue(undefined), queueAll: vi.fn().mockResolvedValue(undefined) };
  const develop = new AssetDevelopService(
    logger(),
    access,
    assets,
    new AssetJobRepository(db),
    revisions,
    new ConfigRepository(),
    crypto,
    jobs as never,
    media,
    new PhotoToolsRepository(db),
    storage,
    new SystemMetadataRepository(db),
    new MediaOperationRepository(db),
    {} as never,
    { emit: vi.fn().mockResolvedValue(undefined) } as never,
  );
  const sut = new DevelopBatchService(
    repository,
    develop,
    revisions,
    assets,
    access,
    crypto,
    storage,
    new DownloadRepository(db),
    jobs as never,
  );
  return { ctx, revisions, repository, develop, sut, media, jobs, assets, access, storage };
};
const photo = async (ctx: ReturnType<typeof setup>['ctx'], ownerId: string, name = 'IMG_0001.jpg') => {
  const bytes = await image(
      `#${Math.floor(Math.random() * 0xff_ff_ff)
        .toString(16)
        .padStart(6, '0')}`,
    ),
    originalPath = join(root, `${randomUUID()}.png`);
  await writeFile(originalPath, bytes);
  const { asset } = await ctx.newAsset({
    ownerId,
    type: AssetType.Image,
    originalPath,
    originalFileName: name,
    checksum: createHash('sha1').update(bytes).digest(),
    checksumAlgorithm: ChecksumAlgorithm.sha1File,
  });
  await ctx.newExif({ assetId: asset.id, colorspace: 'sRGB' });
  return asset;
};
const stage = async (ownerId: string, batchId: string, bytes: Buffer, originalname = 'return.png') => {
  const folder = batchStagingFolder(ownerId, batchId);
  await mkdir(folder, { recursive: true });
  const path = join(folder, `${randomUUID()}.partial`);
  await writeFile(path, bytes);
  return { path, originalname, size: bytes.length } as Express.Multer.File;
};
const prepare = async () => {
  const env = setup(),
    { user } = await env.ctx.newUser(),
    { session } = await env.ctx.newSession({ userId: user.id }),
    auth = factory.auth({ user, session }),
    asset = await photo(env.ctx, user.id);
  let batch = await env.sut.create(auth, { assetIds: [asset.id], includeSidecars: true });
  await env.sut.prepare(auth, batch.id, batch.items[0].id);
  batch = await env.sut.get(auth, batch.id);
  const bytes = await image();
  const confirmed = await env.sut.confirm(auth, batch.id, {
    files: [{ itemId: batch.items[0].id, fileName: 'return.png', checksum: hash(bytes) }],
  });
  const item = confirmed.items[0],
    returned = item.returns[0],
    dto = { confirmationId: returned.confirmationId, renditionChecksum: hash(bytes) };
  return { ...env, user, auth, asset, batch, bytes, item, returned, dto };
};
const usage = async (id: string) =>
  Number(
    (await db.selectFrom('user').select('quotaUsageInBytes').where('id', '=', id).executeTakeFirstOrThrow())
      .quotaUsageInBytes,
  );
beforeAll(async () => {
  db = await getKyselyDB();
  try {
    previous = StorageCore.getMediaLocation();
  } catch {
    /* No media folder configured for this test process. */
  }
  root = await mkdtemp(join(tmpdir(), 'batch-roundtrip-'));
  StorageCore.setMediaLocation(root);
});
afterAll(async () => {
  if (previous) StorageCore.setMediaLocation(previous);
  await rm(root, { recursive: true, force: true });
  await db?.destroy();
});

it('streams originals and permitted sidecars under collision-safe names plus a versioned manifest', async () => {
  const { ctx, sut } = setup(),
    { user } = await ctx.newUser(),
    { session } = await ctx.newSession({ userId: user.id }),
    auth = factory.auth({ user, session });
  const a = await photo(ctx, user.id, '../Photo.JPG'),
    b = await photo(ctx, user.id, 'photo.JPG');
  const sidecar = join(root, 'metadata.xmp');
  await writeFile(sidecar, '<xmp>fixture</xmp>');
  await db
    .insertInto('asset_file')
    .values({ assetId: a.id, type: 'sidecar' as never, path: sidecar })
    .execute();
  let batch = await sut.create(auth, { assetIds: [a.id, b.id], includeSidecars: true });
  for (const item of batch.items) await sut.prepare(auth, batch.id, item.id);
  batch = await sut.get(auth, batch.id);
  const stream = await sut.download(auth, batch.id);
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  const archive = join(root, 'out.zip');
  await writeFile(archive, Buffer.concat(chunks));
  const entries = execFileSync('unzip', ['-Z1', archive], { encoding: 'utf8' }).trim().split('\n');
  expect(entries).toContain('frameleaf-roundtrip.json');
  expect(entries).toHaveLength(4);
  expect(entries.some((name) => name.includes('../'))).toBe(false);
  expect(new Set(entries.map((name) => name.toLowerCase())).size).toBe(4);
  const manifest = JSON.parse(execFileSync('unzip', ['-p', archive, 'frameleaf-roundtrip.json'], { encoding: 'utf8' }));
  expect(manifest.version).toBe(1);
  expect(manifest.items.map((i: { exportId: string }) => i.exportId)).toEqual(batch.items.map((i) => i.exportId));
  for (const item of batch.items)
    expect(execFileSync('unzip', ['-p', archive, item.exportName!])).toEqual(
      await readFile(item.assetId === a.id ? a.originalPath : b.originalPath),
    );
});
it('streams an original sealed since it was prepared, decrypted for its owner (FL-721)', async () => {
  const { ctx, sut } = setup(),
    { user } = await ctx.newUser(),
    { session } = await ctx.newSession({ userId: user.id }),
    auth = factory.auth({ user, session });
  const asset = await photo(ctx, user.id);
  const plain = await readFile(asset.originalPath);
  let batch = await sut.create(auth, { assetIds: [asset.id], includeSidecars: false });
  await sut.prepare(auth, batch.id, batch.items[0].id);
  batch = await sut.get(auth, batch.id);
  const locked = await lockedFixture(user.id);
  try {
    // the photo went into Locked with encryption on and its original was sealed
    const sealed = await locked.seal('IMG_0001.png', plain, 'image/png');
    await db.updateTable('asset').set({ originalPath: sealed }).where('id', '=', asset.id).execute();

    // without the key the archive is refused before it starts
    await expect(sut.download(auth, batch.id)).rejects.toMatchObject({ status: 423 });

    locked.loadKey();
    const stream = await sut.download(auth, batch.id);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    const archive = join(root, `${randomUUID()}.zip`);
    await writeFile(archive, Buffer.concat(chunks));
    expect(execFileSync('unzip', ['-p', archive, batch.items[0].exportName!])).toEqual(plain);
    expect(await locked.copiesLeft()).toBe(0);
  } finally {
    await locked.cleanup();
  }
});
it('imports concurrent/repeated bytes once, survives a repository restart, renders before activation and accepts corrected bytes in this batch', async () => {
  const f = await prepare();
  const stagedA = await stage(f.user.id, f.batch.id, f.bytes),
    stagedB = await stage(f.user.id, f.batch.id, f.bytes);
  await Promise.all([
    f.sut.import(f.auth, f.batch.id, f.item.id, f.dto, stagedA),
    f.sut.import(f.auth, f.batch.id, f.item.id, f.dto, stagedB),
  ]);
  const persisted = await new DevelopBatchRepository(db).get(f.user.id, f.batch.id),
    returned = persisted.items[0].returns[0];
  expect(await f.revisions.listByAsset(f.asset.id)).toHaveLength(1);
  expect(await usage(f.user.id)).toBe(f.bytes.length);
  expect(await f.revisions.getCurrent(f.asset.id)).toBeUndefined();
  expect(await f.develop.handleRender({ id: returned.revisionId! })).toBe(JobStatus.Success);
  expect((await f.revisions.getCurrent(f.asset.id))?.id).toBe(returned.revisionId);
  expect(await new AssetPaletteRepository(db).currentDevelopAssetId(returned.revisionId!)).toBe(f.asset.id);
  expect((await f.sut.get(f.auth, f.batch.id)).items[0].returns[0].status).toBe('completed');
  await f.sut.import(f.auth, f.batch.id, f.item.id, f.dto, await stage(f.user.id, f.batch.id, f.bytes));
  expect(await f.revisions.listByAsset(f.asset.id)).toHaveLength(1);
  const corrected = await image('#101020');
  const confirmed = await f.sut.confirm(f.auth, f.batch.id, {
    files: [{ fileName: 'corrected.png', itemId: f.item.id, checksum: hash(corrected) }],
  });
  const next = confirmed.items[0].returns.at(-1)!;
  await f.sut.import(
    f.auth,
    f.batch.id,
    f.item.id,
    { confirmationId: next.confirmationId, renditionChecksum: hash(corrected) },
    await stage(f.user.id, f.batch.id, corrected),
  );
  expect(await f.revisions.listByAsset(f.asset.id)).toHaveLength(2);
  expect((await f.repository.get(f.user.id, f.batch.id)).items[0].returns).toHaveLength(2);
});
it('keeps a returned preview inactive when the working version changes after confirmation', async () => {
  const f = await prepare();
  const edited = await f.revisions.create({
    assetId: f.asset.id,
    ownerId: f.user.id,
    recipe: defaultDevelopRecipe(),
    recipeVersion: 1,
    label: null,
    status: AssetDevelopRevisionStatus.Rendered,
  });
  await f.revisions.setCurrent(f.asset.id, edited.id);
  const batch = await f.sut.import(f.auth, f.batch.id, f.item.id, f.dto, await stage(f.user.id, f.batch.id, f.bytes));
  const revisionId = batch.returns[0].revisionId!;
  expect(await f.develop.handleRender({ id: revisionId })).toBe(JobStatus.Success);
  expect((await f.revisions.getCurrent(f.asset.id))?.id).toBe(edited.id);
  expect(await new AssetPaletteRepository(db).currentDevelopAssetId(revisionId)).toBeUndefined();
  expect(await new AssetPaletteRepository(db).currentDevelopAssetId(edited.id)).toBe(f.asset.id);
  expect((await f.repository.get(f.user.id, f.batch.id)).items[0].returns[0]).toMatchObject({
    status: 'conflict',
    error: expect.stringContaining('kept inactive'),
  });
  expect((await f.revisions.get(revisionId))?.previewPath).toBeTruthy();
});
it('refuses cross-account ids, tampered confirmation/checksum, changed originals, empty/corrupt/unsupported returns and quota failures without creating versions', async () => {
  const f = await prepare(),
    { user: other } = await f.ctx.newUser();
  await expect(f.sut.get(factory.auth({ user: other }), f.batch.id)).rejects.toThrow('not found');
  await expect(
    f.sut.confirm(f.auth, f.batch.id, {
      files: [{ itemId: randomUUID(), fileName: 'fake.png', checksum: hash(f.bytes) }],
    }),
  ).rejects.toThrow();
  await expect(
    f.sut.import(
      f.auth,
      f.batch.id,
      f.item.id,
      { ...f.dto, confirmationId: randomUUID() },
      await stage(f.user.id, f.batch.id, f.bytes),
    ),
  ).rejects.toThrow('not found');
  await expect(
    f.sut.import(f.auth, f.batch.id, f.item.id, f.dto, await stage(f.user.id, f.batch.id, await image('#445566'))),
  ).rejects.toThrow('intact');
  for (const [bytes, name] of [
    [Buffer.alloc(0), 'empty.png'],
    [Buffer.from('not an image'), 'bad.png'],
    [f.bytes, 'bad.exe'],
  ] as const) {
    await expect(
      f.sut.import(f.auth, f.batch.id, f.item.id, f.dto, await stage(f.user.id, f.batch.id, bytes, name)),
    ).rejects.toThrow();
  }
  await db.updateTable('user').set({ quotaSizeInBytes: 1 }).where('id', '=', f.user.id).execute();
  await expect(
    f.sut.import(f.auth, f.batch.id, f.item.id, f.dto, await stage(f.user.id, f.batch.id, f.bytes)),
  ).rejects.toThrow('full');
  expect(await usage(f.user.id)).toBe(0);
  await db.updateTable('user').set({ quotaSizeInBytes: null }).where('id', '=', f.user.id).execute();
  await writeFile(f.asset.originalPath, await image('#ff0000'));
  await expect(
    f.sut.import(f.auth, f.batch.id, f.item.id, f.dto, await stage(f.user.id, f.batch.id, f.bytes)),
  ).rejects.toThrow('different original');
  expect(await f.revisions.listByAsset(f.asset.id)).toHaveLength(0);
});
it('preserves partial successes, retries a failed render as the same version, and cancels unfinished staging with exact quota release', async () => {
  const f = await prepare();
  const second = await photo(f.ctx, f.user.id);
  const batch = await f.sut.create(f.auth, { assetIds: [f.asset.id, second.id], includeSidecars: false });
  for (const item of batch.items) await f.sut.prepare(f.auth, batch.id, item.id);
  const confirmed = await f.sut.confirm(f.auth, batch.id, {
    files: batch.items.map((item) => ({ itemId: item.id, fileName: 'return.png', checksum: hash(f.bytes) })),
  });
  for (const item of confirmed.items) {
    const r = item.returns[0];
    await f.sut.import(
      f.auth,
      batch.id,
      item.id,
      { confirmationId: r.confirmationId, renditionChecksum: r.checksum },
      await stage(f.user.id, batch.id, f.bytes),
    );
  }
  const imported = await f.sut.get(f.auth, batch.id),
    first = imported.items[0],
    last = imported.items[1];
  expect(await f.develop.handleRender({ id: first.returns[0].revisionId! })).toBe(JobStatus.Success);
  const failing = last.returns[0].revisionId!;
  await f.revisions.update(failing, { status: AssetDevelopRevisionStatus.Failed, error: 'fixture render failure' });
  await f.sut.import(
    f.auth,
    batch.id,
    last.id,
    { confirmationId: last.returns[0].confirmationId, renditionChecksum: hash(f.bytes) },
    undefined,
  );
  expect(await f.revisions.listByAsset(last.assetId!)).toHaveLength(1);
  const staged = await stage(f.user.id, batch.id, f.bytes);
  await f.sut.cancel(f.auth, batch.id);
  expect(await stat(staged.path).catch(() => null)).toBeNull();
  expect((await f.revisions.get(first.returns[0].revisionId!))?.masterPath).toBeTruthy();
  expect((await f.revisions.get(failing))?.masterPath).toBeNull();
  expect(await usage(f.user.id)).toBe(f.bytes.length);
  await f.sut.cancel(f.auth, batch.id);
  expect(await usage(f.user.id)).toBe(f.bytes.length);
});
it('recovers insert-before-queue crashes and serializes quota recount with concurrent admission and deletion', async () => {
  const f = await prepare();
  const staged = await stage(f.user.id, f.batch.id, f.bytes);
  await Promise.all([f.sut.import(f.auth, f.batch.id, f.item.id, f.dto, staged), f.revisions.syncUsage(f.user.id)]);
  expect(await usage(f.user.id)).toBe(f.bytes.length);
  const revision = (await f.revisions.listByAsset(f.asset.id))[0];
  await f.revisions.update(revision.id, { status: AssetDevelopRevisionStatus.Saved });
  await f.sut.recover();
  expect((await f.revisions.get(revision.id))?.status).toBe('queued');
  expect(f.jobs.queueAll).toHaveBeenCalled();
  await Promise.all([f.sut.cancel(f.auth, f.batch.id), f.revisions.syncUsage(f.user.id)]);
  expect(await usage(f.user.id)).toBe(0);
  await f.revisions.releaseBatchMaster(revision.id);
  expect(await usage(f.user.id)).toBe(0);
});

it('persists selection before hashing, resumes preparation after restart and streams headers before waiting for all original checks', async () => {
  const f = setup(),
    { user } = await f.ctx.newUser(),
    { session } = await f.ctx.newSession({ userId: user.id }),
    auth = factory.auth({ user, session });
  const assets = [];
  for (let i = 0; i < 20; i++) assets.push(await photo(f.ctx, user.id));
  const hashes = vi.spyOn(CryptoRepository.prototype, 'hashFile');
  const batch = await f.sut.create(auth, { assetIds: assets.map((asset) => asset.id), includeSidecars: false });
  expect(hashes).not.toHaveBeenCalled();
  expect(batch.items.every((item) => item.preparationStatus === 'pending')).toBe(true);
  await f.sut.prepare(auth, batch.id, batch.items[0].id);
  const restarted = setup();
  expect(
    (await restarted.sut.get(auth, batch.id)).items.filter((item) => item.preparationStatus === 'prepared'),
  ).toHaveLength(1);
  // Simulate death after recording an export but before the item association. The reserved identity reuses it.
  const interrupted = batch.items[1];
  await f.develop.createExport(auth, interrupted.assetId!, interrupted.id);
  for (const item of batch.items.slice(1)) await restarted.sut.prepare(auth, batch.id, item.id);
  expect(await db.selectFrom('develop_export').select('id').where('id', '=', interrupted.id).execute()).toHaveLength(1);
  const originalHash = hashes.getMockImplementation();
  hashes.mockClear();
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => (release = resolve));
  hashes.mockImplementationOnce(async (file, algorithm) => {
    await blocked;
    return originalHash
      ? originalHash(file, algorithm)
      : createHash('sha256')
          .update(await readFile(file))
          .digest();
  });
  const stream = await restarted.sut.download(auth, batch.id);
  const first = await stream[Symbol.asyncIterator]().next();
  expect(first.done).toBe(false);
  expect(hashes.mock.calls.length).toBeLessThan(assets.length);
  release();
  hashes.mockRestore();
  stream.destroy();
});
it('redacts a revoked source while retaining batch membership, progress, cancellation and retries for other photos', async () => {
  const f = await prepare(),
    second = await photo(f.ctx, f.user.id);
  let batch = await f.sut.create(f.auth, { assetIds: [f.asset.id, second.id], includeSidecars: false });
  for (const item of batch.items) await f.sut.prepare(f.auth, batch.id, item.id);
  batch = await f.sut.get(f.auth, batch.id);
  batch = await f.sut.confirm(f.auth, batch.id, {
    files: batch.items.map((item) => ({ fileName: 'return.png', itemId: item.id, checksum: hash(f.bytes) })),
  });
  for (const item of batch.items)
    await f.sut.import(
      f.auth,
      batch.id,
      item.id,
      { confirmationId: item.returns[0].confirmationId, renditionChecksum: hash(f.bytes) },
      await stage(f.user.id, batch.id, f.bytes),
    );
  let status = await f.sut.get(f.auth, batch.id);
  const revoked = status.items[0],
    eligible = status.items[1];
  await f.develop.handleRender({ id: revoked.returns[0].revisionId! });
  await f.revisions.update(eligible.returns[0].revisionId!, { status: AssetDevelopRevisionStatus.Failed });
  await db.updateTable('asset').set({ isOffline: true }).where('id', '=', revoked.assetId!).execute();
  status = await f.sut.get(f.auth, batch.id);
  expect(status.items.find((item) => item.id === revoked.id)).toMatchObject({
    available: false,
    fileName: null,
    exportName: null,
    sourceChecksum: null,
    assetId: null,
    exportId: null,
    returns: [],
    errorCode: 'source_unavailable',
  });
  await f.sut.import(
    f.auth,
    batch.id,
    eligible.id,
    { confirmationId: eligible.returns[0].confirmationId, renditionChecksum: hash(f.bytes) },
    undefined,
  );
  expect((await f.revisions.get(eligible.returns[0].revisionId!))?.status).toBe('queued');
  const staged = await stage(f.user.id, batch.id, f.bytes);
  await f.sut.cancel(f.auth, batch.id);
  expect(await stat(staged.path).catch(() => null)).toBeNull();
  expect((await f.revisions.get(revoked.returns[0].revisionId!))?.masterPath).toBeTruthy();
  await db.deleteFrom('asset').where('id', '=', revoked.assetId!).execute();
  expect((await f.sut.get(f.auth, batch.id)).items).toHaveLength(2);
});
it('keeps render failures inactive and explains them after restart, then retries the same stored version', async () => {
  const f = await prepare();
  const batch = await f.sut.import(f.auth, f.batch.id, f.item.id, f.dto, await stage(f.user.id, f.batch.id, f.bytes));
  const id = batch.returns[0].revisionId!;
  const encode = vi
    .spyOn(f.media, 'encodeDevelopOutput')
    .mockRejectedValue(new Error('/private/fixture: renderer unavailable'));
  expect(await f.develop.handleRender({ id })).toBe(JobStatus.Failed);
  expect(await f.revisions.getCurrent(f.asset.id)).toBeUndefined();
  expect(await f.develop.handleRender({ id })).toBe(JobStatus.Failed);
  expect((await new DevelopBatchRepository(db).get(f.user.id, f.batch.id)).items[0].returns[0]).toMatchObject({
    status: 'failed',
    errorCode: 'render_failed',
    error: 'Preview rendering failed',
  });
  expect(await usage(f.user.id)).toBe(f.bytes.length);
  encode.mockRestore();
  await f.sut.import(f.auth, f.batch.id, f.item.id, f.dto, undefined);
  expect(await f.develop.handleRender({ id })).toBe(JobStatus.Success);
  expect(await f.revisions.listByAsset(f.asset.id)).toHaveLength(1);
});
it('does not adopt a successful preview after live Locked access or original bytes change during rendering', async () => {
  const f = await prepare();
  const batch = await f.sut.import(f.auth, f.batch.id, f.item.id, f.dto, await stage(f.user.id, f.batch.id, f.bytes));
  const id = batch.returns[0].revisionId!;
  const original = f.media.encodeDevelopOutput.bind(f.media);
  vi.spyOn(f.media, 'encodeDevelopOutput').mockImplementation(async (...args) => {
    const output = await original(...args);
    await writeFile(f.asset.originalPath, await image('#aa0000'));
    return output;
  });
  expect(await f.develop.handleRender({ id })).toBe(JobStatus.Failed);
  expect(await f.revisions.getCurrent(f.asset.id)).toBeUndefined();
  expect(await usage(f.user.id)).toBe(0);
});
it('exports only authorized prepared originals and describes exclusions before and inside the ZIP', async () => {
  const f = await prepare(),
    second = await photo(f.ctx, f.user.id);
  let batch = await f.sut.create(f.auth, { assetIds: [f.asset.id, second.id], includeSidecars: false });
  for (const item of batch.items) await f.sut.prepare(f.auth, batch.id, item.id);
  batch = await f.sut.get(f.auth, batch.id);
  const revoked = batch.items[0];
  await db.updateTable('asset').set({ isOffline: true }).where('id', '=', revoked.assetId!).execute();
  const manifest = await f.sut.manifest(f.auth, batch.id);
  expect(manifest.items).toHaveLength(1);
  expect(manifest.skipped).toEqual([{ itemId: revoked.id, reason: 'source_unavailable' }]);
  const stream = await f.sut.download(f.auth, batch.id),
    chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  const archive = join(root, 'partial-authorized.zip');
  await writeFile(archive, Buffer.concat(chunks));
  const entries = execFileSync('unzip', ['-Z1', archive], { encoding: 'utf8' }).trim().split('\n');
  expect(entries).toEqual(['frameleaf-roundtrip.json', manifest.items[0].exportName]);
  const written = JSON.parse(execFileSync('unzip', ['-p', archive, 'frameleaf-roundtrip.json'], { encoding: 'utf8' }));
  expect(written).toEqual(manifest);
  expect(JSON.stringify(written)).not.toContain(revoked.sourceChecksum);
});
it('never unlinks an adopted master when a concurrent identical upload fails or cancellation retains the completed version', async () => {
  const f = await prepare(),
    create = f.revisions.create.bind(f.revisions),
    rename = f.storage.rename.bind(f.storage);
  let release!: () => void,
    entered!: () => void,
    calls = 0;
  const reached = new Promise<void>((resolve) => (entered = resolve)),
    barrier = new Promise<void>((resolve) => (release = resolve));
  vi.spyOn(f.storage, 'rename').mockImplementation(async (from, to) => {
    entered();
    await barrier;
    return rename(from, to);
  });
  vi.spyOn(f.revisions, 'create').mockImplementation(async (input) => {
    if (++calls === 2) throw new Error('fixture interrupted duplicate upload');
    return create(input);
  });
  const first = f.sut.import(f.auth, f.batch.id, f.item.id, f.dto, await stage(f.user.id, f.batch.id, f.bytes));
  await reached;
  const second = f.sut
    .import(f.auth, f.batch.id, f.item.id, f.dto, await stage(f.user.id, f.batch.id, f.bytes))
    .catch((error) => error);
  release();
  const adopted = await first;
  expect(await second).toBeInstanceOf(Error);
  const revisionId = adopted.returns[0].revisionId!;
  expect(await f.develop.handleRender({ id: revisionId })).toBe(JobStatus.Success);
  await f.sut.cancel(f.auth, f.batch.id);
  const revision = await f.revisions.get(revisionId);
  expect(await readFile(revision!.masterPath!)).toEqual(f.bytes);
  expect((await sharp(revision!.masterPath!).metadata()).width).toBe(64);
  expect(await f.revisions.listByAsset(f.asset.id)).toHaveLength(1);
  expect(await usage(f.user.id)).toBe(f.bytes.length);
  const unlink = vi.fn();
  expect(
    (await new PhysicalFileRepository(db).deleteUnreferencedPath(revision!.masterPath!, unlink)).references,
  ).toBeGreaterThan(0);
  expect(unlink).not.toHaveBeenCalled();
});
it('tracks a moved master across a pre-adoption crash and only releases an expired unassociated reservation', async () => {
  const f = await prepare(),
    path = join(root, `${randomUUID()}-pending.png`),
    admission = {
      batchId: f.batch.id,
      itemId: f.item.id,
      confirmationId: f.dto.confirmationId,
      checksum: hash(f.bytes),
      bytes: f.bytes.length,
    };
  expect(await f.revisions.reserveBatchMaster(f.user.id, admission, path)).toMatchObject({ target: path });
  await writeFile(path, f.bytes);
  const physical = new PhysicalFileRepository(db),
    unlink = vi.fn(async () => rm(path, { force: true }));
  expect((await physical.deleteUnreferencedPath(path, unlink)).references).toBeGreaterThan(0);
  expect(unlink).not.toHaveBeenCalled();
  const persisted = await db
    .selectFrom('develop_batch_return')
    .select(['pendingMasterPath', 'revisionId'])
    .where('itemId', '=', f.item.id)
    .executeTakeFirstOrThrow();
  expect(persisted).toEqual({ pendingMasterPath: path, revisionId: null });
  await db
    .updateTable('develop_batch_return')
    .set({ stagedAt: new Date(Date.now() - 25 * 60 * 60 * 1000) })
    .where('itemId', '=', f.item.id)
    .execute();
  await f.sut.cleanupStaging();
  expect(unlink).not.toHaveBeenCalled();
  expect(await stat(path).catch(() => null)).toBeNull();
});
it('serializes cancellation, asset deletion and quota reconciliation without a stranded or double-refunded charge', async () => {
  const f = await prepare();
  await f.sut.import(f.auth, f.batch.id, f.item.id, f.dto, await stage(f.user.id, f.batch.id, f.bytes));
  expect(await usage(f.user.id)).toBe(f.bytes.length);
  await Promise.all([
    f.sut.cancel(f.auth, f.batch.id),
    f.assets.remove({ id: f.asset.id }, { files: () => [], queue: async () => {} }),
    f.revisions.syncUsage(f.user.id),
  ]);
  expect(await usage(f.user.id)).toBe(0);
  await f.revisions.syncUsage(f.user.id);
  expect(await usage(f.user.id)).toBe(0);
  expect((await f.sut.get(f.auth, f.batch.id)).items[0].available).toBe(false);
});
it.each(['original', 'previous version'])(
  'detects an ABA working-selection change back to the %s before preview completion',
  async (mode) => {
    const f = await prepare();
    let expected: string | null = null;
    if (mode === 'previous version') {
      const previous = await f.revisions.create({
        assetId: f.asset.id,
        ownerId: f.user.id,
        recipe: defaultDevelopRecipe(),
        recipeVersion: 1,
        label: null,
        status: AssetDevelopRevisionStatus.Rendered,
      });
      expected = previous.id;
      await f.revisions.setCurrent(f.asset.id, expected);
      const bytes = await image('#001122');
      const confirmed = await f.sut.confirm(f.auth, f.batch.id, {
        files: [{ itemId: f.item.id, fileName: 'corrected.png', checksum: hash(bytes) }],
      });
      const returned = confirmed.items[0].returns.at(-1)!;
      f.bytes = bytes;
      f.dto = { confirmationId: returned.confirmationId, renditionChecksum: hash(bytes) };
    }
    const other = await f.revisions.create({
      assetId: f.asset.id,
      ownerId: f.user.id,
      recipe: defaultDevelopRecipe(),
      recipeVersion: 1,
      label: null,
      status: AssetDevelopRevisionStatus.Rendered,
    });
    await f.revisions.setCurrent(f.asset.id, other.id);
    await f.revisions.setCurrent(f.asset.id, expected);
    const imported = await f.sut.import(
      f.auth,
      f.batch.id,
      f.item.id,
      f.dto,
      await stage(f.user.id, f.batch.id, f.bytes),
    );
    const returned = imported.returns.find((r) => r.checksum === hash(f.bytes))!;
    expect(await f.develop.handleRender({ id: returned.revisionId! })).toBe(JobStatus.Success);
    expect((await f.revisions.getCurrent(f.asset.id))?.id ?? null).toBe(expected);
    expect((await f.sut.get(f.auth, f.batch.id)).items[0].returns.find((r) => r.id === returned.id)).toMatchObject({
      status: 'conflict',
      errorCode: 'current_revision_changed',
    });
    expect((await sharp((await f.revisions.get(returned.revisionId!))!.masterPath!).metadata()).width).toBe(64);
  },
);
it('does not invalidate a confirmation for a same-current selection no-op', async () => {
  const f = await prepare();
  await f.revisions.setCurrent(f.asset.id, null);
  const imported = await f.sut.import(
    f.auth,
    f.batch.id,
    f.item.id,
    f.dto,
    await stage(f.user.id, f.batch.id, f.bytes),
  );
  const returned = imported.returns[0];
  expect(await f.develop.handleRender({ id: returned.revisionId! })).toBe(JobStatus.Success);
  expect((await f.sut.get(f.auth, f.batch.id)).items[0].returns[0].status).toBe('completed');
});

it('handles large batch metadata with bounded insert and status queries', async () => {
  const f = setup();
  const { user } = await f.ctx.newUser();
  const auth = factory.auth({ user });
  const items = Array.from({ length: 14_000 }, (_, index) => ({
    id: randomUUID(),
    assetId: randomUUID(),
    fileName: `photo-${index}.jpg`,
    exportName: `export-${index}.jpg`,
  }));
  const id = await f.repository.create(user.id, false, items);
  const access = vi.spyOn(f.access.asset, 'checkOwnerAccess');
  const batch = await f.sut.get(auth, id);
  expect(batch.items).toHaveLength(items.length);
  expect(batch.items.every((item) => !item.available && item.assetId === null)).toBe(true);
  expect(access.mock.calls.length).toBeLessThan(20);
  const item = await f.repository.get(user.id, id, items[0].id);
  expect(item.items).toHaveLength(1);
  access.mockRestore();
}, 60_000);

it.each(['revoked', 'expired'] as const)(
  'retains an inactive preview when its confirming session is %s',
  async (kind) => {
    const f = await prepare();
    const imported = await f.sut.import(
      f.auth,
      f.batch.id,
      f.item.id,
      f.dto,
      await stage(f.user.id, f.batch.id, f.bytes),
    );
    if (kind === 'revoked') await db.deleteFrom('session').where('id', '=', f.auth.session!.id).execute();
    else
      await db
        .updateTable('session')
        .set({ expiresAt: new Date(Date.now() - 1000) })
        .where('id', '=', f.auth.session!.id)
        .execute();
    const revisionId = imported.returns[0].revisionId!;
    expect(await f.develop.handleRender({ id: revisionId })).toBe(JobStatus.Success);
    expect(await f.revisions.getCurrent(f.asset.id)).toBeUndefined();
    expect((await f.repository.get(f.user.id, f.batch.id)).items[0].returns[0]).toMatchObject({
      status: 'conflict',
      errorCode: 'credential_unavailable',
    });
    expect((await f.revisions.get(revisionId))?.masterPath).toBeTruthy();
  },
);
it('keeps the preview inactive when its confirming locked session loses its PIN grant', async () => {
  const f = await prepare();
  await db.insertInto('asset_lock').values({ assetId: f.asset.id, reason: AssetLockReason.Marked }).execute();
  await db
    .updateTable('session')
    .set({ pinExpiresAt: new Date(Date.now() + 60_000) })
    .where('id', '=', f.auth.session!.id)
    .execute();
  f.auth.session!.hasElevatedPermission = true;
  const bytes = await image('#334455');
  const confirmed = await f.sut.confirm(f.auth, f.batch.id, {
    files: [{ itemId: f.item.id, fileName: 'return.png', checksum: hash(bytes) }],
  });
  const returned = confirmed.items[0].returns.find((r) => r.checksum === hash(bytes))!;
  const imported = await f.sut.import(
    f.auth,
    f.batch.id,
    f.item.id,
    { confirmationId: returned.confirmationId, renditionChecksum: hash(bytes) },
    await stage(f.user.id, f.batch.id, bytes),
  );
  await db
    .updateTable('session')
    .set({ pinExpiresAt: new Date(Date.now() - 1000) })
    .where('id', '=', f.auth.session!.id)
    .execute();
  const revisionId = imported.returns.find((r) => r.id === returned.id)!.revisionId!;
  expect(await f.develop.handleRender({ id: revisionId })).toBe(JobStatus.Success);
  expect(await f.revisions.getCurrent(f.asset.id)).toBeUndefined();
  expect(
    (await f.repository.get(f.user.id, f.batch.id)).items[0].returns.find((r) => r.id === returned.id),
  ).toMatchObject({ status: 'conflict', errorCode: 'credential_unavailable' });
});
it.each(['deleted', 'narrowed'] as const)('does not activate after the confirming API key is %s', async (kind) => {
  const f = await prepare();
  const key = await db
    .insertInto('api_key')
    .values({
      userId: f.user.id,
      name: 'test',
      key: Buffer.from(randomUUID()),
      permissions: [Permission.AssetEditCreate],
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  const auth = factory.auth({ user: f.user, apiKey: { id: key.id, permissions: key.permissions } });
  const bytes = await image('#120034');
  const confirmed = await f.sut.confirm(auth, f.batch.id, {
    files: [{ itemId: f.item.id, fileName: 'return.png', checksum: hash(bytes) }],
  });
  const returned = confirmed.items[0].returns.find((r) => r.checksum === hash(bytes))!;
  const imported = await f.sut.import(
    auth,
    f.batch.id,
    f.item.id,
    { confirmationId: returned.confirmationId, renditionChecksum: hash(bytes) },
    await stage(f.user.id, f.batch.id, bytes),
  );
  if (kind === 'deleted') await db.deleteFrom('api_key').where('id', '=', key.id).execute();
  else await db.updateTable('api_key').set({ permissions: [] }).where('id', '=', key.id).execute();
  expect(await f.develop.handleRender({ id: imported.returns.find((r) => r.id === returned.id)!.revisionId! })).toBe(
    JobStatus.Success,
  );
  expect(await f.revisions.getCurrent(f.asset.id)).toBeUndefined();
  expect(
    (await f.repository.get(f.user.id, f.batch.id)).items[0].returns.find((r) => r.id === returned.id),
  ).toMatchObject({ status: 'conflict', errorCode: 'credential_unavailable' });
});
it.each(['pin expiry', 'session revocation'] as const)(
  'stops a locked original stream at the next bounded check after %s',
  async (kind) => {
    const f = await prepare();
    await db.insertInto('asset_lock').values({ assetId: f.asset.id, reason: AssetLockReason.Marked }).execute();
    await db
      .updateTable('session')
      .set({ pinExpiresAt: new Date(Date.now() + 60_000) })
      .where('id', '=', f.auth.session!.id)
      .execute();
    f.auth.session!.hasElevatedPermission = true;
    const bytes = await readFile(f.asset.originalPath);
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => (release = resolve));
    vi.spyOn(f.storage, 'createPlainReadStream').mockImplementation(
      () =>
        Readable.from(
          (async function* () {
            yield bytes.subarray(0, 10);
            await barrier;
            yield bytes.subarray(10);
          })(),
        ) as never,
    );
    const stream = (f.sut as any).openEntry(f.auth, f.batch.id, f.item, false) as AsyncGenerator<Buffer>;
    expect((await stream.next()).value).toEqual(bytes.subarray(0, 10));
    if (kind === 'pin expiry')
      await db
        .updateTable('session')
        .set({ pinExpiresAt: new Date(Date.now() - 1000) })
        .where('id', '=', f.auth.session!.id)
        .execute();
    else await db.deleteFrom('session').where('id', '=', f.auth.session!.id).execute();
    await new Promise((resolve) => setTimeout(resolve, 550));
    release();
    await expect(stream.next()).rejects.toThrow();
  },
);
it('serializes a live rename with cancellation and never leaves an uncharged master', async () => {
  const f = await prepare();
  let release!: () => void,
    entered!: () => void,
    target = '';
  const barrier = new Promise<void>((resolve) => (release = resolve));
  const reached = new Promise<void>((resolve) => (entered = resolve));
  const rename = f.storage.rename.bind(f.storage);
  vi.spyOn(f.storage, 'rename').mockImplementation(async (from, to) => {
    target = to;
    entered();
    await barrier;
    return rename(from, to);
  });
  const upload = join(root, `${randomUUID()}-inflight.png`);
  await writeFile(upload, f.bytes);
  const pending = f.sut
    .import(f.auth, f.batch.id, f.item.id, f.dto, {
      path: upload,
      originalname: 'return.png',
      size: f.bytes.length,
    } as Express.Multer.File)
    .catch((error) => error);
  await reached;
  let finished = false;
  const cancellation = f.sut.cancel(f.auth, f.batch.id).then(() => {
    finished = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(finished).toBe(false);
  release();
  await Promise.allSettled([pending, cancellation]);
  expect(finished).toBe(true);
  expect(await stat(target).catch(() => null)).toBeNull();
  expect(await usage(f.user.id)).toBe(0);
  expect(
    (
      await db
        .selectFrom('develop_batch_return')
        .select('pendingMasterPath')
        .where('confirmationId', '=', f.dto.confirmationId)
        .executeTakeFirstOrThrow()
    ).pendingMasterPath,
  ).toBeNull();
});
it('confirms overlapping batches in reverse order without deadlock', async () => {
  const f = await prepare(),
    second = await photo(f.ctx, f.user.id);
  const batches = await Promise.all([
    f.sut.create(f.auth, { assetIds: [f.asset.id, second.id], includeSidecars: false }),
    f.sut.create(f.auth, { assetIds: [f.asset.id, second.id], includeSidecars: false }),
  ]);
  await sql`CREATE OR REPLACE FUNCTION test_batch_confirm_pause() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(0.1); RETURN NEW; END $$`.execute(
    db,
  );
  await sql`CREATE TRIGGER test_batch_confirm_pause BEFORE INSERT ON develop_batch_return FOR EACH ROW EXECUTE FUNCTION test_batch_confirm_pause()`.execute(
    db,
  );
  try {
    const files = batches.map((batch, index) =>
      (index ? batch.items.toReversed() : batch.items).map((item) => ({ itemId: item.id, checksum: hash(f.bytes) })),
    );
    await Promise.all(
      batches.map((batch, index) => f.repository.confirm(f.user.id, batch.id, f.auth.session!.id, null, files[index])),
    );
    for (const batch of batches)
      expect((await f.repository.get(f.user.id, batch.id)).items.every((item) => item.returns.length === 1)).toBe(true);
  } finally {
    await sql`DROP TRIGGER test_batch_confirm_pause ON develop_batch_return`.execute(db);
    await sql`DROP FUNCTION test_batch_confirm_pause()`.execute(db);
  }
});
it('pages historical batch summaries without reading batch details', async () => {
  const f = setup(),
    { user } = await f.ctx.newUser(),
    auth = factory.auth({ user });
  for (let i = 0; i < 120; i++) await f.repository.create(user.id, false, []);
  const get = vi.spyOn(f.repository, 'get');
  const all: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await f.sut.list(auth, cursor);
    expect(page.items.length).toBeLessThanOrEqual(50);
    expect(page.items.every((item) => item.itemCount === 0 && !('items' in item))).toBe(true);
    all.push(...page.items.map((item) => item.id));
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  expect(new Set(all).size).toBe(120);
  expect(get).not.toHaveBeenCalled();
});

it('keeps the first confirmation authority when the same bytes are reviewed by a new session', async () => {
  const f = await prepare();
  const { session } = await f.ctx.newSession({ userId: f.user.id });
  const nextAuth = factory.auth({ user: f.user, session });
  await db.deleteFrom('session').where('id', '=', f.auth.session!.id).execute();
  const repeated = await f.sut.confirm(nextAuth, f.batch.id, {
    files: [{ itemId: f.item.id, fileName: 'return.png', checksum: hash(f.bytes) }],
  });
  expect(repeated.items[0].returns[0].confirmationId).toBe(f.dto.confirmationId);
  const imported = await f.sut.import(
    nextAuth,
    f.batch.id,
    f.item.id,
    f.dto,
    await stage(f.user.id, f.batch.id, f.bytes),
  );
  expect(await f.develop.handleRender({ id: imported.returns[0].revisionId! })).toBe(JobStatus.Success);
  expect((await f.repository.get(f.user.id, f.batch.id)).items[0].returns[0]).toMatchObject({
    status: 'conflict',
    errorCode: 'credential_unavailable',
  });
});

it('activates a return when its confirming API key remains authorized', async () => {
  const f = await prepare();
  const key = await db
    .insertInto('api_key')
    .values({
      userId: f.user.id,
      name: 'test',
      key: Buffer.from(randomUUID()),
      permissions: [Permission.AssetEditCreate],
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  const auth = factory.auth({ user: f.user, apiKey: { id: key.id, permissions: key.permissions } });
  const bytes = await image('#888888');
  const confirmed = await f.sut.confirm(auth, f.batch.id, {
    files: [{ itemId: f.item.id, fileName: 'return.png', checksum: hash(bytes) }],
  });
  const returned = confirmed.items[0].returns.find((r) => r.checksum === hash(bytes))!;
  const imported = await f.sut.import(
    auth,
    f.batch.id,
    f.item.id,
    { confirmationId: returned.confirmationId, renditionChecksum: hash(bytes) },
    await stage(f.user.id, f.batch.id, bytes),
  );
  const revisionId = imported.returns.find((r) => r.id === returned.id)!.revisionId!;
  expect(await f.develop.handleRender({ id: revisionId })).toBe(JobStatus.Success);
  expect((await f.revisions.getCurrent(f.asset.id))?.id).toBe(revisionId);
});

it('extracts long UTF-8 original and sidecar names under the filesystem byte limit', async () => {
  const f = setup(),
    { user } = await f.ctx.newUser(),
    { session } = await f.ctx.newSession({ userId: user.id });
  const auth = factory.auth({ user, session });
  const a = await photo(f.ctx, user.id, `${'相'.repeat(71)}.jpg`),
    b = await photo(f.ctx, user.id, `${'相'.repeat(71)}.jpg`);
  const sidecar = join(root, `${randomUUID()}.xmp`);
  await writeFile(sidecar, 'fixture sidecar');
  await db
    .insertInto('asset_file')
    .values({ assetId: a.id, type: 'sidecar' as never, path: sidecar })
    .execute();
  const batch = await f.sut.create(auth, { assetIds: [a.id, b.id], includeSidecars: true });
  for (const item of batch.items) await f.sut.prepare(auth, batch.id, item.id);
  const chunks: Buffer[] = [];
  for await (const chunk of await f.sut.download(auth, batch.id)) chunks.push(Buffer.from(chunk));
  const zip = join(root, `${randomUUID()}.zip`),
    output = join(root, randomUUID());
  await mkdir(output);
  await writeFile(zip, Buffer.concat(chunks));
  execFileSync('unzip', ['-q', zip, '-d', output]);
  const names = await readdir(output);
  expect(names).toHaveLength(4);
  expect(names.every((name) => Buffer.byteLength(name) <= 255)).toBe(true);
  const originals = names.filter((name) => name.endsWith('.jpg'));
  expect(originals).toHaveLength(2);
  expect(new Set(originals).size).toBe(2);
  expect(new Set(await Promise.all(originals.map(async (name) => hash(await readFile(join(output, name))))))).toEqual(
    new Set([hash(await readFile(a.originalPath)), hash(await readFile(b.originalPath))]),
  );
  expect(
    await readFile(
      join(
        output,
        names.find((name) => name.endsWith('.xmp'))!,
      ),
      'utf8',
    ),
  ).toBe('fixture sidecar');
});

it('rejects a rename after cancellation and reclaims a crash-after-move reservation on restart', async () => {
  const f = await prepare();
  const admission = {
    batchId: f.batch.id,
    itemId: f.item.id,
    confirmationId: f.dto.confirmationId,
    checksum: hash(f.bytes),
    bytes: f.bytes.length,
  };
  const target = join(root, `${randomUUID()}-master.png`),
    staged = join(root, `${randomUUID()}-staged.png`);
  await writeFile(staged, f.bytes);
  const cancelledReservation = await f.revisions.reserveBatchMaster(f.user.id, admission, target);
  await f.repository.cancel(f.user.id, f.batch.id);
  const deleted = await new PhysicalFileRepository(db).deleteUnreferencedPath(target, async () =>
    rm(target, { force: true }),
  );
  expect(deleted.references).toBeGreaterThan(0);
  await expect(
    f.revisions.moveBatchMaster(
      f.user.id,
      admission,
      target,
      cancelledReservation.token,
      () => f.storage.rename(staged, target),
      () => Promise.resolve(true),
    ),
  ).rejects.toThrow();
  expect(await stat(target).catch(() => null)).toBeNull();

  const g = await prepare();
  const pending = {
    batchId: g.batch.id,
    itemId: g.item.id,
    confirmationId: g.dto.confirmationId,
    checksum: hash(g.bytes),
    bytes: g.bytes.length,
  };
  const destination = join(root, `${randomUUID()}-crashed.png`),
    upload = join(root, `${randomUUID()}-upload.png`);
  await writeFile(upload, g.bytes);
  const crashReservation = await g.revisions.reserveBatchMaster(g.user.id, pending, destination);
  await expect(
    g.revisions.moveBatchMaster(
      g.user.id,
      pending,
      destination,
      crashReservation.token,
      () => g.storage.rename(upload, destination),
      () => Promise.reject(new Error('simulated death after move')),
    ),
  ).rejects.toThrow('simulated death');
  expect(await readFile(destination)).toEqual(g.bytes);
  await g.repository.cancel(g.user.id, g.batch.id);
  const restarted = setup();
  await restarted.sut.recover();
  expect(await stat(destination).catch(() => null)).toBeNull();
  expect(await usage(g.user.id)).toBe(0);
  expect(
    (
      await db
        .selectFrom('develop_batch_return')
        .select('pendingMasterPath')
        .where('confirmationId', '=', pending.confirmationId)
        .executeTakeFirstOrThrow()
    ).pendingMasterPath,
  ).toBeNull();
});

it('restart cleanup preserves a master referenced by an adopted version', async () => {
  const f = await prepare();
  const imported = await f.sut.import(
    f.auth,
    f.batch.id,
    f.item.id,
    f.dto,
    await stage(f.user.id, f.batch.id, f.bytes),
  );
  const revision = await f.revisions.get(imported.returns[0].revisionId!);
  const next = await f.sut.create(f.auth, { assetIds: [f.asset.id], includeSidecars: false });
  await f.sut.prepare(f.auth, next.id, next.items[0].id);
  const confirmed = await f.sut.confirm(f.auth, next.id, {
    files: [{ itemId: next.items[0].id, fileName: 'return.png', checksum: hash(f.bytes) }],
  });
  await db
    .updateTable('develop_batch_return')
    .set({ pendingMasterPath: revision!.masterPath!, stagedAt: new Date(Date.now() - 25 * 60 * 60 * 1000) })
    .where('id', '=', confirmed.items[0].returns[0].id)
    .execute();
  await setup().sut.recover();
  expect(await readFile(revision!.masterPath!)).toEqual(f.bytes);
  expect(
    (
      await db
        .selectFrom('develop_batch_return')
        .select('pendingMasterPath')
        .where('id', '=', confirmed.items[0].returns[0].id)
        .executeTakeFirstOrThrow()
    ).pendingMasterPath,
  ).toBeNull();
  expect(await usage(f.user.id)).toBe(f.bytes.length);
});

it('cannot adopt a missing master after cleanup unlinks then its transaction rolls back', async () => {
  const f = await prepare();
  const admission = {
    batchId: f.batch.id,
    itemId: f.item.id,
    confirmationId: f.dto.confirmationId,
    checksum: hash(f.bytes),
    bytes: f.bytes.length,
    sourceIdentity: f.asset.checksum,
  };
  const target = join(root, `${randomUUID()}-rollback.png`);
  await f.revisions.reserveBatchMaster(f.user.id, admission, target);
  await writeFile(target, f.bytes);
  await db
    .updateTable('develop_batch_return')
    .set({ stagedAt: new Date(Date.now() - 25 * 60 * 60 * 1000) })
    .where('confirmationId', '=', f.dto.confirmationId)
    .execute();
  await expect(
    f.repository.cleanupPendingMasters(async (path) => {
      await rm(path, { force: true });
      throw new Error('simulated crash before commit');
    }, f.batch.id),
  ).rejects.toThrow();
  expect(
    (
      await db
        .selectFrom('develop_batch_return')
        .select('pendingMasterPath')
        .where('confirmationId', '=', f.dto.confirmationId)
        .executeTakeFirstOrThrow()
    ).pendingMasterPath,
  ).toBe(target);
  await expect(
    f.revisions.create({
      assetId: f.asset.id,
      ownerId: f.user.id,
      recipe: defaultDevelopRecipe(),
      recipeVersion: 1,
      label: null,
      status: AssetDevelopRevisionStatus.Saved,
      sourceChecksum: Buffer.from(f.item.sourceChecksum!, 'hex'),
      exportId: f.item.exportId!,
      masterPath: target,
      batchReturn: admission,
    }),
  ).rejects.toThrow('no longer available');
  expect(await f.revisions.listByAsset(f.asset.id)).toHaveLength(0);
  expect(await usage(f.user.id)).toBe(0);
  await setup().sut.recover();
  expect(
    (
      await db
        .selectFrom('develop_batch_return')
        .select('pendingMasterPath')
        .where('confirmationId', '=', f.dto.confirmationId)
        .executeTakeFirstOrThrow()
    ).pendingMasterPath,
  ).toBeNull();
});

it('promptly removes every quota-rejected master without charging bytes', async () => {
  const f = await prepare();
  await db.updateTable('user').set({ quotaSizeInBytes: 1 }).where('id', '=', f.user.id).execute();
  const targets: string[] = [],
    rename = f.storage.rename.bind(f.storage);
  vi.spyOn(f.storage, 'rename').mockImplementation(async (from, to) => {
    targets.push(to);
    return rename(from, to);
  });
  for (const color of ['#102030', '#203040', '#304050']) {
    const bytes = await image(color),
      checksum = hash(bytes);
    const batch = await f.sut.confirm(f.auth, f.batch.id, {
      files: [{ itemId: f.item.id, fileName: 'return.png', checksum }],
    });
    const returned = batch.items[0].returns.find((row) => row.checksum === checksum)!;
    const staged = await stage(f.user.id, f.batch.id, bytes);
    await expect(
      f.sut.import(
        f.auth,
        f.batch.id,
        f.item.id,
        { confirmationId: returned.confirmationId, renditionChecksum: checksum },
        staged,
      ),
    ).rejects.toThrow('full');
    expect(await stat(staged.path).catch(() => null)).toBeNull();
    expect(
      (
        await db
          .selectFrom('develop_batch_return')
          .select('pendingMasterPath')
          .where('id', '=', returned.id)
          .executeTakeFirstOrThrow()
      ).pendingMasterPath,
    ).toBeNull();
  }
  expect(targets).toHaveLength(0);
  expect(await usage(f.user.id)).toBe(0);
  expect(await f.revisions.listByAsset(f.asset.id)).toHaveLength(0);
});

it('preserves a successful competing retry before the failed attempt cleans its reservation', async () => {
  const f = await prepare();
  await db.updateTable('user').set({ quotaSizeInBytes: 1 }).where('id', '=', f.user.id).execute();
  let release!: () => void, entered!: () => void;
  const reached = new Promise<void>((resolve) => (entered = resolve)),
    barrier = new Promise<void>((resolve) => (release = resolve));
  const cleanup = f.revisions.cleanupFailedBatchMaster.bind(f.revisions);
  vi.spyOn(f.revisions, 'cleanupFailedBatchMaster').mockImplementation(async (...args) => {
    entered();
    await barrier;
    return cleanup(...args);
  });
  const first = f.sut
    .import(f.auth, f.batch.id, f.item.id, f.dto, await stage(f.user.id, f.batch.id, f.bytes))
    .catch((error) => error);
  await reached;
  await db.updateTable('user').set({ quotaSizeInBytes: null }).where('id', '=', f.user.id).execute();
  const second = await f.sut.import(f.auth, f.batch.id, f.item.id, f.dto, await stage(f.user.id, f.batch.id, f.bytes));
  const revision = await f.revisions.get(second.returns[0].revisionId!);
  expect(await readFile(revision!.masterPath!)).toEqual(f.bytes);
  release();
  expect(await first).toBeInstanceOf(Error);
  expect(await readFile(revision!.masterPath!)).toEqual(f.bytes);
  expect(await usage(f.user.id)).toBe(f.bytes.length);
  expect(await f.revisions.listByAsset(f.asset.id)).toHaveLength(1);
});
it('serializes selection with an in-flight batch import without a lock cycle', async () => {
  const f = await prepare(),
    rename = f.storage.rename.bind(f.storage);
  const selectedVersion = await f.revisions.create({
    assetId: f.asset.id,
    ownerId: f.user.id,
    recipe: defaultDevelopRecipe(),
    recipeVersion: 1,
    label: null,
    status: AssetDevelopRevisionStatus.Rendered,
  });
  let release!: () => void,
    entered!: () => void,
    selected = false;
  const reached = new Promise<void>((resolve) => (entered = resolve)),
    barrier = new Promise<void>((resolve) => (release = resolve));
  vi.spyOn(f.storage, 'rename').mockImplementation(async (from, to) => {
    entered();
    await barrier;
    return rename(from, to);
  });
  const importing = f.sut.import(f.auth, f.batch.id, f.item.id, f.dto, await stage(f.user.id, f.batch.id, f.bytes));
  await reached;
  const selection = f.revisions.setCurrent(f.asset.id, selectedVersion.id).then(() => {
    selected = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(selected).toBe(false);
  release();
  await Promise.all([importing, selection]);
  expect(selected).toBe(true);
  expect((await f.revisions.getCurrent(f.asset.id))?.id).toBe(selectedVersion.id);
});

it('recovers a quota failure interrupted before prompt cleanup', async () => {
  const f = await prepare();
  await db.updateTable('user').set({ quotaSizeInBytes: 1 }).where('id', '=', f.user.id).execute();
  const admission = {
    batchId: f.batch.id,
    itemId: f.item.id,
    confirmationId: f.dto.confirmationId,
    checksum: hash(f.bytes),
    bytes: f.bytes.length,
  };
  const target = join(root, `${randomUUID()}-pending.png`);
  const reservation = await f.revisions.reserveBatchMaster(f.user.id, admission, target);
  await writeFile(target, f.bytes);
  const move = vi.fn(),
    adopt = vi.fn();
  const result = await f.revisions.moveBatchMaster(f.user.id, admission, target, reservation.token, move, adopt);
  expect(result).toEqual({ quotaExceeded: true });
  expect(move).not.toHaveBeenCalled();
  expect(adopt).not.toHaveBeenCalled();
  expect(
    await db
      .selectFrom('develop_batch_return')
      .select(['status', 'pendingMasterPath'])
      .where('confirmationId', '=', admission.confirmationId)
      .executeTakeFirstOrThrow(),
  ).toEqual({ status: 'failed', pendingMasterPath: target });
  await setup().sut.recover();
  expect(await stat(target).catch(() => null)).toBeNull();
  expect(
    (
      await db
        .selectFrom('develop_batch_return')
        .select('pendingMasterPath')
        .where('confirmationId', '=', admission.confirmationId)
        .executeTakeFirstOrThrow()
    ).pendingMasterPath,
  ).toBeNull();
  expect(await usage(f.user.id)).toBe(0);
});

it('does not mark a renewed pending retry failed from a stale error', async () => {
  const f = await prepare();
  const admission = {
    batchId: f.batch.id,
    itemId: f.item.id,
    confirmationId: f.dto.confirmationId,
    checksum: hash(f.bytes),
    bytes: f.bytes.length,
  };
  const target = join(root, `${randomUUID()}-renewed.png`);
  await f.revisions.reserveBatchMaster(f.user.id, admission, target);
  await f.repository.fail(f.user.id, f.batch.id, f.item.id, f.dto.confirmationId, 'import_rejected');
  expect(
    await db
      .selectFrom('develop_batch_return')
      .select(['status', 'pendingMasterPath'])
      .where('confirmationId', '=', f.dto.confirmationId)
      .executeTakeFirstOrThrow(),
  ).toEqual({ status: 'confirmed', pendingMasterPath: target });
  await f.sut.cleanupStaging();
  expect(
    (
      await db
        .selectFrom('develop_batch_return')
        .select('pendingMasterPath')
        .where('confirmationId', '=', f.dto.confirmationId)
        .executeTakeFirstOrThrow()
    ).pendingMasterPath,
  ).toBe(target);
});

it('serializes asset deletion with import without an asset and user lock cycle', async () => {
  const f = await prepare(),
    rename = f.storage.rename.bind(f.storage);
  let release!: () => void,
    entered!: () => void,
    deleted = false;
  const reached = new Promise<void>((resolve) => (entered = resolve)),
    barrier = new Promise<void>((resolve) => (release = resolve));
  vi.spyOn(f.storage, 'rename').mockImplementation(async (from, to) => {
    entered();
    await barrier;
    return rename(from, to);
  });
  const importing = f.sut.import(f.auth, f.batch.id, f.item.id, f.dto, await stage(f.user.id, f.batch.id, f.bytes));
  const settledImport = importing.catch((error) => error);
  await reached;
  const deleting = f.assets.remove({ id: f.asset.id }, { files: () => [], queue: async () => {} }).then(() => {
    deleted = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(deleted).toBe(false);
  release();
  await Promise.all([settledImport, deleting]);
  expect(deleted).toBe(true);
  await f.revisions.syncUsage(f.user.id);
  expect(await usage(f.user.id)).toBe(0);
});

it('keeps a renewed retry usable while older quota cleanup runs before its move', async () => {
  const f = await prepare();
  await db.updateTable('user').set({ quotaSizeInBytes: 1 }).where('id', '=', f.user.id).execute();
  let cleanupEntered!: () => void,
    releaseCleanup!: () => void,
    moveEntered!: () => void,
    releaseMove!: () => void,
    moves = 0;
  const cleanupReached = new Promise<void>((resolve) => (cleanupEntered = resolve)),
    cleanupBarrier = new Promise<void>((resolve) => (releaseCleanup = resolve));
  const moveReached = new Promise<void>((resolve) => (moveEntered = resolve)),
    moveBarrier = new Promise<void>((resolve) => (releaseMove = resolve));
  const cleanup = f.revisions.cleanupFailedBatchMaster.bind(f.revisions),
    move = f.revisions.moveBatchMaster.bind(f.revisions);
  vi.spyOn(f.revisions, 'cleanupFailedBatchMaster').mockImplementation(async (...args) => {
    cleanupEntered();
    await cleanupBarrier;
    return cleanup(...args);
  });
  vi.spyOn(f.revisions, 'moveBatchMaster').mockImplementation(async (...args) => {
    if (++moves === 2) {
      moveEntered();
      await moveBarrier;
    }
    return move(...args);
  });
  const first = f.sut
    .import(f.auth, f.batch.id, f.item.id, f.dto, await stage(f.user.id, f.batch.id, f.bytes))
    .catch((error) => error);
  await cleanupReached;
  await db.updateTable('user').set({ quotaSizeInBytes: null }).where('id', '=', f.user.id).execute();
  const second = f.sut.import(f.auth, f.batch.id, f.item.id, f.dto, await stage(f.user.id, f.batch.id, f.bytes));
  await moveReached;
  releaseCleanup();
  expect(await first).toBeInstanceOf(Error);
  expect(
    (
      await db
        .selectFrom('develop_batch_return')
        .select('pendingMasterPath')
        .where('confirmationId', '=', f.dto.confirmationId)
        .executeTakeFirstOrThrow()
    ).pendingMasterPath,
  ).toBeTruthy();
  releaseMove();
  const imported = await second;
  const revision = await f.revisions.get(imported.returns[0].revisionId!);
  expect(await readFile(revision!.masterPath!)).toEqual(f.bytes);
  expect(await usage(f.user.id)).toBe(f.bytes.length);
});
it('does not let an older failed generation clean a newer failed reservation', async () => {
  const f = await prepare();
  await db.updateTable('user').set({ quotaSizeInBytes: 1 }).where('id', '=', f.user.id).execute();
  const admission = {
    batchId: f.batch.id,
    itemId: f.item.id,
    confirmationId: f.dto.confirmationId,
    checksum: hash(f.bytes),
    bytes: f.bytes.length,
  };
  const target = join(root, `${randomUUID()}-generation.png`);
  const first = await f.revisions.reserveBatchMaster(f.user.id, admission, target);
  await writeFile(target, f.bytes);
  expect(await f.revisions.moveBatchMaster(f.user.id, admission, target, first.token, vi.fn(), vi.fn())).toEqual({
    quotaExceeded: true,
  });
  const second = await f.revisions.reserveBatchMaster(f.user.id, admission, target);
  expect(second.token).not.toBe(first.token);
  expect(await f.revisions.moveBatchMaster(f.user.id, admission, target, second.token, vi.fn(), vi.fn())).toEqual({
    quotaExceeded: true,
  });
  await f.revisions.cleanupFailedBatchMaster(f.user.id, admission, target, first.token, () =>
    rm(target, { force: true }),
  );
  expect(await readFile(target)).toEqual(f.bytes);
  await f.revisions.cleanupFailedBatchMaster(f.user.id, admission, target, second.token, () =>
    rm(target, { force: true }),
  );
  expect(await stat(target).catch(() => null)).toBeNull();
});

it('does not mark a newer pending generation failed when an older preflight is rejected', async () => {
  const f = await prepare();
  await db.updateTable('user').set({ quotaSizeInBytes: 1 }).where('id', '=', f.user.id).execute();
  const admission = {
    batchId: f.batch.id,
    itemId: f.item.id,
    confirmationId: f.dto.confirmationId,
    checksum: hash(f.bytes),
    bytes: f.bytes.length,
  };
  const target = join(root, `${randomUUID()}-pending.png`);
  const first = await f.revisions.reserveBatchMaster(f.user.id, admission, target);
  const second = await f.revisions.reserveBatchMaster(f.user.id, admission, target);
  expect(first.token).not.toBe(second.token);
  expect(await f.revisions.moveBatchMaster(f.user.id, admission, target, first.token, vi.fn(), vi.fn())).toEqual({
    quotaExceeded: true,
  });
  expect(
    (
      await db
        .selectFrom('develop_batch_return')
        .select('status')
        .where('confirmationId', '=', admission.confirmationId)
        .executeTakeFirstOrThrow()
    ).status,
  ).toBe('confirmed');
  await f.revisions.cleanupFailedBatchMaster(f.user.id, admission, target, first.token, () =>
    rm(target, { force: true }),
  );
  expect(
    (
      await db
        .selectFrom('develop_batch_return')
        .select('pendingMasterPath')
        .where('confirmationId', '=', admission.confirmationId)
        .executeTakeFirstOrThrow()
    ).pendingMasterPath,
  ).toBe(target);
});
