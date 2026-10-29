import {
  AudioCodec,
  CQMode,
  HardwareBackend,
  HlsVideoResolution,
  QueueCommand,
  QueueName,
  ToneMapping,
  TranscodeHWAccel,
  TranscodePolicy,
  VideoCodec,
  VideoContainer,
  type AdminConfigDto,
  type HardwareCheckResponseDto,
  type MediaCopiesResponseDto,
  type QueueResponseDto,
} from '@frameleaf/sdk';
import { fireEvent, render, screen, within } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { SystemConfigDraftStore } from '$lib/frameleaf/system-config-draft.svelte';
import en from '../../../../../i18n/en.json';
import FFmpegSettings from './FFmpegSettings.svelte';

const draft = vi.hoisted(() => ({ store: undefined as unknown }));

vi.mock('$lib/managers/feature-flags-manager.svelte', () => ({
  featureFlagsManager: { value: { configFile: false } },
}));
vi.mock('$lib/frameleaf/system-config-draft.svelte', async (original) => ({
  ...(await original<object>()),
  requireSystemConfigDraft: () => draft.store,
  getSystemConfigDraft: () => draft.store,
}));

const ffmpeg = (overrides: Partial<AdminConfigDto['ffmpeg']> = {}) => ({
  crf: 23,
  threads: 0,
  preset: 'ultrafast',
  targetVideoCodec: VideoCodec.H264,
  acceptedVideoCodecs: [VideoCodec.H264],
  targetAudioCodec: AudioCodec.Aac,
  acceptedAudioCodecs: [AudioCodec.Aac, AudioCodec.Mp3, AudioCodec.Opus],
  acceptedContainers: [VideoContainer.Mov, VideoContainer.Ogg, VideoContainer.Webm],
  targetResolution: '1080',
  maxBitrate: '0',
  bframes: -1,
  refs: 0,
  gopSize: 0,
  temporalAQ: false,
  cqMode: CQMode.Auto,
  twoPass: false,
  preferredHwDevice: 'auto',
  transcode: TranscodePolicy.Required,
  tonemap: ToneMapping.Hable,
  accel: TranscodeHWAccel.Disabled,
  accelDecode: true,
  realtime: {
    enabled: false,
    videoCodecs: [VideoCodec.H264, VideoCodec.Hevc],
    resolutions: [HlsVideoResolution.$480, HlsVideoResolution.$720, HlsVideoResolution.$1080],
  },
  ...overrides,
});

const newStore = (overrides: Partial<AdminConfigDto['ffmpeg']> = {}) => {
  const config = () => ({ ffmpeg: ffmpeg(overrides) }) as unknown as AdminConfigDto;
  return new SystemConfigDraftStore(
    { config: config(), revision: 'r1' },
    { defaults: config(), load: vi.fn(), save: vi.fn() },
  ) as SystemConfigDraftStore & { draft: AdminConfigDto };
};

const queue = (waiting: number) =>
  ({
    name: QueueName.VideoConversion,
    isPaused: false,
    hasUnfinishedWork: waiting > 0,
    statistics: { active: 0, completed: 0, delayed: 0, failed: 0, paused: 0, waiting },
  }) as QueueResponseDto;

const hardware = (backend: HardwareBackend, model: string | null) =>
  ({ server: { backend, model, vendor: null } }) as unknown as HardwareCheckResponseDto;

const group = (name: string) => within(screen.getByRole('group', { name }));

/** FL-537: 52 GB of copies over 866.7 minutes is 60 MB a minute; all 3,350 videos are 7,533.3 minutes. */
const copyMinutes = {
  videoMinutes: 7533.3,
  copyMinutes: 866.7,
  videoCard: { failedAt: null, slowdown: null, lastTest: null },
};

