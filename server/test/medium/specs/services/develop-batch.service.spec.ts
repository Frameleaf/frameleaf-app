import { Kysely } from 'kysely';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { StorageCore } from 'src/cores/storage.core.js';
import { AssetDevelopRevisionStatus } from 'src/dtos/asset-develop.dto.js';
import { AssetType, ChecksumAlgorithm, JobName, JobStatus } from 'src/enum.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { AssetDevelopRepository } from 'src/repositories/asset-develop.repository.js';
import { AssetJobRepository } from 'src/repositories/asset-job.repository.js';
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
  return { ctx, revisions, repository, develop, sut, media, jobs, assets, access };
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
    auth = factory.auth({ user }),
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
    auth = factory.auth({ user });
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
    auth = factory.auth({ user });
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
    create = f.revisions.create.bind(f.revisions);
  let calls = 0,
    releaseFailure!: () => void,
    bothEntered!: () => void;
  const both = new Promise<void>((resolve) => (bothEntered = resolve));
  const heldFailure = new Promise<void>((resolve) => (releaseFailure = resolve));
  vi.spyOn(f.revisions, 'create').mockImplementation(async (input) => {
    calls++;
    if (calls === 2) {
      bothEntered();
      await heldFailure;
      throw new Error('fixture interrupted duplicate upload');
    }
    await both;
    return create(input);
  });
  const first = f.sut.import(f.auth, f.batch.id, f.item.id, f.dto, await stage(f.user.id, f.batch.id, f.bytes));
  const second = f.sut.import(f.auth, f.batch.id, f.item.id, f.dto, await stage(f.user.id, f.batch.id, f.bytes));
  const adopted = await first;
  const revisionId = adopted.returns[0].revisionId!;
  expect(await f.develop.handleRender({ id: revisionId })).toBe(JobStatus.Success);
  const cancel = f.sut.cancel(f.auth, f.batch.id);
  releaseFailure();
  await Promise.allSettled([second, cancel]);
  const revision = await f.revisions.get(revisionId);
  expect(revision?.masterPath).toBeTruthy();
  expect(await readFile(revision!.masterPath!)).toEqual(f.bytes);
  expect((await sharp(revision!.masterPath!).metadata()).width).toBe(64);
  expect(await f.revisions.listByAsset(f.asset.id)).toHaveLength(1);
  expect(await usage(f.user.id)).toBe(f.bytes.length);
  const unlink = vi.fn();
  const result = await new PhysicalFileRepository(db).deleteUnreferencedPath(revision!.masterPath!, unlink);
  expect(result.references).toBeGreaterThan(0);
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
  expect(await f.revisions.reserveBatchMaster(f.user.id, admission, path)).toBe(path);
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
  expect(f.jobs.queue).toHaveBeenCalledWith({ name: JobName.FileDelete, data: { files: [path] } });
  await physical.deleteUnreferencedPath(path, unlink);
  expect(unlink).toHaveBeenCalledOnce();
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
