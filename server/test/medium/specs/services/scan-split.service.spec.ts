import { Kysely, sql } from 'kysely';
import { randomBytes } from 'node:crypto';
import type { ScanCropJobItem } from 'src/types.js';
import { StorageCore } from 'src/cores/storage.core.js';
import { AssetEditAction } from 'src/dtos/editing.dto.js';
import { AssetLockReason, AssetStatus, AssetVisibility, JobName, JobStatus } from 'src/enum.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { DerivativePrivacyRepository } from 'src/repositories/derivative-privacy.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { ScanSplitRepository } from 'src/repositories/scan-split.repository.js';
import { TrashRepository } from 'src/repositories/trash.repository.js';
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import { ScanSplitService } from 'src/services/scan-split.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { newUuid } from 'test/small.factory.js';
import { getKyselyDB } from 'test/utils.js';

/**
 * FL-923: the ScanSplit job against a real database. The pictures themselves are stand-ins (the renderer has its
 * own spec, src/queue/sharp-scan-crop.spec.ts); what is real here is what the library ends up holding.
 */
let db: Kysely<DB>;
beforeAll(async () => {
  db = await getKyselyDB();
  StorageCore.setMediaLocation('/frameleaf-medium-media');
});
afterAll(async () => {
  await db?.destroy();
});

const CROP_BYTES = 500;
const quad = (left: number, top: number): ScanCropJobItem['quad'] => [
  [left, top],
  [left + 400, top],
  [left + 400, top + 300],
  [left, top + 300],
];
const two: ScanCropJobItem[] = [
  { quad: quad(100, 100), rotation: 0 },
  { quad: quad(700, 100), rotation: 90 },
];

const setup = async (options: { quota?: number | null; locked?: boolean } = {}) => {
  const { ctx } = newMediumService(BaseService, { database: db, real: [], mock: [LoggingRepository] });
  const { user } = await ctx.newUser({ quotaSizeInBytes: options.quota ?? null, quotaUsageInBytes: 1000 });
  const { asset: scan } = await ctx.newAsset({
    ownerId: user.id,
    originalFileName: 'sheet.tif',
    originalPath: `/synthetic/${newUuid()}.tif`,
    visibility: options.locked ? AssetVisibility.Locked : AssetVisibility.Timeline,
  });
  await ctx.newExif({
    assetId: scan.id,
    fileSizeInByte: 1000,
    exifImageWidth: 2000,
    exifImageHeight: 1500,
    timeZone: 'Europe/Oslo',
  });
  const assets = new AssetRepository(db);
  const media = {
    getOrientedSize: vi.fn().mockResolvedValue({ width: 2000, height: 1500 }),
    renderScanCrop: vi.fn().mockResolvedValue({ width: 400, height: 300 }),
    writeExif: vi.fn().mockResolvedValue(true),
  };
  // every rendered file is new bytes, unless a test says which bytes come out
  const digests = vi.fn(() =>
    Promise.resolve({ sha1: randomBytes(20), sha256: randomBytes(32), sizeInBytes: CROP_BYTES }),
  );
  const crypto = { randomUUID: () => newUuid(), hashFileDigests: digests };
  const storage = { mkdirSync: vi.fn(), unlinkIfExists: vi.fn().mockResolvedValue(undefined) };
  const jobs = { queue: vi.fn().mockResolvedValue(undefined), queueAll: vi.fn().mockResolvedValue(undefined) };
  const events = { emit: vi.fn().mockResolvedValue(undefined) };
  const sut = new ScanSplitService(
    new ScanSplitRepository(db, assets, new DerivativePrivacyRepository(db)),
    {} as never,
    assets,
    { recordAssetChecksums: vi.fn().mockResolvedValue(undefined) } as never,
    crypto as never,
    events as never,
    jobs as never,
    LoggingRepository.create(),
    {} as never,
    media as never,
    { ensureOriginalPhysicalFile: vi.fn().mockResolvedValue(undefined) } as never,
    storage as never,
    new TrashRepository(db),
  );
  const split = (crops = two) => sut.handleSplit({ id: scan.id, crops });
  const crops = () =>
    db
      .selectFrom('asset_scan_crop')
      .innerJoin('asset', 'asset.id', 'asset_scan_crop.assetId')
      .select(['asset.id', 'asset.ownerId', 'asset.status', 'asset.visibility', 'asset.originalFileName'])
      .select(['asset.fileCreatedAt', 'asset_scan_crop.quad', 'asset_scan_crop.rotation'])
      .where('asset_scan_crop.sourceAssetId', '=', scan.id)
      .orderBy('asset.originalFileName')
      .execute();
  const usage = async () =>
    Number(
      (await db.selectFrom('user').select('quotaUsageInBytes').where('id', '=', user.id).executeTakeFirstOrThrow())
        .quotaUsageInBytes,
    );
  const row = (id: string) => db.selectFrom('asset').selectAll().where('id', '=', id).executeTakeFirst();
  const locks = async (ids: string[]) =>
    (await db.selectFrom('asset_lock').select(['assetId', 'reason']).where('assetId', 'in', ids).execute()).length;
  return { ctx, user, scan, sut, split, crops, usage, row, locks, media, digests, storage, jobs, events };
};

