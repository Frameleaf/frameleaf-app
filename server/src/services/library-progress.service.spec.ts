import { describe, expect, it, vi } from 'vitest';
import { AnalyticsSeriesId, QueueCommand, QueueName, SystemMetadataKey } from 'src/enum.js';
import { LibraryProgressService } from 'src/services/library-progress.service.js';

const counts = (search: number) => ({
  search: [search, 1000] as [number, number],
  faces: [1000, 1000] as [number, number],
  text: [0, 800] as [number, number],
  captions: [100, 1000] as [number, number],
  locked: [800, 800] as [number, number],
});

const setup = (stored: Partial<Record<SystemMetadataKey, unknown>> = {}) => {
  const metadata = {
    get: vi.fn((key: SystemMetadataKey) => Promise.resolve(stored[key] ?? null)),
    set: vi.fn((key: SystemMetadataKey, value: unknown) => {
      stored[key] = value;
      return Promise.resolve();
    }),
  };
  const assetJob = { countFeatureProgress: vi.fn(), countMediaCopies: vi.fn() };
  const analytics = { getLatestHostSamples: vi.fn().mockResolvedValue([]) };
  const queue = { runCommandLegacy: vi.fn().mockResolvedValue({}) };
  const probe = { testVideoCard: vi.fn() };
  const sut = new LibraryProgressService(
    { setContext: vi.fn(), warn: vi.fn() } as never,
    assetJob as never,
    analytics as never,
    metadata as never,
    queue as never,
    probe as never,
  );
  return { sut, metadata, assetJob, analytics, queue, probe, stored };
};

