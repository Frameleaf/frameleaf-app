import {
  PlaybackSelfTestCase,
  PlaybackSelfTestStatus,
  TranscodeHWAccel,
  type PlaybackSelfTestResponseDto,
} from '@frameleaf/sdk';
import { fireEvent, render, screen } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import en from '../../../../../../../i18n/en.json';
import HdrPlaybackCheck from './HdrPlaybackCheck.svelte';
import { hdrCheckState } from './hdr-playback-check';

const result = (overrides: Partial<PlaybackSelfTestResponseDto> = {}): PlaybackSelfTestResponseDto => ({
  status: PlaybackSelfTestStatus.Done,
  startedAt: new Date().toISOString(),
  finishedAt: new Date().toISOString(),
  accel: TranscodeHWAccel.Qsv,
  cases: [],
  softwareFallback: [],
  ...overrides,
});

describe('HDR videos on Video playback copies › Speed (FL-977)', () => {
  beforeAll(() => {
    addMessages('dev', en);
  });

  beforeEach(() => {
    vi.useRealTimers();
    sdkMock.getPlaybackSelfTest.mockReset();
    sdkMock.startPlaybackSelfTest.mockReset();
  });

  it('says the graphics card plays HDR correctly, tested today', async () => {
    sdkMock.getPlaybackSelfTest.mockResolvedValue(result());
    render(HdrPlaybackCheck, { card: 'Intel (Quick Sync)' });

    expect(await screen.findByText('Your graphics card plays HDR correctly')).toBeInTheDocument();
    expect(
      screen.getByText(
        'Tested today with sample HDR videos: colours and brightness came out right, using Intel (Quick Sync).',
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Check again' })).toBeEnabled();
  });

  it('says HDR uses software, about how much slower, when an HDR kind failed', async () => {
    sdkMock.getPlaybackSelfTest.mockResolvedValue(result({ softwareFallback: [PlaybackSelfTestCase.Hdr10Pq] }));
    render(HdrPlaybackCheck, { card: 'NVIDIA (NVENC)', slowdown: 4.2 });

    expect(await screen.findByText('Using software for HDR')).toBeInTheDocument();
    expect(
      screen.getByText(
        'Your graphics card couldn’t keep HDR colours right, so Frameleaf converts HDR videos on the processor. They look right, but take about 4 times longer.',
      ),
    ).toBeInTheDocument();
  });

  it('keeps HDR on the card when only another kind of video failed, and says so', async () => {
    sdkMock.getPlaybackSelfTest.mockResolvedValue(result({ softwareFallback: [PlaybackSelfTestCase.Hev1Hevc] }));
    render(HdrPlaybackCheck, { card: 'VAAPI' });

    expect(await screen.findByText('Your graphics card plays HDR correctly')).toBeInTheDocument();
    expect(screen.getByText(/Some other videos are converted on the processor too/)).toBeInTheDocument();
  });

  it('says when the check did not finish', async () => {
    sdkMock.getPlaybackSelfTest.mockResolvedValue(result({ status: PlaybackSelfTestStatus.Failed }));
    render(HdrPlaybackCheck, { card: 'VAAPI' });

    expect(await screen.findByText('The HDR check didn’t finish')).toBeInTheDocument();
    expect(screen.getByText(/HDR videos keep converting on the processor meanwhile/)).toBeInTheDocument();
  });

  it('checks again: checking while it runs, then the answer', async () => {
    sdkMock.getPlaybackSelfTest.mockResolvedValue(result({ softwareFallback: [PlaybackSelfTestCase.HlgHevc] }));
    sdkMock.startPlaybackSelfTest.mockResolvedValue(result({ status: PlaybackSelfTestStatus.Running }));
    render(HdrPlaybackCheck, { card: 'Intel (Quick Sync)' });
    expect(await screen.findByText('Using software for HDR')).toBeInTheDocument();

    vi.useFakeTimers({ shouldAdvanceTime: true });
    await fireEvent.click(screen.getByRole('button', { name: 'Check again' }));

    expect(sdkMock.startPlaybackSelfTest).toHaveBeenCalledOnce();
    expect(await screen.findByText('Checking HDR playback…')).toBeInTheDocument();
    expect(screen.getByText('Playing short sample HDR videos. It takes under a minute.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Checking…' })).toBeDisabled();

    sdkMock.getPlaybackSelfTest.mockResolvedValue(result());
    await vi.advanceTimersByTimeAsync(2000);
    expect(await screen.findByText('Your graphics card plays HDR correctly')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Check again' })).toBeEnabled();
  });

  it('offers a first check when there has been none', async () => {
    sdkMock.getPlaybackSelfTest.mockResolvedValue(
      result({ status: PlaybackSelfTestStatus.None, startedAt: null, finishedAt: null }),
    );
    render(HdrPlaybackCheck, { card: 'VAAPI' });

    expect(await screen.findByText('Not checked yet')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Check now' })).toBeEnabled();
  });

  it('has no queue, job or schedule words', () => {
    const words = Object.entries(en)
      .filter(([key]) => key.startsWith('frameleaf_play_hdr'))
      .map(([, value]) => value)
      .join(' ');
    expect(words).not.toMatch(/\b(queue|job|cron|reconcil)/i);
  });

  it('reads each state from the result', () => {
    expect(hdrCheckState(undefined)).toBe('none');
    expect(hdrCheckState(result({ status: PlaybackSelfTestStatus.Running }))).toBe('running');
    expect(hdrCheckState(result({ softwareFallback: [PlaybackSelfTestCase.DolbyVision84] }))).toBe('software');
    expect(hdrCheckState(result({ softwareFallback: [PlaybackSelfTestCase.SdrH264] }))).toBe('hardware');
  });
});