describe('ScanSplit job (FL-923)', () => {
  it('adds one photo per print to the scan owner and keeps the scan, archived', async () => {
    const { user, scan, split, crops, row, jobs, events } = await setup();

    await expect(split()).resolves.toBe(JobStatus.Success);

    const photos = await crops();
    expect(photos).toHaveLength(2);
    expect(photos.map((photo) => photo.originalFileName)).toEqual(['sheet-1.jpg', 'sheet-2.jpg']);
    for (const photo of photos) {
      expect(photo).toMatchObject({
        ownerId: user.id,
        status: AssetStatus.Active,
        visibility: AssetVisibility.Timeline,
        // the scan's date: the print's own is unknown
        fileCreatedAt: scan.fileCreatedAt,
      });
      expect(jobs.queue).toHaveBeenCalledWith({
        name: JobName.AssetExtractMetadata,
        data: { id: photo.id, source: 'upload' },
      });
      expect(events.emit).toHaveBeenCalledWith('AssetCreate', { asset: { id: photo.id, ownerId: user.id } });
    }
    expect(photos[0]).toMatchObject({ quad: quad(100, 100), rotation: 0 });
    expect(photos[1]).toMatchObject({ quad: quad(700, 100), rotation: 90 });
    await expect(
      db.selectFrom('asset_exif').select(['timeZone', 'fileSizeInByte']).where('assetId', '=', photos[0].id).execute(),
    ).resolves.toEqual([{ timeZone: 'Europe/Oslo', fileSizeInByte: CROP_BYTES }]);

    // the scan stays available: archived, not deleted
    await expect(row(scan.id)).resolves.toMatchObject({
      visibility: AssetVisibility.Archive,
      status: AssetStatus.Active,
      deletedAt: null,
    });
  });

  it('counts the scan and each photo against the quota once each', async () => {
    const { split, usage } = await setup({ quota: 10_000 });
    // the scan was counted when it was uploaded
    await expect(usage()).resolves.toBe(1000);

    await split();

    await expect(usage()).resolves.toBe(1000 + 2 * CROP_BYTES);
  });

  it('adds nothing when the photos do not all fit in the quota', async () => {
    // room for one photo, not two
    const { scan, split, crops, usage, row, storage, jobs } = await setup({ quota: 1000 + CROP_BYTES });

    await expect(split()).resolves.toBe(JobStatus.Failed);

    await expect(crops()).resolves.toEqual([]);
    await expect(usage()).resolves.toBe(1000);
    await expect(row(scan.id)).resolves.toMatchObject({ visibility: AssetVisibility.Timeline });
    // both rendered files are removed again
    expect(storage.unlinkIfExists).toHaveBeenCalledTimes(2);
    expect(jobs.queue).not.toHaveBeenCalled();
  });

  it('starts the photos of a Locked scan Locked', async () => {
    const { scan, split, crops, locks } = await setup({ locked: true });
    await expect(locks([scan.id])).resolves.toBe(1);

    await split();

    const photos = await crops();
    expect(photos).toHaveLength(2);
    await expect(locks(photos.map(({ id }) => id))).resolves.toBe(2);
    await expect(
      db.selectFrom('asset_lock').select(['reason', 'inherited']).where('assetId', '=', photos[0].id).execute(),
    ).resolves.toEqual([{ reason: AssetLockReason.Marked, inherited: false }]);
  });

  it('leaves the photos of a scan that is not Locked unlocked', async () => {
    const { split, crops, locks } = await setup();
    await split();
    await expect(locks((await crops()).map(({ id }) => id))).resolves.toBe(0);
  });

  it('replaces the unedited photos of an earlier split and keeps the edited ones', async () => {
    const { ctx, user, split, crops, row, usage, events } = await setup({ quota: 100_000 });
    // three prints, so each kind of "worked on" has its own photo
    await split([...two, { quad: quad(1300, 100), rotation: 0 }]);
    const [untouched, edited, described] = await crops();

    // the owner crops one photo and describes another; the first is left as it came
    await ctx.newEdits(edited.id, {
      edits: [{ action: AssetEditAction.Crop, parameters: { x: 0, y: 0, width: 100, height: 100 } }],
    });
    await new AssetRepository(db).upsertExif({
      exif: { assetId: described.id, description: 'Grandma, 1962', lockedProperties: ['description'] },
      lockedPropertiesBehavior: 'append',
    });
    events.emit.mockClear();

    await expect(split()).resolves.toBe(JobStatus.Success);

    // the untouched photo is in the trash and no longer one of the scan's prints
    await expect(row(untouched.id)).resolves.toMatchObject({ status: AssetStatus.Trashed });
    expect(events.emit).toHaveBeenCalledWith('AssetTrashAll', { assetIds: [untouched.id], userId: user.id });
    const now = await crops();
    expect(now.map(({ id }) => id)).not.toContain(untouched.id);
    // the edited and the described photos are kept, beside the two new ones
    expect(now.map(({ id }) => id)).toEqual(expect.arrayContaining([edited.id, described.id]));
    await expect(row(edited.id)).resolves.toMatchObject({ status: AssetStatus.Active, deletedAt: null });
    await expect(row(described.id)).resolves.toMatchObject({ status: AssetStatus.Active, deletedAt: null });
    expect(now).toHaveLength(4);
    // five photos were ever made, each counted once, on top of the scan
    await expect(usage()).resolves.toBe(1000 + 5 * CROP_BYTES);
  });

  it('keeps an earlier photo whose pixels come out the same instead of adding it again', async () => {
    const { split, crops, row, digests, storage } = await setup();
    const bytes = { sha1: randomBytes(20), sha256: randomBytes(32), sizeInBytes: CROP_BYTES };
    digests.mockResolvedValue(bytes);
    const one = [{ quad: quad(100, 100), rotation: 0 }];
    await split(one);
    const [first] = await crops();

    await expect(split(one)).resolves.toBe(JobStatus.Success);

    await expect(crops()).resolves.toHaveLength(1);
    await expect(row(first.id)).resolves.toMatchObject({ status: AssetStatus.Active });
    // the second render was thrown away
    expect(storage.unlinkIfExists).toHaveBeenCalledTimes(1);
  });

  it('removes only the row when the scan or a photo is deleted', async () => {
    const { scan, split, crops, row } = await setup();
    await split();
    const [first, second] = await crops();

    await db.deleteFrom('asset').where('id', '=', first.id).execute();
    await expect(crops()).resolves.toHaveLength(1);

    await db.deleteFrom('asset').where('id', '=', scan.id).execute();
    await expect(
      sql<{ count: string }>`select count(*) from asset_scan_crop where "sourceAssetId" = ${scan.id}::uuid`
        .execute(db)
        .then(({ rows }) => Number(rows[0].count)),
    ).resolves.toBe(0);
    // deleting the scan does not delete the photo cut from it
    await expect(row(second.id)).resolves.toMatchObject({ status: AssetStatus.Active });
  });

  it('skips a scan that is in the trash', async () => {
    const { scan, split, crops } = await setup();
    await db
      .updateTable('asset')
      .set({ status: AssetStatus.Trashed, deletedAt: new Date() })
      .where('id', '=', scan.id)
      .execute();
    await expect(split()).resolves.toBe(JobStatus.Skipped);
    await expect(crops()).resolves.toEqual([]);
  });
});
