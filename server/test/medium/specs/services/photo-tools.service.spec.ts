import { ConflictException } from '@nestjs/common';
import { Kysely, sql } from 'kysely';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { StorageCore } from 'src/cores/storage.core.js';
import {
  AssetDevelopMaskKind,
  AssetDevelopRevisionKind,
  AssetDevelopRevisionStatus,
} from 'src/dtos/asset-develop.dto.js';
import { AssetType, AssetVisibility, ChecksumAlgorithm, JobName, JobStatus } from 'src/enum.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { AssetDevelopRepository } from 'src/repositories/asset-develop.repository.js';
import { AssetJobRepository } from 'src/repositories/asset-job.repository.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { CryptoRepository } from 'src/repositories/crypto.repository.js';
import { IntegrityRepository } from 'src/repositories/integrity.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MediaOperationRepository } from 'src/repositories/media-operation.repository.js';
import { MediaRepository } from 'src/repositories/media.repository.js';
import { PhotoToolsRepository } from 'src/repositories/photo-tools.repository.js';
import { StorageRepository } from 'src/repositories/storage.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { DB } from 'src/schema/index.js';
import { AssetDevelopService, developImportStagingFolder } from 'src/services/asset-develop.service.js';
import { BaseService } from 'src/services/base.service.js';
import { PhotoToolsService } from 'src/services/photo-tools.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { factory } from 'test/small.factory.js';
import { getKyselyDB } from 'test/utils.js';

/**
 * Photo tools and derivative privacy (FL-64), against a real database, real files and the real
 * image pipeline: the external development round trip (interrupted import, wrong original,
 * hidden parent, failed preview) and how a derivative follows its parent's privacy and cleanup.
 */

let database: Kysely<DB>;
let root: string;

const logger = () =>
  ({
    setContext: () => {},
    log: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    verbose: () => {},
  }) as never;

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest();

const setup = () => {
  const { ctx } = newMediumService(BaseService, { database, real: [], mock: [LoggingRepository] });
  const job = { queue: vi.fn().mockResolvedValue(undefined), queueAll: vi.fn().mockResolvedValue(undefined) };
  const develop = new AssetDevelopRepository(database);
  const photoTools = new PhotoToolsRepository(database);
  const sut = new AssetDevelopService(
    logger(),
    new AccessRepository(database),
    new AssetRepository(database),
    new AssetJobRepository(database),
    develop,
    new ConfigRepository(),
    new CryptoRepository(),
    job as never,
    new MediaRepository(logger()),
    photoTools,
    new StorageRepository(logger()),
    new SystemMetadataRepository(database),
    new MediaOperationRepository(database),
  );
  const presets = new PhotoToolsService(logger(), photoTools);
  return { ctx, sut, presets, job, develop, integrity: new IntegrityRepository(database) };
};

/** A real JPEG original on disk and its asset row, as an upload leaves them. */
const newPhoto = async (
  ctx: ReturnType<typeof setup>['ctx'],
  ownerId: string,
  overrides: Record<string, unknown> = {},
) => {
  const originalPath = join(root, 'library', `${Math.random().toString(36).slice(2)}.jpg`);
  // Every photo is distinct, as the per-owner checksum key requires.
  const shade = Math.floor(Math.random() * 0xff_ff_ff);
  const bytes = await sharp({
    create: { width: 64, height: 48, channels: 3, background: `#${shade.toString(16).padStart(6, '0')}` },
  })
    .jpeg()
    .toBuffer();
  await writeFile(originalPath, bytes);
  const { asset } = await ctx.newAsset({
    ownerId,
    type: AssetType.Image,
    originalPath,
    originalFileName: 'IMG_0001.jpg',
    checksum: createHash('sha1').update(bytes).digest(),
    checksumAlgorithm: ChecksumAlgorithm.sha1File,
    ...overrides,
  });
  await ctx.newExif({ assetId: asset.id, make: 'Canon', model: 'EOS', colorspace: 'sRGB' });
  return { asset, bytes };
};

/** A developed file staged by the upload, as multer leaves it before the service decides. */
const stage = async (ownerId: string, bytes: Buffer, originalname = 'IMG_0001-edit.tif') => {
  const folder = developImportStagingFolder(ownerId);
  await mkdir(folder, { recursive: true });
  const path = join(folder, `${Math.random().toString(36).slice(2)}.partial`);
  await writeFile(path, bytes);
  return { path, originalname, size: bytes.length };
};

const developed = () =>
  sharp({ create: { width: 64, height: 48, channels: 3, background: '#a08060' } })
    .tiff()
    .toBuffer();