describe(LibraryProgressService.name, () => {
  it('says N of M read, and no rate until two readings are far enough apart', async () => {
    const { sut, assetJob, metadata } = setup();
    assetJob.countFeatureProgress.mockResolvedValue(counts(400));

    const progress = await sut.getProgress(new Date('2026-10-22T10:00:00Z'));

    expect(progress.measuredSince).toBeNull();
    expect(progress.features[0]).toEqual({
      feature: 'search',
      done: 400,
      total: 1000,
      perHour: null,
      secondsLeft: null,
    });
    // A finished feature needs no rate to say nothing is left.
    expect(progress.features[1]).toEqual(expect.objectContaining({ feature: 'faces', secondsLeft: 0 }));
    expect(metadata.set).toHaveBeenCalledWith(SystemMetadataKey.LibraryProgressSamples, {
      samples: [{ at: '2026-10-22T10:00:00.000Z', done: expect.objectContaining({ search: 400 }) }],
    });
  });

  it('measures the rate over the last readings and estimates the time left', async () => {
    const { sut, assetJob } = setup({
      [SystemMetadataKey.LibraryProgressSamples]: {
        samples: [
          { at: '2026-10-22T01:00:00.000Z', done: { search: 0 } },
          { at: '2026-10-22T08:00:00.000Z', done: { search: 200 } },
        ],
      },
    });
    assetJob.countFeatureProgress.mockResolvedValue(counts(400));

    const progress = await sut.getProgress(new Date('2026-10-22T10:00:00Z'));

    // The 01:00 reading is older than six hours: the rate is 200 in the 2 hours since 08:00.
    expect(progress.measuredSince).toBe('2026-10-22T08:00:00.000Z');
    expect(progress.features[0]).toEqual({
      feature: 'search',
      done: 400,
      total: 1000,
      perHour: 100,
      secondsLeft: 21_600,
    });
    // Nothing read lately: the time left is not known.
    expect(progress.features[2]).toEqual(expect.objectContaining({ feature: 'text', perHour: 0, secondsLeft: null }));
  });

  it('keeps a reading at most every ten minutes', async () => {
    const { sut, assetJob, metadata } = setup({
      [SystemMetadataKey.LibraryProgressSamples]: { samples: [{ at: '2026-10-22T09:55:00.000Z', done: {} }] },
    });
    assetJob.countFeatureProgress.mockResolvedValue(counts(400));

    await sut.getProgress(new Date('2026-10-22T10:00:00Z'));

    expect(metadata.set).not.toHaveBeenCalled();
  });

  it('says the space previews and playback copies take, from the newest reading of each folder', async () => {
    const { sut, assetJob, analytics } = setup({
      [SystemMetadataKey.OvernightRedo]: { queues: [QueueName.ThumbnailGeneration, 'unknown'] },
    });
    assetJob.countMediaCopies.mockResolvedValue({
      photos: 900,
      withoutPreview: 2,
      videos: 100,
      withCopy: 12,
      videoMs: 6_000_000,
      copyMs: 900_000,
    });
    analytics.getLatestHostSamples.mockResolvedValue([
      { series: AnalyticsSeriesId.HostThumbnailBytes, value: 41e9, observedAt: new Date('2026-10-22T03:00:00Z') },
      {
        series: AnalyticsSeriesId.HostThumbnailOtherDiskBytes,
        value: 1e9,
        observedAt: new Date('2026-10-01T03:00:00Z'),
      },
      { series: AnalyticsSeriesId.HostEncodedVideoBytes, value: 52e9, observedAt: new Date('2026-10-22T03:05:00Z') },
    ]);

    await expect(sut.getMediaCopies()).resolves.toEqual({
      photos: 900,
      withoutPreview: 2,
      videos: 100,
      withCopy: 12,
      previewsBytes: 41e9,
      playbackBytes: 52e9,
      measuredAt: '2026-10-22T03:00:00.000Z',
      tonight: [QueueName.ThumbnailGeneration],
      videoMinutes: 100,
      copyMinutes: 15,
      videoCard: { failedAt: null, slowdown: null, lastTest: null },
    });
  });

  describe('the graphics card for video (FL-537)', () => {
    it('says when the card stopped helping', async () => {
      const { sut, assetJob } = setup({
        [SystemMetadataKey.VideoCardState]: {
          failedAt: '2026-10-08T02:00:00.000Z',
          accel: 'qsv',
          slowdown: 6,
          lastTest: null,
        },
      });
      assetJob.countMediaCopies.mockResolvedValue({
        photos: 0,
        withoutPreview: 0,
        videos: 0,
        withCopy: 0,
        videoMs: 0,
        copyMs: 0,
      });
      await expect(sut.getMediaCopies()).resolves.toEqual(
        expect.objectContaining({
          videoCard: { failedAt: '2026-10-08T02:00:00.000Z', slowdown: 6, lastTest: null },
        }),
      );
    });

    it('tests the card against the processor, and keeps the slowdown when a later test fails', async () => {
      const { sut, probe, stored } = setup();
      probe.testVideoCard.mockResolvedValueOnce({ encoder: 'h264_vaapi', speed: 12, softwareSpeed: 2, error: null });
      await expect(sut.testVideoCard(new Date('2026-10-23T10:00:00Z'))).resolves.toEqual({
        failedAt: null,
        slowdown: 6,
        lastTest: {
          at: '2026-10-23T10:00:00.000Z',
          ok: true,
          encoder: 'h264_vaapi',
          speed: 12,
          softwareSpeed: 2,
          error: null,
        },
      });

      probe.testVideoCard.mockResolvedValueOnce({
        encoder: 'h264_vaapi',
        speed: null,
        softwareSpeed: 2,
        error: 'Failed to initialise VAAPI connection',
      });
      const failed = await sut.testVideoCard(new Date('2026-10-23T11:00:00Z'));
      expect(failed.slowdown).toBe(6);
      expect(failed.lastTest).toEqual(
        expect.objectContaining({ ok: false, error: 'Failed to initialise VAAPI connection' }),
      );
      expect(stored[SystemMetadataKey.VideoCardState]).toEqual(expect.objectContaining({ slowdown: 6 }));
    });

    it('says plainly when there is no graphics card to test', async () => {
      const { sut, probe } = setup();
      probe.testVideoCard.mockResolvedValue({ encoder: null, speed: null, softwareSpeed: null, error: null });
      const result = await sut.testVideoCard();
      expect(result.lastTest).toEqual(expect.objectContaining({ ok: false, encoder: null }));
      expect(result.slowdown).toBeNull();
    });
  });

  it('starts a feature again now, or keeps it for tonight once', async () => {
    const { sut, queue, stored } = setup();

    await expect(sut.redo({ queue: QueueName.SmartSearch, when: 'tonight' })).resolves.toEqual({
      tonight: [QueueName.SmartSearch],
    });
    await sut.redo({ queue: QueueName.SmartSearch, when: 'tonight' });
    expect(stored[SystemMetadataKey.OvernightRedo]).toEqual({ queues: [QueueName.SmartSearch] });
    expect(queue.runCommandLegacy).not.toHaveBeenCalled();

    await expect(sut.redo({ queue: QueueName.SmartSearch, when: 'now' })).resolves.toEqual({ tonight: [] });
    expect(queue.runCommandLegacy).toHaveBeenCalledWith(QueueName.SmartSearch, {
      command: QueueCommand.Start,
      force: true,
    });
  });
});