describe('Video playback copies (FL-366)', () => {
  beforeAll(() => {
    addMessages('dev', en);
  });

  beforeEach(() => {
    sdkMock.getQueue.mockReset().mockResolvedValue(queue(0));
    sdkMock.getHardwareCheck.mockReset().mockResolvedValue(hardware(HardwareBackend.Cpu, null));
    sdkMock.runQueueCommandLegacy.mockReset().mockResolvedValue({} as never);
  });

  it('opens on what happens to videos today', () => {
    draft.store = newStore();
    render(FFmpegSettings);

    const status = within(screen.getByRole('region', { name: 'Playback copy status' }));
    expect(status.getByRole('heading', { name: 'Every video plays on every device' })).toBeInTheDocument();
    expect(status.getByText(/get a 1080p playback copy/)).toBeInTheDocument();
    expect(
      group('Which videos get a copy').getByRole('button', { name: 'Only videos that need one', pressed: true }),
    ).toBeInTheDocument();
    expect(
      group('Playback quality').getByRole('button', { name: 'Better (1080p)', pressed: true }),
    ).toBeInTheDocument();
  });

  it('says how many videos have a copy and the space they take (FL-521)', async () => {
    sdkMock.getMediaCopies.mockResolvedValue({
      photos: 3000,
      withoutPreview: 0,
      videos: 3350,
      withCopy: 390,
      previewsBytes: null,
      playbackBytes: 52_000_000_000,
      measuredAt: '2026-10-22T03:00:00.000Z',
      tonight: [],
      ...copyMinutes,
    });
    draft.store = newStore();
    render(FFmpegSettings);

    const status = within(screen.getByRole('region', { name: 'Playback copy status' }));
    expect(await status.findByText(/390 of your 3,350 videos have one, taking 52 GB/)).toBeInTheDocument();
  });

  describe('FL-537', () => {
    const copies = (videoCard: Partial<MediaCopiesResponseDto['videoCard']> = {}) =>
      ({
        photos: 3000,
        withoutPreview: 0,
        videos: 3350,
        withCopy: 390,
        previewsBytes: null,
        playbackBytes: 52_000_000_000,
        measuredAt: '2026-10-22T03:00:00.000Z',
        tonight: [],
        ...copyMinutes,
        videoCard: { failedAt: null, slowdown: null, lastTest: null, ...videoCard },
      }) as MediaCopiesResponseDto;

    it('says about how many MB a minute each quality takes, from the copies measured', async () => {
      // 52 GB over 866.7 minutes is 60 MB a minute at Better, so Good is 30 and Best 250
      sdkMock.getMediaCopies.mockResolvedValue(copies());
      const store = newStore();
      draft.store = store;
      render(FFmpegSettings);

      expect(await screen.findByText(/about 60 MB a minute/)).toBeInTheDocument();
      await fireEvent.click(group('Playback quality').getByRole('button', { name: 'Best (4K)' }));
      expect(screen.getByText(/about 250 MB a minute/)).toBeInTheDocument();
      await fireEvent.click(group('Playback quality').getByRole('button', { name: 'Better (1080p)' }));
      // the 2,960 videos without a copy, 6,666.7 minutes at 60 MB a minute
      await fireEvent.click(group('Which videos get a copy').getByRole('button', { name: 'All videos' }));
      expect(screen.getByText(/every video gets a copy, about 400 GB more/)).toBeInTheDocument();
    });

    it('says when the graphics card stopped helping, and tests it', async () => {
      sdkMock.getMediaCopies.mockResolvedValue(copies({ failedAt: '2026-10-08T02:00:00.000Z', slowdown: 6 }));
      sdkMock.testVideoCard.mockResolvedValue({
        failedAt: '2026-10-08T02:00:00.000Z',
        slowdown: 6,
        lastTest: {
          at: '2026-10-23T10:00:00.000Z',
          ok: false,
          encoder: 'h264_vaapi',
          speed: null,
          softwareSpeed: 2,
          error: 'no device',
        },
      });
      draft.store = newStore({ accel: TranscodeHWAccel.Qsv });
      render(FFmpegSettings);

      const status = within(screen.getByRole('region', { name: 'Playback copy status' }));
      expect(
        await status.findByRole('heading', { name: /The graphics card stopped helping on Oct 8/ }),
      ).toBeInTheDocument();
      expect(status.getByText(/about 6 times slower/)).toBeInTheDocument();
      expect(status.getByRole('button', { name: 'Graphics card check' })).toBeInTheDocument();

      await fireEvent.click(status.getByRole('button', { name: 'Test it' }));
      expect(sdkMock.testVideoCard).toHaveBeenCalled();
      expect(await screen.findByText(/the graphics card did not answer/)).toBeInTheDocument();
      expect(screen.getByText(/The last test, on Oct 23, failed./)).toBeInTheDocument();
    });

    it('does not warn while the card is turned off', async () => {
      sdkMock.getMediaCopies.mockResolvedValue(copies({ failedAt: '2026-10-08T02:00:00.000Z' }));
      draft.store = newStore();
      render(FFmpegSettings);

      const status = within(screen.getByRole('region', { name: 'Playback copy status' }));
      expect(await status.findByText(/390 of your 3,350 videos/)).toBeInTheDocument();
      expect(status.queryByText(/stopped helping/)).not.toBeInTheDocument();
    });
  });

  it('reads numbers that match no choice as Custom', () => {
    draft.store = newStore({ targetResolution: '480', crf: 23 });
    render(FFmpegSettings);

    expect(group('Playback quality').getByRole('button', { name: 'Custom', pressed: true })).toBeInTheDocument();
  });

  it('writes the two choices into the saved video settings and warns before saving', async () => {
    const store = newStore();
    draft.store = store;
    render(FFmpegSettings);

    await fireEvent.click(group('Which videos get a copy').getByRole('button', { name: 'All videos' }));
    expect(store.draft.ffmpeg.transcode).toBe(TranscodePolicy.All);

    await fireEvent.click(group('Playback quality').getByRole('button', { name: 'Best (4K)' }));
    // The encoder speed is left as it was: real-time playback uses it too.
    expect(store.draft.ffmpeg).toMatchObject({ targetResolution: '2160', crf: 20, preset: 'ultrafast' });
    expect(screen.getByText('These choices apply to videos added from now on')).toBeInTheDocument();

    await fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(store.draft.ffmpeg).toMatchObject({
      transcode: TranscodePolicy.Required,
      targetResolution: '1080',
      crf: 23,
      preset: 'ultrafast',
    });
  });

  it('makes HDR and adapting to the connection plain switches', async () => {
    const store = newStore();
    draft.store = store;
    render(FFmpegSettings);

    await fireEvent.click(screen.getByRole('switch', { name: 'HDR on regular screens' }));
    expect(store.draft.ffmpeg.tonemap).toBe(ToneMapping.Disabled);
    await fireEvent.click(screen.getByRole('switch', { name: 'HDR on regular screens' }));
    expect(store.draft.ffmpeg.tonemap).toBe(ToneMapping.Hable);

    await fireEvent.click(screen.getByRole('switch', { name: 'Adjust quality to the connection (early feature)' }));
    expect(store.draft.ffmpeg.realtime.enabled).toBe(true);
  });

  it('turns the graphics card on with the kind the server check found', async () => {
    sdkMock.getHardwareCheck.mockResolvedValue(hardware(HardwareBackend.Qsv, 'Intel UHD 770'));
    const store = newStore();
    draft.store = store;
    render(FFmpegSettings);

    expect(await screen.findByText('Found: Intel UHD 770.')).toBeInTheDocument();
    await fireEvent.click(screen.getByRole('switch', { name: 'Use the graphics card to convert videos faster' }));
    expect(store.draft.ffmpeg.accel).toBe(TranscodeHWAccel.Qsv);
  });

  it('holds the graphics card switch when no card was found', async () => {
    draft.store = newStore();
    render(FFmpegSettings);

    expect(await screen.findByText(/No graphics card for video was found/)).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Use the graphics card to convert videos faster' })).toBeDisabled();
  });

  it('remakes the copies with the video conversion job', async () => {
    draft.store = newStore();
    render(FFmpegSettings);

    await fireEvent.click(screen.getByRole('button', { name: 'Remake copies' }));
    expect(sdkMock.runQueueCommandLegacy).toHaveBeenCalledWith({
      name: QueueName.VideoConversion,
      queueCommandDto: { command: QueueCommand.Start, force: true },
    });
    expect(await screen.findByText(/Playback copies are being made again/)).toBeInTheDocument();
  });

  it('keeps the detailed rule under Advanced and says when copies are off', async () => {
    const store = newStore();
    draft.store = store;
    render(FFmpegSettings);

    await fireEvent.change(screen.getByRole('combobox', { name: 'Rule' }), {
      target: { value: TranscodePolicy.Disabled },
    });
    expect(store.draft.ffmpeg.transcode).toBe(TranscodePolicy.Disabled);
    expect(screen.getByRole('heading', { name: 'Playback copies are off' })).toBeInTheDocument();
    expect(
      group('Which videos get a copy').getByRole('button', { name: 'Never make copies', pressed: true }),
    ).toBeInTheDocument();
  });

  it('re-reads the copies only when the conversion queue changed (FL-630)', async () => {
    vi.useFakeTimers();
    try {
      sdkMock.getMediaCopies.mockReset().mockResolvedValue({
        photos: 0,
        withoutPreview: 0,
        videos: 1,
        withCopy: 0,
        previewsBytes: null,
        playbackBytes: 0,
        measuredAt: null,
        tonight: [],
        ...copyMinutes,
      });
      draft.store = newStore();
      render(FFmpegSettings);
      await vi.advanceTimersByTimeAsync(0);
      expect(sdkMock.getMediaCopies).toHaveBeenCalledTimes(1);

      // nothing happened between two checks: the whole-library count is not read again
      await vi.advanceTimersByTimeAsync(5000);
      expect(sdkMock.getMediaCopies).toHaveBeenCalledTimes(1);

      // a copy made and finished between two checks
      sdkMock.getQueue.mockResolvedValue({
        ...queue(0),
        statistics: { ...queue(0).statistics, completed: 1 },
      });
      await vi.advanceTimersByTimeAsync(5000);
      expect(sdkMock.getMediaCopies).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
  it('reads the copies one at a time, and once more for refreshes asked meanwhile (FL-630)', async () => {
    vi.useFakeTimers();
    try {
      let answer: (value: never) => void = () => {};
      sdkMock.getMediaCopies.mockReset().mockImplementation(() => new Promise((resolve) => (answer = resolve)));
      draft.store = newStore();
      render(FFmpegSettings);
      await vi.advanceTimersByTimeAsync(0);
      expect(sdkMock.getMediaCopies).toHaveBeenCalledTimes(1);

      // two conversions finish while the first read is still counting
      for (const completed of [1, 2]) {
        sdkMock.getQueue.mockResolvedValue({ ...queue(0), statistics: { ...queue(0).statistics, completed } });
        await vi.advanceTimersByTimeAsync(5000);
      }
      expect(sdkMock.getMediaCopies).toHaveBeenCalledTimes(1);

      answer({
        photos: 0,
        withoutPreview: 0,
        videos: 1,
        withCopy: 1,
        previewsBytes: null,
        playbackBytes: 5000,
        measuredAt: null,
        tonight: [],
        ...copyMinutes,
      } as never);
      await vi.advanceTimersByTimeAsync(0);
      expect(sdkMock.getMediaCopies).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
