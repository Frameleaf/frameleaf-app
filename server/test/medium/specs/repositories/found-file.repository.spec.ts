import { Kysely } from 'kysely';
import { createHash, randomUUID } from 'node:crypto';
import { AssetFileType, ChecksumAlgorithm } from 'src/enum.js';
import { FoundFileRepository } from 'src/repositories/found-file.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { PhysicalFileRepository } from 'src/repositories/physical-file.repository.js';
import { DB } from 'src/schema/index.js';
import { SyncService } from 'src/services/sync.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

/** FL-1532: what is remembered about a found file comes back from a real database as it was written. */

let defaultDatabase: Kysely<DB>;

beforeAll(async () => {
  defaultDatabase = await getKyselyDB();
});

const file = (path: string) => ({
  path,
  sizeInBytes: 10,
  modifiedAt: new Date('2026-11-01T10:00:00.000Z'),
  sha1: Buffer.alloc(20, 1),
  sha256: Buffer.alloc(32, 2),
  outcome: 'spare' as const,
  reason: null,
  ownerId: randomUUID(),
  assetId: randomUUID(),
  previousPath: null,
  steps: [
    { step: 'found', at: '2026-11-12T03:40:00.000Z' },
    { step: 'read', at: '2026-11-12T03:40:01.000Z', outcome: 'ok' },
  ],
});

describe(FoundFileRepository.name, () => {
  it('reads back what was written, with the steps as a list and the digests as bytes', async () => {
    const sut = new FoundFileRepository(defaultDatabase);
    const path = `/data/upload/${randomUUID()}/IMG_0001.jpg`;
    const written = file(path);

    await sut.upsert(written);

    const [read] = await sut.getByPaths([path, `/data/upload/${randomUUID()}/other.jpg`]);
    expect(read).toMatchObject({
      path,
      outcome: 'spare',
      reason: null,
      ownerId: written.ownerId,
      assetId: written.assetId,
      previousPath: null,
      steps: written.steps,
    });
    expect(Array.isArray(read.steps)).toBe(true);
    expect(Number(read.sizeInBytes)).toBe(10);
    expect(new Date(read.modifiedAt).getTime()).toBe(written.modifiedAt.getTime());
    expect(Buffer.from(read.sha1!).equals(written.sha1)).toBe(true);
    expect(Buffer.from(read.sha256!).equals(written.sha256)).toBe(true);
  });

  it('replaces what was known about a path, keeping one row for it', async () => {
    const sut = new FoundFileRepository(defaultDatabase);
    const path = `/data/upload/${randomUUID()}/IMG_0002.jpg`;
    await sut.upsert(file(path));

    await sut.upsert({
      ...file(path),
      outcome: 'back',
      previousPath: '/data/library/taylor/2020/08/IMG_0002.jpg',
      steps: [
        { step: 'found', at: '2026-11-12T03:40:00.000Z' },
        { step: 'back', at: '2026-11-13T03:40:00.000Z' },
      ],
    });

    const rows = await sut.getByPaths([path]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ outcome: 'back', previousPath: '/data/library/taylor/2020/08/IMG_0002.jpg' });
    expect(rows[0].steps.map(({ step }) => step)).toEqual(['found', 'back']);
  });

  it('asks the database nothing for no paths', async () => {
    await expect(new FoundFileRepository(defaultDatabase).getByPaths([])).resolves.toEqual([]);
  });

  describe('FL-1537 review', () => {
    it('lists by outcome in pages, counts by outcome and groups what waits by its decision', async () => {
      const database = await getKyselyDB('found_file_review');
      try {
        const sut = new FoundFileRepository(database);
        const owner = randomUUID();
        const lost = `/data/upload/${randomUUID()}`;
        const waiting = { outcome: 'needs' as const, assetId: null };
        await sut.upsert({ ...file(`${lost}/aa/1.jpg`), ...waiting, reason: 'no-owner', ownerId: null });
        await sut.upsert({ ...file(`${lost}/bb/2.jpg`), ...waiting, reason: 'no-owner', ownerId: null });
        await sut.upsert({ ...file('/data/library/gone/2020/3.jpg'), ...waiting, reason: 'no-owner', ownerId: null });
        await sut.upsert({
          ...file(`/data/upload/${owner}/aa/4.mov`),
          ...waiting,
          reason: 'over-limit',
          ownerId: owner,
        });
        await sut.upsert({ ...file(`/data/upload/${owner}/aa/5.jpg`), ownerId: owner });

        const counts = await sut.counts();
        expect(counts).toEqual(
          expect.arrayContaining([
            { outcome: 'needs', reason: 'no-owner', count: 3, sizeInBytes: 30 },
            { outcome: 'needs', reason: 'over-limit', count: 1, sizeInBytes: 10 },
            { outcome: 'spare', reason: null, count: 1, sizeInBytes: 10 },
          ]),
        );
        expect(await sut.needsGroups()).toEqual([
          { reason: 'no-owner', ownerId: null, folder: lost, count: 2, sizeInBytes: 20 },
          expect.objectContaining({ count: 1 }),
          expect.objectContaining({ count: 1 }),
        ]);
        expect(await sut.needsGroups()).toEqual(
          expect.arrayContaining([
            { reason: 'no-owner', ownerId: null, folder: '/data/library/gone', count: 1, sizeInBytes: 10 },
            { reason: 'over-limit', ownerId: owner, folder: null, count: 1, sizeInBytes: 10 },
          ]),
        );

        const inFolder = await sut.list({ outcome: 'needs', reason: 'no-owner', folder: lost, size: 1 });
        expect(inFolder.map(({ path }) => path)).toEqual([`${lost}/aa/1.jpg`]);
        const next = await sut.list({
          outcome: 'needs',
          reason: 'no-owner',
          folder: lost,
          size: 1,
          cursor: inFolder[0].id,
        });
        expect(next.map(({ path }) => path)).toEqual([`${lost}/bb/2.jpg`]);
        expect(await sut.list({ outcome: 'needs', ownerId: owner, size: 10 })).toHaveLength(1);

        // a file with no account of its own and no photo belongs to nobody
        expect((await sut.get(inFolder[0].id))?.effectiveOwnerId).toBeNull();
        await sut.delete(inFolder[0].id);
        expect(await sut.get(inFolder[0].id)).toBeUndefined();
      } finally {
        await database.destroy();
      }
    });
  });
});

