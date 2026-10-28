import type { QueueExecution } from 'src/queue/types.js';
import { AssetFileType, AssetType, JobName, JobStatus } from 'src/enum.js';
import { queueExecution } from 'src/queue/context.js';
import { AssetPaletteService } from 'src/services/asset-palette.service.js';
import { rgbToOklab } from 'src/utils/asset-palette.js';
import { authStub } from 'test/fixtures/auth.stub.js';
import { getMocks } from 'test/utils.js';

const source = {
  id: 'asset',
  sourceRevision: 'rev',
  type: AssetType.Image,
  originalPath: '/synthetic/logo.png',
  originalFileName: 'logo.png',
  files: [],
  edits: [],
  exif: null,
  develop: null,
  isEdited: false,
};
const ready = { swatches: [{ hex: '#ff0000', weight: 1, oklab: rgbToOklab(1, 0, 0) }], hasTransparency: false };
const setup = () => {
  const palettes = {
    source: vi.fn().mockResolvedValue(source),
    get: vi.fn().mockResolvedValue(undefined),
    publish: vi.fn().mockResolvedValue(true),
    page: vi.fn().mockResolvedValue([]),
  };
  const media = { extractAssetPalette: vi.fn().mockResolvedValue(ready) };
  const jobs = {
    queue: vi.fn().mockResolvedValue(undefined),
    queueAll: vi.fn().mockResolvedValue(undefined),
    guardAssetSource: vi.fn().mockResolvedValue(undefined),
  };
  return {
    palettes,
    media,
    jobs,
    service: new AssetPaletteService(palettes as never, media as never, jobs as never, {} as never),
  };
};

