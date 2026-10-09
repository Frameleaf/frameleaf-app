import {
  AssetRestorationMode,
  AssetTypeEnum,
  MlDestinationKind,
  type AssetResponseDto,
  type AssetRestorationOptionsDto,
  type AssetRestorationResponseDto,
} from '@frameleaf/sdk';
import { describe, expect, it, vi } from 'vitest';
import { createStudioCommandEnvelope } from './commands';
import {
  StudioRestorationCommandError,
  clipMediaId,
  createStudioRestorationHandlers,
  smoothMotionFactorFor,
  type StudioRestorationApi,
} from './restoration-jobs';

const VIDEO_ID = '0199aaaa-bbbb-7ccc-8ddd-eeeeffff0001';
const RESTORED = 'restored-0199aaaa-bbbb-7ccc-8ddd-eeeeffff0009';

const graph = {
  tracks: [
    {
      items: [
        { id: 'clip-video', mediaId: VIDEO_ID },
        { id: 'clip-restored', mediaId: RESTORED },
      ],
    },
  ],
};

const destinations = [
  { id: 'lan', kind: MlDestinationKind.Lan, available: true },
  { id: 'busy', kind: MlDestinationKind.Lan, available: false },
  { id: 'cloud', kind: MlDestinationKind.FrameleafCloud, available: true },
];

const setup = () => {
  const api: { [K in keyof StudioRestorationApi]: ReturnType<typeof vi.fn> } = {
    getAsset: vi.fn().mockResolvedValue({
      id: VIDEO_ID,
      type: AssetTypeEnum.Video,
      exifInfo: { fps: 30 },
    } as AssetResponseDto),
    getRestorations: vi.fn().mockResolvedValue({
      items: [{ id: 'restoration-1', destinationId: 'lan' }],
    }),
    getOptions: vi.fn().mockResolvedValue({ destinations } as unknown as AssetRestorationOptionsDto),
    request: vi.fn().mockResolvedValue({ id: 'restoration-1' } as AssetRestorationResponseDto),
    accept: vi.fn().mockResolvedValue({ id: 'restoration-1' } as AssetRestorationResponseDto),
  };
  const onQueued = vi.fn();
  const onRefused = vi.fn();
  const onConfirmOnCloud = vi.fn();
  const handlers = createStudioRestorationHandlers({
    api: api as unknown as StudioRestorationApi,
    graph: () => graph,
    revision: () => 7,
    cancel: vi.fn(),
    onQueued,
    onRefused,
    onConfirmOnCloud,
  });
  return { api, handlers, onQueued, onRefused, onConfirmOnCloud };
};

const restoration = (payload: Record<string, unknown>) =>
  createStudioCommandEnvelope(
    'job.enqueueRestoration',
    { mode: 'faithful', upscale: 2, preview: true, destinationId: 'lan', ...payload },
    7,
  );

const interpolation = (payload: Record<string, unknown>) =>
  createStudioCommandEnvelope(
    'job.enqueueInterpolation',
    { clipId: 'clip-video', targetFps: { num: 60, den: 1 }, destinationId: 'lan', ...payload },
    7,
  );

describe('Studio restoration jobs (FL-115)', () => {
  it('queues a preview of the named source on the named home worker and leaves the graph alone', async () => {
    const { api, handlers, onQueued } = setup();

    await expect(handlers['job.enqueueRestoration'](restoration({ assetId: VIDEO_ID }))).resolves.toBe(7);

    expect(api.request).toHaveBeenCalledWith(VIDEO_ID, {
      mode: AssetRestorationMode.Faithful,
      upscale: 2,
      keepGrain: false,
      destinationId: 'lan',
    });
    expect(onQueued).toHaveBeenCalledWith({ id: 'restoration-1' });
  });

  it('renders the full version only from a reviewed preview', async () => {
    const { api, handlers, onRefused } = setup();

    await handlers['job.enqueueRestoration'](
      restoration({ assetId: VIDEO_ID, preview: false, restorationId: 'restoration-1' }),
    );
    expect(api.accept).toHaveBeenCalledWith(VIDEO_ID, 'restoration-1');

    await expect(
      handlers['job.enqueueRestoration'](restoration({ assetId: VIDEO_ID, preview: false })),
    ).rejects.toBeInstanceOf(StudioRestorationCommandError);
    expect(onRefused).toHaveBeenCalledWith('frameleaf_studio_restore_preview_first');
  });

  it('refuses a full render when the explicit destination differs from the reviewed preview', async () => {
    const { api, handlers, onRefused } = setup();

    await expect(
      handlers['job.enqueueRestoration'](
        restoration({ assetId: VIDEO_ID, preview: false, restorationId: 'restoration-1', destinationId: 'busy' }),
      ),
    ).rejects.toBeInstanceOf(StudioRestorationCommandError);

    expect(onRefused).toHaveBeenCalledWith('frameleaf_studio_restore_destination_changed');
    expect(api.accept).not.toHaveBeenCalled();
  });

  it('never sends anything to Frameleaf Cloud: it opens the Restore panel to estimate and confirm', async () => {
    const { api, handlers, onRefused, onConfirmOnCloud } = setup();

    await expect(
      handlers['job.enqueueRestoration'](restoration({ assetId: VIDEO_ID, destinationId: 'cloud' })),
    ).rejects.toBeInstanceOf(StudioRestorationCommandError);

    expect(onConfirmOnCloud).toHaveBeenCalledWith(VIDEO_ID, 'restore');
    expect(onRefused).toHaveBeenCalledWith('frameleaf_studio_job_confirm_on_cloud');
    expect(api.request).not.toHaveBeenCalled();
  });

  it('refuses without a source, on an unavailable or unknown destination, and never picks another', async () => {
    const { api, handlers } = setup();

    for (const payload of [
      {},
      { assetId: VIDEO_ID, destinationId: 'busy' },
      { assetId: VIDEO_ID, destinationId: 'x' },
    ]) {
      await expect(handlers['job.enqueueRestoration'](restoration(payload))).rejects.toBeInstanceOf(
        StudioRestorationCommandError,
      );
    }
    expect(api.request).not.toHaveBeenCalled();
  });
});