const exists = (path: string) =>
  stat(path)
    .then(() => true)
    .catch(() => false);

beforeAll(async () => {
  database = await getKyselyDB();
  root = await mkdtemp(join(tmpdir(), 'fl64-'));
  StorageCore.setMediaLocation(root);
  await mkdir(join(root, 'library'), { recursive: true });
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('photo tools round trip (FL-64)', () => {
  it('brings a developed file back against its export, renders its preview and only then makes it current', async () => {
    const { ctx, sut, job, develop } = setup();
    const { user } = await ctx.newUser();
    const auth = factory.auth({ user });
    const { asset, bytes } = await newPhoto(ctx, user.id);

    const exported = await sut.createExport(auth, asset.id);
    expect(exported.sourceChecksum).toBe(sha256(bytes).toString('hex'));
    expect(exported.isCurrentOriginal).toBe(true);

    const file = await developed();
    const staged = await stage(user.id, file);
    const revision = await sut.importRendition(
      auth,
      asset.id,
      { exportId: exported.id, renditionChecksum: sha256(file).toString('hex'), software: 'darktable' },
      staged,
    );

    expect(revision).toMatchObject({
      kind: AssetDevelopRevisionKind.External,
      status: AssetDevelopRevisionStatus.Queued,
      exportId: exported.id,
      sourceChecksum: sha256(bytes).toString('hex'),
      renditionChecksum: sha256(file).toString('hex'),
      software: 'darktable',
      isCurrent: false,
    });
    expect(await exists(staged.path)).toBe(false);
    // Only the preview render is queued: no thumbnail, search or machine-learning work on a derivative.
    expect(job.queue.mock.calls.map(([item]) => item.name)).toEqual([JobName.AssetDevelopRender]);

    await expect(sut.handleRender({ id: revision.id })).resolves.toBe(JobStatus.Success);
    const stored = await develop.get(revision.id);
    expect(stored).toMatchObject({
      status: AssetDevelopRevisionStatus.Rendered,
      isCurrent: true,
      width: 64,
      height: 48,
    });
    expect(await readFile(stored!.masterPath!)).toEqual(file);
    expect(await exists(stored!.previewPath!)).toBe(true);
    // The original is untouched.
    expect(await readFile(asset.originalPath)).toEqual(bytes);
  });

  it('keeps nothing from an interrupted transfer, and the working version stays', async () => {
    const { ctx, sut, develop } = setup();
    const { user } = await ctx.newUser();
    const auth = factory.auth({ user });
    const { asset } = await newPhoto(ctx, user.id);
    const exported = await sut.createExport(auth, asset.id);

    const file = await developed();
    const good = await sut.importRendition(auth, asset.id, { exportId: exported.id }, await stage(user.id, file));
    await sut.handleRender({ id: good.id });

    const truncated = await stage(user.id, file.subarray(0, Math.floor(file.length / 2)));
    await expect(
      sut.importRendition(
        auth,
        asset.id,
        { exportId: exported.id, renditionChecksum: sha256(file).toString('hex') },
        truncated,
      ),
    ).rejects.toThrow('did not arrive intact');

    expect(await exists(truncated.path)).toBe(false);
    const rows = await develop.listByAsset(asset.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: good.id, isCurrent: true });
  });

  it('refuses a file developed from a different original, or answering another photo', async () => {
    const { ctx, sut, develop } = setup();
    const { user } = await ctx.newUser();
    const auth = factory.auth({ user });
    const { asset } = await newPhoto(ctx, user.id);
    const { asset: other } = await newPhoto(ctx, user.id);
    const exported = await sut.createExport(auth, asset.id);
    const otherExport = await sut.createExport(auth, other.id);
    const file = await developed();

    // An export of another photo.
    const first = await stage(user.id, file);
    await expect(sut.importRendition(auth, asset.id, { exportId: otherExport.id }, first)).rejects.toThrow(
      'That export was not made from this photo',
    );
    expect(await exists(first.path)).toBe(false);

    // A checksum that is not this original's.
    await expect(
      sut.importRendition(auth, asset.id, { sourceChecksum: 'ab'.repeat(32) }, await stage(user.id, file)),
    ).rejects.toBeInstanceOf(ConflictException);

    // The original replaced after the export: the export no longer answers it.
    const replaced = await sharp({ create: { width: 32, height: 32, channels: 3, background: '#000000' } })
      .jpeg()
      .toBuffer();
    await writeFile(asset.originalPath, replaced);
    await expect(sut.listExports(auth, asset.id)).resolves.toEqual([
      expect.objectContaining({ id: exported.id, isCurrentOriginal: false }),
    ]);
    await expect(
      sut.importRendition(auth, asset.id, { exportId: exported.id }, await stage(user.id, file)),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(await develop.listByAsset(asset.id)).toEqual([]);
  });

  it('fails a preview that cannot render and leaves the prior working version current', async () => {
    const { ctx, sut, job, develop } = setup();
    const { user } = await ctx.newUser();
    const auth = factory.auth({ user });
    const { asset } = await newPhoto(ctx, user.id);
    const exported = await sut.createExport(auth, asset.id);

    const good = await sut.importRendition(
      auth,
      asset.id,
      { exportId: exported.id },
      await stage(user.id, await developed()),
    );
    await sut.handleRender({ id: good.id });

    // Not an image at all: refused before anything is kept.
    const garbage = await stage(user.id, Buffer.from('not an image at all'), 'broken.jpg');
    await expect(sut.importRendition(auth, asset.id, { exportId: exported.id }, garbage)).rejects.toThrow(
      'not a readable image',
    );
    expect(await exists(garbage.path)).toBe(false);

    // A JPEG whose header reads but whose image data is cut off: kept, and its preview fails.
    const jpeg = await sharp({
      create: {
        width: 256,
        height: 256,
        channels: 3,
        background: '#808080',
        noise: { type: 'gaussian', mean: 128, sigma: 40 },
      },
    })
      .jpeg()
      .toBuffer();
    const broken = await sut.importRendition(
      auth,
      asset.id,
      { exportId: exported.id },
      await stage(user.id, jpeg.subarray(0, Math.floor(jpeg.length / 3)), 'broken.jpg'),
    );
    job.queue.mockClear();

    // First failure: one automatic retry is queued, after a delay.
    await expect(sut.handleRender({ id: broken.id })).resolves.toBe(JobStatus.Failed);
    expect(job.queue).toHaveBeenCalledWith({
      name: JobName.AssetDevelopRender,
      data: { id: broken.id, delay: expect.any(Number) },
    });
    expect(await develop.get(broken.id)).toMatchObject({ status: AssetDevelopRevisionStatus.Queued, attempts: 1 });

    // The retry fails too: reported, no further retry.
    job.queue.mockClear();
    await expect(sut.handleRender({ id: broken.id })).resolves.toBe(JobStatus.Failed);
    expect(job.queue).not.toHaveBeenCalled();
    expect(await develop.get(broken.id)).toMatchObject({ status: AssetDevelopRevisionStatus.Failed, attempts: 2 });

    expect(await develop.getCurrent(asset.id)).toMatchObject({ id: good.id });
  });
});

describe('derivative privacy (FL-64)', () => {
  it('reaches a Locked parent only from its owner in an unlocked session', async () => {
    const { ctx, sut, develop } = setup();
    const { user } = await ctx.newUser();
    const { user: partner } = await ctx.newUser();
    await ctx.newPartner({ sharedById: user.id, sharedWithId: partner.id });
    const { asset } = await newPhoto(ctx, user.id, { visibility: AssetVisibility.Locked });
    const locked = await database.selectFrom('asset_lock').select('assetId').where('assetId', '=', asset.id).execute();
    expect(locked).toHaveLength(1);

    const ordinary = factory.auth({ user });
    const elevated = factory.auth({ user, session: { hasElevatedPermission: true } });
    const partnerAuth = factory.auth({ user: partner, session: { hasElevatedPermission: true } });
    const sharedLink = factory.auth({ user, sharedLink: { allowDownload: true, allowUpload: true } });

    for (const auth of [ordinary, partnerAuth, sharedLink]) {
      await expect(sut.createExport(auth, asset.id)).rejects.toThrow();
      await expect(sut.listExports(auth, asset.id)).rejects.toThrow();
      await expect(sut.get(auth, asset.id)).rejects.toThrow();
      const staged = await stage(user.id, await developed());
      await expect(sut.importRendition(auth, asset.id, { sourceChecksum: 'ab'.repeat(32) }, staged)).rejects.toThrow();
      expect(await exists(staged.path)).toBe(false);
    }
    expect(await develop.listByAsset(asset.id)).toEqual([]);

    const exported = await sut.createExport(elevated, asset.id);
    const revision = await sut.importRendition(
      elevated,
      asset.id,
      { exportId: exported.id },
      await stage(user.id, await developed()),
    );
    await expect(sut.handleRender({ id: revision.id })).resolves.toBe(JobStatus.Success);

    // A background render always reaches Locked media; the rendered files stay behind the same boundary.
    await expect(sut.getFile(ordinary, asset.id, revision.id, 'preview' as never)).rejects.toThrow();
    await expect(sut.getFile(partnerAuth, asset.id, revision.id, 'preview' as never)).rejects.toThrow();
    await expect(sut.getFile(elevated, asset.id, revision.id, 'preview' as never)).resolves.toBeDefined();
  });

  it('refuses a trashed or hidden parent', async () => {
    const { ctx, sut } = setup();
    const { user } = await ctx.newUser();
    const auth = factory.auth({ user });
    const { asset: trashed } = await newPhoto(ctx, user.id, { deletedAt: new Date() });
    const { asset: hidden } = await newPhoto(ctx, user.id, { visibility: AssetVisibility.Hidden });
    for (const asset of [trashed, hidden]) {
      await expect(sut.createExport(auth, asset.id)).rejects.toThrow();
      const staged = await stage(user.id, await developed());
      await expect(sut.importRendition(auth, asset.id, { sourceChecksum: 'ab'.repeat(32) }, staged)).rejects.toThrow();
      expect(await exists(staged.path)).toBe(false);
    }
  });

  it('counts develop files as tracked, and removes them with their parent', async () => {
    const { ctx, sut, job, develop, integrity } = setup();
    const { user } = await ctx.newUser();
    const auth = factory.auth({ user });
    const { asset } = await newPhoto(ctx, user.id);
    const exported = await sut.createExport(auth, asset.id);
    const revision = await sut.importRendition(
      auth,
      asset.id,
      { exportId: exported.id },
      await stage(user.id, await developed()),
    );
    await sut.handleRender({ id: revision.id });
    const stored = (await develop.get(revision.id))!;

    const tracked = await integrity.getTrackedPaths([stored.masterPath!, stored.previewPath!, '/elsewhere/orphan.jpg']);
    expect(tracked.map(({ path }) => path)).toEqual(expect.arrayContaining([stored.masterPath, stored.previewPath]));
    expect(tracked).toHaveLength(2);

    job.queue.mockClear();
    await sut.onAssetDelete({ assetId: asset.id, userId: user.id });
    expect(await develop.listByAsset(asset.id)).toEqual([]);
    expect(job.queue).toHaveBeenCalledWith({
      name: JobName.FileDelete,
      data: { files: expect.arrayContaining([stored.masterPath, stored.previewPath]) },
    });

    await database.deleteFrom('asset').where('id', '=', asset.id).execute();
    await expect(
      database.selectFrom('develop_export').select('id').where('assetId', '=', asset.id).execute(),
    ).resolves.toEqual([]);
  });

  it('keeps presets private to their owner, with unique names, and removes them with the account', async () => {
    const { ctx, presets } = setup();
    const { user } = await ctx.newUser();
    const { user: other } = await ctx.newUser();
    const mine = factory.auth({ user });
    const theirs = factory.auth({ user: other });

    const created = await presets.createPreset(mine, {
      name: 'Golden hour',
      settings: {
        temperature: 25,
        masks: [{ id: 'sky', kind: AssetDevelopMaskKind.Linear, x: 0.5, y: 0, adjustments: { exposure: -0.5 } }],
      } as never,
    });
    expect(created.settings).toMatchObject({ temperature: 25, exposure: 0 });
    expect(created.settings.masks[0]).toMatchObject({
      id: 'sky',
      endY: 1,
      adjustments: { exposure: -0.5, contrast: 0 },
    });

    await expect(presets.createPreset(mine, { name: 'Golden hour', settings: {} as never })).rejects.toBeInstanceOf(
      ConflictException,
    );
    await expect(presets.createPreset(theirs, { name: 'Golden hour', settings: {} as never })).resolves.toBeDefined();

    await expect(presets.listPresets(theirs)).resolves.toEqual([expect.objectContaining({ name: 'Golden hour' })]);
    await expect(presets.updatePreset(theirs, created.id, { name: 'Stolen' })).rejects.toThrow('Preset not found');
    await expect(presets.deletePreset(theirs, created.id)).rejects.toThrow('Preset not found');

    const renamed = await presets.updatePreset(mine, created.id, { name: 'Blue hour' });
    expect(renamed.name).toBe('Blue hour');

    await sql`DELETE FROM "user" WHERE id = ${user.id}::uuid`.execute(database);
    await expect(
      database.selectFrom('develop_preset').select('id').where('ownerId', '=', user.id).execute(),
    ).resolves.toEqual([]);
  });
});
