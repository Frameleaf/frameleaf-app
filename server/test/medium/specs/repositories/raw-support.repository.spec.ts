import { Kysely } from 'kysely';
import {
  AssetFileType,
  AssetType,
  AssetVisibility,
  MediaHealthCategory,
  MediaHealthSeverity,
  MediaHealthStatus,
} from 'src/enum.js';
import { AssetJobRepository } from 'src/repositories/asset-job.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { RawSupportRepository } from 'src/repositories/raw-support.repository.js';
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

/** FL-420: the RAW support summary reads the owner's RAW originals, their previews and decode findings. */
let db: Kysely<DB>;
beforeAll(async () => {
  db = await getKyselyDB();
});
afterAll(async () => {
  await db?.destroy();
});

const setup = () => {
  const { ctx } = newMediumService(BaseService, { database: db, real: [], mock: [LoggingRepository] });
  return { ctx, sut: new RawSupportRepository(db) };
};

const finding = (assetId: string, status: MediaHealthStatus, reason: string, extra: { resolvedAt?: Date } = {}) =>
  db
    .insertInto('asset_health')
    .values({
      assetId,
      category: MediaHealthCategory.Corrupt,
      status,
      severity: MediaHealthSeverity.Warning,
      originalPath: '/library/raw',
      originalFileName: 'raw',
      evidence: { reason },
      resolution: {},
      checkedAt: new Date(),
      ...extra,
    })
    .execute();

