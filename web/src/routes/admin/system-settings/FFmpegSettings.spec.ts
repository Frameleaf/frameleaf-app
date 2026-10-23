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
      group('Which videos get a copy').getByRole('button', { name: 'Only those that need one', pressed: true }),
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
    });
    draft.store = newStore();
    render(FFmpegSettings);

    const status = within(screen.getByRole('region', { name: 'Playback copy status' }));
    expect(await status.findByText(/390 of your 3,350 videos have one, taking 52 GB/)).toBeInTheDocument();
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
});