describe('Studio Smooth motion jobs (FL-162)', () => {
  it('previews Smooth motion of the clip’s original on the home worker, as a new version', async () => {
    const { api, handlers } = setup();

    await expect(handlers['job.enqueueInterpolation'](interpolation({}))).resolves.toBe(7);

    expect(api.getOptions).toHaveBeenCalledWith(VIDEO_ID, AssetRestorationMode.SmoothMotion);
    expect(api.request).toHaveBeenCalledWith(VIDEO_ID, {
      mode: AssetRestorationMode.SmoothMotion,
      upscale: 1,
      smoothMotionFactor: 2,
      keepGrain: false,
      destinationId: 'lan',
    });
  });

  it('uses an explicit factor, and derives one from the target frame rate otherwise', async () => {
    const { api, handlers } = setup();

    await handlers['job.enqueueInterpolation'](interpolation({ factor: 8 }));
    expect(api.request).toHaveBeenLastCalledWith(VIDEO_ID, expect.objectContaining({ smoothMotionFactor: 8 }));

    await handlers['job.enqueueInterpolation'](interpolation({ targetFps: { num: 120, den: 1 } }));
    expect(api.request).toHaveBeenLastCalledWith(VIDEO_ID, expect.objectContaining({ smoothMotionFactor: 4 }));

    expect(smoothMotionFactorFor(60, 30)).toBe(2);
    expect(smoothMotionFactorFor(100, 25)).toBe(4);
    expect(smoothMotionFactorFor(240, 24)).toBe(8);
    expect(smoothMotionFactorFor(60, null)).toBe(2);
  });

  it('confirms Frameleaf Cloud Smooth motion in the Restore panel, never from the command', async () => {
    const { api, handlers, onConfirmOnCloud } = setup();

    await expect(
      handlers['job.enqueueInterpolation'](interpolation({ destinationId: 'cloud' })),
    ).rejects.toBeInstanceOf(StudioRestorationCommandError);

    expect(onConfirmOnCloud).toHaveBeenCalledWith(VIDEO_ID, 'smooth-motion');
    expect(api.request).not.toHaveBeenCalled();
  });

  it('refuses a clip that is not saved, a restored version and a photo', async () => {
    const { api, handlers, onRefused } = setup();

    await expect(handlers['job.enqueueInterpolation'](interpolation({ clipId: 'nope' }))).rejects.toBeInstanceOf(
      StudioRestorationCommandError,
    );
    await expect(
      handlers['job.enqueueInterpolation'](interpolation({ clipId: 'clip-restored' })),
    ).rejects.toBeInstanceOf(StudioRestorationCommandError);
    api.getAsset.mockResolvedValue({ id: VIDEO_ID, type: AssetTypeEnum.Image } as AssetResponseDto);
    await expect(handlers['job.enqueueInterpolation'](interpolation({}))).rejects.toBeInstanceOf(
      StudioRestorationCommandError,
    );

    expect(onRefused.mock.calls.map(([key]) => key)).toEqual([
      'frameleaf_studio_smooth_motion_no_clip',
      'frameleaf_studio_smooth_motion_from_original',
      'frameleaf_studio_smooth_motion_video_only',
    ]);
    expect(api.request).not.toHaveBeenCalled();
    expect(clipMediaId(graph, 'clip-video')).toBe(VIDEO_ID);
  });
});