describe('palette indexing lifecycle', () => {
  it('refreshes the palette after a committed Develop switch', async () => {
    const { service, jobs } = setup();
    await service.onDevelopCurrentChanged({ assetId: 'asset' });
    expect(jobs.queue).toHaveBeenCalledWith({
      name: JobName.AssetPaletteExtract,
      data: { id: 'asset', sourceRevision: 'rev' },
    });
  });
  it('refreshes changed metadata only once a preview has been published', async () => {
    const { service, jobs, palettes } = setup();
    await service.onMetadataExtracted({ assetId: 'asset', userId: 'owner' });
    expect(jobs.queue).not.toHaveBeenCalled();
    palettes.source.mockResolvedValue({
      ...source,
      files: [{ type: AssetFileType.Preview, path: '/synthetic/preview.jpg', isEdited: false }],
    } as never);
    await service.onMetadataExtracted({ assetId: 'asset', userId: 'owner' });
    expect(jobs.queue).toHaveBeenCalledWith({
      name: JobName.AssetPaletteExtract,
      data: { id: 'asset', sourceRevision: 'rev' },
    });
  });
  it('checks media access before returning palette state or allowing a retry', async () => {
    const { palettes, media, jobs } = setup();
    const mocks = getMocks();
    mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set());
    mocks.access.asset.checkAlbumAccess.mockResolvedValue(new Set());
    mocks.access.asset.checkItemShareAccess.mockResolvedValue(new Set());
    const service = new AssetPaletteService(palettes as never, media as never, jobs as never, mocks.access as never);
    await expect(service.get(authStub.user1, 'asset')).rejects.toThrow();
    await expect(service.retry(authStub.user1, 'asset')).rejects.toThrow();
    expect(palettes.get).not.toHaveBeenCalled();
    expect(jobs.queue).not.toHaveBeenCalled();
    mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set(['asset']));
    palettes.get.mockResolvedValue({ status: 'ready' } as never);
    expect(await service.get(authStub.user1, 'asset')).toEqual({ status: 'ready' });
  });
  it('skips stale work before decoding', async () => {
    const { service, media, palettes } = setup();
    expect(await service.handleExtract({ id: 'asset', sourceRevision: 'old' })).toBe(JobStatus.Skipped);
    expect(media.extractAssetPalette).not.toHaveBeenCalled();
    expect(palettes.publish).not.toHaveBeenCalled();
  });
  it('publishes a current original without flattening its alpha', async () => {
    const { service, media, palettes, jobs } = setup();
    expect(await service.handleExtract({ id: 'asset', sourceRevision: 'rev' })).toBe(JobStatus.Success);
    expect(jobs.guardAssetSource).toHaveBeenCalledWith('asset', { derivatives: true });
    expect(media.extractAssetPalette).toHaveBeenCalledWith(
      '/synthetic/logo.png',
      expect.objectContaining({ colorspace: 'srgb', edits: [] }),
    );
    expect(palettes.publish).toHaveBeenLastCalledWith(
      'asset',
      'rev',
      expect.objectContaining({ status: 'ready', ...ready }),
    );
  });
  it('uses the published current edit and labels video/GIF representative frames', async () => {
    const { service, palettes, media } = setup();
    palettes.source.mockResolvedValue({
      ...source,
      type: AssetType.Video,
      isEdited: true,
      files: [
        { type: 'preview', path: '/synthetic/current.jpg', isEdited: true },
        { type: 'preview', path: '/synthetic/old.jpg', isEdited: false },
      ],
    } as never);
    await service.handleExtract({ id: 'asset', sourceRevision: 'rev' });
    expect(media.extractAssetPalette).toHaveBeenCalledWith('/synthetic/current.jpg', expect.anything());
    expect(palettes.publish).toHaveBeenLastCalledWith(
      'asset',
      'rev',
      expect.objectContaining({ representative: 'frame' }),
    );
  });
  it('indexes a rendered current Develop version rather than its original', async () => {
    const { service, palettes, media } = setup();
    palettes.source.mockResolvedValue({
      ...source,
      develop: {
        id: 'develop',
        status: 'rendered',
        previewPath: '/synthetic/current-develop.png',
        masterPath: '/synthetic/master.png',
      },
    } as never);
    await service.handleExtract({ id: 'asset', sourceRevision: 'rev' });
    expect(media.extractAssetPalette).toHaveBeenCalledWith('/synthetic/master.png', expect.anything());
  });
  it('queues a bounded current revision when a read discovers pending invalidated state', async () => {
    const { palettes, media, jobs } = setup();
    const mocks = getMocks();
    mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set(['asset']));
    palettes.get.mockResolvedValue({ status: 'pending', sourceRevision: 'rev', swatches: [] } as never);
    const service = new AssetPaletteService(palettes as never, media as never, jobs as never, mocks.access as never);
    expect(await service.get(authStub.user1, 'asset')).toEqual(expect.objectContaining({ status: 'pending' }));
    expect(jobs.queue).toHaveBeenCalledWith({
      name: JobName.AssetPaletteExtract,
      data: { id: 'asset', sourceRevision: 'rev' },
    });
    expect(media.extractAssetPalette).not.toHaveBeenCalled();
  });
  it('keeps unedited GIF alpha by decoding a representative original frame', async () => {
    const { service, palettes, media } = setup();
    palettes.source.mockResolvedValue({
      ...source,
      originalPath: '/synthetic/logo.gif',
      originalFileName: 'logo.gif',
      files: [{ type: 'preview', path: '/synthetic/flattened.jpg', isEdited: false, isTransparent: true }],
    } as never);
    await service.handleExtract({ id: 'asset', sourceRevision: 'rev' });
    expect(media.extractAssetPalette).toHaveBeenCalledWith('/synthetic/logo.gif', expect.anything());
  });
  it('publishes only inside the accepted queue transaction', async () => {
    const { service, palettes } = setup();
    const context = {
      signal: new AbortController().signal,
      adoptions: [],
      followups: [],
      progress: vi.fn(),
    } as unknown as QueueExecution;
    await queueExecution.run(context, () => service.handleExtract({ id: 'asset', sourceRevision: 'rev' }));
    expect(palettes.publish).not.toHaveBeenCalled();
    expect(context.adoptions).toHaveLength(1);
    const tx = { isTransaction: true };
    await context.adoptions[0](tx as never);
    expect(palettes.publish).toHaveBeenCalledWith('asset', 'rev', expect.objectContaining({ status: 'ready' }), tx);
  });
  it('settles a failed palette with the failed claim rather than publishing early', async () => {
    const { service, palettes, media } = setup();
    const context = {
      signal: new AbortController().signal,
      adoptions: [],
      followups: [],
      progress: vi.fn(),
    } as unknown as QueueExecution;
    media.extractAssetPalette.mockRejectedValue(new Error('corrupt'));
    await expect(
      queueExecution.run(context, () => service.handleExtract({ id: 'asset', sourceRevision: 'rev' })),
    ).rejects.toThrow('corrupt');
    expect(palettes.publish).not.toHaveBeenCalled();
    expect(context.failureSettlements).toHaveLength(1);
    const tx = { isTransaction: true };
    await context.failureSettlements![0](tx as never, 'failed', false);
    expect(palettes.publish).toHaveBeenCalledWith(
      'asset',
      'rev',
      expect.objectContaining({ status: 'failed', swatches: [] }),
      tx,
    );
  });
  it('records failed extraction without claiming no colors matched', async () => {
    const { service, palettes, media } = setup();
    media.extractAssetPalette.mockRejectedValue(new Error('corrupt'));
    await expect(service.handleExtract({ id: 'asset', sourceRevision: 'rev' })).rejects.toThrow('corrupt');
    expect(palettes.publish).toHaveBeenLastCalledWith(
      'asset',
      'rev',
      expect.objectContaining({ status: 'failed', swatches: [] }),
    );
  });
  it('queues only after accepted thumbnail/edit publication and persists bounded backfill continuation', async () => {
    const { service, jobs, palettes } = setup();
    await service.onJobSuccess({
      job: { name: JobName.AssetGenerateThumbnails, data: { id: 'asset' } },
      response: JobStatus.Success,
    });
    expect(jobs.queue).toHaveBeenCalledWith({
      name: JobName.AssetPaletteExtract,
      data: { id: 'asset', sourceRevision: 'rev' },
    });
    jobs.queue.mockClear();
    await service.onJobSuccess({
      job: { name: JobName.AssetGenerateThumbnails, data: { id: 'asset' } },
      response: JobStatus.Skipped,
    });
    expect(jobs.queue).not.toHaveBeenCalled();
    palettes.page.mockResolvedValue(Array.from({ length: 100 }, (_, i) => ({ id: `asset-${i}` })));
    await service.handleBackfill({ afterId: 'before' });
    expect(palettes.page).toHaveBeenCalledWith('before');
    expect(jobs.queue).toHaveBeenLastCalledWith({
      name: JobName.AssetPaletteQueueAll,
      data: { afterId: 'asset-99', force: undefined },
    });
  });
});