describe(RawSupportRepository.name, () => {
  it("lists the owner's RAW originals with their facts, attention first", async () => {
    const { ctx, sut } = setup();
    const { user } = await ctx.newUser();
    const { user: other } = await ctx.newUser();
    const older = new Date('2026-01-01T00:00:00Z');
    const newer = new Date('2026-06-01T00:00:00Z');
    const { asset: ready } = await ctx.newAsset({
      ownerId: user.id,
      originalFileName: 'IMG_0001.CR3',
      fileCreatedAt: newer,
    });
    await ctx.newAssetFile({ assetId: ready.id, type: AssetFileType.Preview, path: '/thumbs/ready-preview.jpg' });
    await ctx.newAssetFile({ assetId: ready.id, type: AssetFileType.FullSize, path: '/thumbs/ready-full.jpg' });
    await ctx.newExif({
      assetId: ready.id,
      make: 'Canon',
      model: 'EOS R5',
      exifImageWidth: 8192,
      exifImageHeight: 5464,
    });
    const { asset: pending } = await ctx.newAsset({
      ownerId: user.id,
      originalFileName: 'DSC_2108.nef',
      fileCreatedAt: older,
    });
    const { asset: unsupported } = await ctx.newAsset({
      ownerId: user.id,
      originalFileName: 'DSCF8142.RAF',
      fileCreatedAt: older,
    });
    await ctx.newAssetFile({ assetId: unsupported.id, type: AssetFileType.Preview, path: '/thumbs/raf-preview.jpg' });
    await finding(unsupported.id, MediaHealthStatus.UnsupportedRaw, 'raw_decode_unsupported');
    // Not listed: a JPEG, a PSD, someone else's RAW, a trashed RAW and a video.
    await ctx.newAsset({ ownerId: user.id, originalFileName: 'IMG_0001.JPG' });
    await ctx.newAsset({ ownerId: user.id, originalFileName: 'layers.psd' });
    await ctx.newAsset({ ownerId: other.id, originalFileName: 'OTHER.CR2' });
    await ctx.newAsset({ ownerId: user.id, originalFileName: 'GONE.CR2', deletedAt: new Date() });
    await ctx.newAsset({ ownerId: user.id, originalFileName: 'CLIP.CR3', type: AssetType.Video });

    const { items, groups } = await sut.getSummary({ ownerId: user.id, limit: 10 });

    expect(items.map((item) => item.fileName)).toEqual(['DSCF8142.RAF', 'DSC_2108.nef', 'IMG_0001.CR3']);
    expect(items[0]).toMatchObject({
      assetId: unsupported.id,
      healthStatus: MediaHealthStatus.UnsupportedRaw,
      healthReason: 'raw_decode_unsupported',
      hasPreview: true,
      hasFullsize: false,
    });
    expect(items[1]).toMatchObject({ assetId: pending.id, healthStatus: null, hasPreview: false, renderedAt: null });
    expect(items[2]).toMatchObject({
      assetId: ready.id,
      make: 'Canon',
      model: 'EOS R5',
      width: 8192,
      height: 5464,
      hasPreview: true,
      hasFullsize: true,
      pairedFileName: null,
    });
    expect(items[2].renderedAt).toBeInstanceOf(Date);
    expect(groups.toSorted((a, b) => a.extension.localeCompare(b.extension))).toEqual([
      {
        extension: 'cr3',
        healthStatus: null,
        healthReason: null,
        hasPreview: true,
        hasFullsize: true,
        rung: null,
        count: 1,
      },
      {
        extension: 'nef',
        healthStatus: null,
        healthReason: null,
        hasPreview: false,
        hasFullsize: false,
        rung: null,
        count: 1,
      },
      {
        extension: 'raf',
        healthStatus: MediaHealthStatus.UnsupportedRaw,
        healthReason: 'raw_decode_unsupported',
        hasPreview: true,
        hasFullsize: false,
        rung: null,
        count: 1,
      },
    ]);
  });

  it('reports the recorded ladder rung and lists those files ahead of the rest (FL-1355)', async () => {
    const { ctx, sut } = setup();
    const { user } = await ctx.newUser();
    const { asset: rendered } = await ctx.newAsset({
      ownerId: user.id,
      originalFileName: 'A.NEF',
      fileCreatedAt: new Date('2026-06-01T00:00:00Z'),
    });
    const { asset: fallen } = await ctx.newAsset({
      ownerId: user.id,
      originalFileName: 'B.NEF',
      fileCreatedAt: new Date('2026-01-01T00:00:00Z'),
    });
    for (const asset of [rendered, fallen]) {
      await ctx.newAssetFile({ assetId: asset.id, type: AssetFileType.Preview, path: `/thumbs/${asset.id}.jpg` });
    }
    const jobs = new AssetJobRepository(db);
    await jobs.setRawRung(fallen.id, 'embedded/timeout');
    await jobs.setRawRung(fallen.id, 'embedded/unsupported');
    await jobs.setRawRung(rendered.id, 'placeholder/timeout');
    await jobs.setRawRung(rendered.id, null);

    const { groups, items } = await sut.getSummary({ ownerId: user.id, limit: 10 });

    // the older file comes first because its sensor did not render
    expect(items.map(({ assetId, rung }) => ({ assetId, rung }))).toEqual([
      { assetId: fallen.id, rung: 'embedded/unsupported' },
      { assetId: rendered.id, rung: null },
    ]);
    expect(
      groups.map(({ rung, count }) => ({ rung, count })).toSorted((a, b) => (a.rung ?? '').localeCompare(b.rung ?? '')),
    ).toEqual([
      { rung: null, count: 1 },
      { rung: 'embedded/unsupported', count: 1 },
    ]);
    await expect(jobs.getRawRungAssetIds()).resolves.toContain(fallen.id);
    await expect(jobs.getRawRungAssetIds()).resolves.not.toContain(rendered.id);
  });

  it('ignores resolved findings, names the stacked JPEG and honours the limit', async () => {
    const { ctx, sut } = setup();
    const { user } = await ctx.newUser();
    const { asset: raw } = await ctx.newAsset({ ownerId: user.id, originalFileName: 'IMG_4821.CR3' });
    const { asset: jpeg } = await ctx.newAsset({ ownerId: user.id, originalFileName: 'IMG_4821.JPG' });
    await ctx.newStack({ ownerId: user.id }, [jpeg.id, raw.id]);
    await ctx.newAssetFile({ assetId: raw.id, type: AssetFileType.Preview, path: '/thumbs/4821.jpg' });
    await finding(raw.id, MediaHealthStatus.CorruptSuspect, 'raw_decode_damaged', { resolvedAt: new Date() });
    await ctx.newAsset({ ownerId: user.id, originalFileName: 'IMG_4822.CR3' });
    await ctx.newAsset({ ownerId: user.id, originalFileName: 'IMG_4823.CR3', visibility: AssetVisibility.Archive });

    const all = await sut.getSummary({ ownerId: user.id, limit: 10 });
    expect(all.items).toHaveLength(3);
    expect(all.items.find((item) => item.assetId === raw.id)).toMatchObject({
      healthStatus: null,
      pairedFileName: 'IMG_4821.JPG',
    });
    expect(all.groups.reduce((sum, group) => sum + group.count, 0)).toBe(3);

    const limited = await sut.getSummary({ ownerId: user.id, limit: 1 });
    expect(limited.items).toHaveLength(1);
    expect(limited.groups.reduce((sum, group) => sum + group.count, 0)).toBe(3);
  });
});