it('FL-1537: undoing a put-back points the photo at its old path again, once', async () => {
  const db = await getKyselyDB('found_file_undo');
  const { ctx } = newMediumService(SyncService, { database: db, real: [], mock: [LoggingRepository] });
  try {
    const { user } = await ctx.newUser();
    const bytes = Buffer.from('a photo found on the drive');
    const sha1 = createHash('sha1').update(bytes).digest();
    const sha256 = createHash('sha256').update(bytes).digest();
    const lostPath = `/data/library/${user.id}/2020/08/IMG_3310.jpg`;
    const foundPath = `/data/upload/${user.id}/3f/9a/7c2e-41d0.jpg`;
    const { asset } = await ctx.newAsset({
      ownerId: user.id,
      originalPath: lostPath,
      checksum: sha1,
      checksumAlgorithm: ChecksumAlgorithm.sha1File,
    });
    const sut = new PhysicalFileRepository(db);
    await expect(
      sut.restoreLostOriginal({
        assetId: asset.id,
        expectedOriginalPath: lostPath,
        originalPath: foundPath,
        sha1,
        sha256,
        sizeInBytes: bytes.length,
        reason: 'restored_from_untracked_file',
      }),
    ).resolves.toBe(true);
    const read = () =>
      db
        .selectFrom('asset')
        .leftJoin('physical_file', 'physical_file.id', 'asset.physicalOriginalFileId')
        .select(['asset.originalPath', 'physical_file.path'])
        .where('asset.id', '=', asset.id)
        .executeTakeFirstOrThrow();
    await expect(read()).resolves.toEqual({ originalPath: foundPath, path: foundPath });

    const undo = () => sut.revertRestoredOriginal({ assetId: asset.id, foundPath, previousPath: lostPath });
    await expect(undo()).resolves.toBe(true);
    await expect(read()).resolves.toEqual({ originalPath: lostPath, path: lostPath });
    // the photo no longer points at the found file: there is nothing left to undo
    await expect(undo()).resolves.toBe(false);
  } finally {
    await db.destroy();
  }
});

it('FL-1579: finds the photos named like an XMP file without its ending, and whether they have one', async () => {
  const db = await getKyselyDB('found_file_named');
  const { ctx } = newMediumService(SyncService, { database: db, real: [], mock: [LoggingRepository] });
  try {
    const { user } = await ctx.newUser();
    const folder = `/data/upload/${user.id}/3f/9a`;
    const add = (name: string, patch: Record<string, unknown> = {}) =>
      ctx.newAsset({ ownerId: user.id, originalPath: `${folder}/${name}`, ...patch }).then(({ asset }) => asset);
    const one = await add('IMG_0001.jpg');
    const upper = await add('IMG_0002.HEIC');
    const live = await add('IMG_0003.heic');
    const motion = await add('IMG_0003.mov');
    const own = await add('IMG_0004.jpg');
    await ctx.newAssetFile({ assetId: own.id, type: AssetFileType.Sidecar, path: `${folder}/IMG_0004.jpg.xmp` });
    await add('IMG_0005.jpg', { deletedAt: new Date() });
    // names that only start the same, or sit in another folder, are other photos
    await add('IMG_00010.jpg');
    await add('IMG_0001.jpg.png');
    await ctx.newAsset({ ownerId: user.id, originalPath: `/data/upload/${user.id}/00/11/IMG_0001.jpg` });

    const sut = new FoundFileRepository(db);
    const stems = ['IMG_0001', 'IMG_0002', 'IMG_0003', 'IMG_0004', 'IMG_0005', 'IMG_0006'].map(
      (name) => `${folder}/${name}`,
    );
    const found = await sut.assetsNamed(stems, ['.jpg', '.JPG', '.heic', '.HEIC', '.mov', '.MOV']);
    expect(found.toSorted((a, b) => a.originalPath.localeCompare(b.originalPath))).toEqual([
      { id: one.id, originalPath: `${folder}/IMG_0001.jpg`, stem: `${folder}/IMG_0001`, hasSidecar: false },
      { id: upper.id, originalPath: `${folder}/IMG_0002.HEIC`, stem: `${folder}/IMG_0002`, hasSidecar: false },
      { id: live.id, originalPath: `${folder}/IMG_0003.heic`, stem: `${folder}/IMG_0003`, hasSidecar: false },
      { id: motion.id, originalPath: `${folder}/IMG_0003.mov`, stem: `${folder}/IMG_0003`, hasSidecar: false },
      { id: own.id, originalPath: `${folder}/IMG_0004.jpg`, stem: `${folder}/IMG_0004`, hasSidecar: true },
    ]);
    await expect(sut.assetsNamed([], ['.jpg'])).resolves.toEqual([]);
    await expect(sut.assetsNamed(stems, [])).resolves.toEqual([]);
  } finally {
    await db.destroy();
  }
});
