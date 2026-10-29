import { MediaOperationStatus, StudioMovieMood, StudioMovieMusicKind, StudioMovieStep } from '@frameleaf/sdk';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { init, register, waitLocale } from 'svelte-i18n';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import MakeMovieSheet from './MakeMovieSheet.svelte';

const goto = vi.hoisted(() => vi.fn());
vi.mock('$app/navigation', () => ({ goto }));
vi.mock('$lib/managers/auth-manager.svelte', () => ({ authManager: { params: {} } }));

const album = { kind: 'album' as const, albumId: 'album-1', name: 'Lake weekend', itemCount: 24 };
const result = {
  projectId: '0195e2a0-0000-7000-8000-000000000010',
  revision: 1,
  version: 1,
  title: 'Lake weekend',
  sourceName: 'Lake weekend',
  lengthSeconds: 60,
  bpm: 120,
  bars: [0, 2, 4],
  beats: [0, 0.5, 1, 1.5, 2],
  downbeat: 0,
  shots: [
    { assetId: 'a1', start: 0, end: 4 },
    { assetId: 'a2', start: 4, end: 60 },
  ],
  music: StudioMovieMusicKind.Generated,
  mood: StudioMovieMood.Calm,
  musicName: '',
  musicImportId: '0195e2a0-0000-4000-8000-0000000000aa',
  musicSeconds: 60,
};
const job = (status: MediaOperationStatus, step: StudioMovieStep, done = false) => ({
  id: 'job-1',
  status,
  step,
  progress: done ? 100 : 40,
  error: null,
  result: done ? result : null,
});

/** FL-561: the Make a movie sheet: three choices, progress, the movie, another version and Studio. */
describe('MakeMovieSheet', () => {
  beforeAll(async () => {
    await init({ fallbackLocale: 'en-US' });
    register('en-US', () => import('$i18n/en.json'));
    await waitLocale('en-US');
    HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
      this.open = true;
    };
    HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
      this.open = false;
    };
    HTMLMediaElement.prototype.play = () => Promise.resolve();
    HTMLMediaElement.prototype.pause = () => {};
  });

  beforeEach(() => {
    vi.clearAllMocks();
    sdkMock.getMlCapabilities.mockResolvedValue({
      workloads: [],
      studio: { generationWorker: true },
    } as never);
    sdkMock.getStudioMovieSongs.mockResolvedValue([
      { id: 'song-1', kind: 'audio', name: 'Home Again', durationSeconds: 214 },
      { id: 'video-1', kind: 'video', name: 'Beach day', durationSeconds: 95 },
    ] as never);
    sdkMock.createStudioMovie.mockResolvedValue({ id: 'job-1', status: MediaOperationStatus.Queued } as never);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('offers length, music and title, and makes the movie from the album', async () => {
    sdkMock.getStudioMovie.mockResolvedValue(job(MediaOperationStatus.Rendering, StudioMovieStep.Music) as never);
    render(MakeMovieSheet, { open: true, source: album });

    expect(await screen.findByText('Lake weekend')).toBeInTheDocument();
    expect(screen.getByText(/24 items · Frameleaf picks the best moments/)).toBeInTheDocument();
    for (const label of ['30 sec', '1 min', '3 min', 'Calm', 'Warm', 'Upbeat', 'Big moments']) {
      expect(screen.getByRole('radio', { name: new RegExp(label) })).toBeInTheDocument();
    }
    expect(screen.getByRole('radio', { name: '1 min' })).toHaveAttribute('aria-checked', 'true');

    await fireEvent.click(screen.getByRole('radio', { name: '3 min' }));
    await fireEvent.click(screen.getByRole('radio', { name: /Upbeat/ }));
    await fireEvent.input(screen.getByLabelText('Title (optional)'), { target: { value: 'Summer at the lake' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Make movie' }));

    expect(sdkMock.createStudioMovie).toHaveBeenCalledWith({
      studioMovieCreateDto: {
        albumId: 'album-1',
        lengthSeconds: 180,
        music: 'generated',
        mood: 'upbeat',
        title: 'Summer at the lake',
        sourceName: 'Lake weekend',
      },
    });
    expect(await screen.findByText('Chose the best moments')).toBeInTheDocument();
    expect(screen.getByText('Writing upbeat music for your movie…')).toBeInTheDocument();
    expect(screen.getByText(/appears in Activity/)).toBeInTheDocument();
  });

  it('picks a song from the library and follows its beat', async () => {
    render(MakeMovieSheet, { open: true, source: album });
    await fireEvent.click(await screen.findByRole('radio', { name: /A song from my library/ }));
    expect(await screen.findByRole('radio', { name: /Home Again/ })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('radio', { name: /Beach day.*Sound of a video/ })).toBeInTheDocument();
    await fireEvent.click(screen.getByRole('radio', { name: /Beach day/ }));
    await fireEvent.click(screen.getByRole('button', { name: 'Make movie' }));
    expect(sdkMock.createStudioMovie.mock.calls[0][0].studioMovieCreateDto).toMatchObject({
      music: 'song',
      songAssetId: 'video-1',
    });
  });

  it('offers only a song when no computer can make music', async () => {
    sdkMock.getMlCapabilities.mockResolvedValue({ workloads: [], studio: { generationWorker: false } } as never);
    render(MakeMovieSheet, { open: true, source: album });
    await waitFor(() => expect(screen.getByRole('radio', { name: /Made for this movie/ })).toBeDisabled());
    expect(screen.getByRole('radio', { name: /A song from my library/ })).toHaveAttribute('aria-checked', 'true');
  });

  it('shows the movie, makes another version of it and opens it in Studio', async () => {
    sdkMock.getStudioMovie.mockResolvedValue(job(MediaOperationStatus.Completed, StudioMovieStep.Done, true) as never);
    render(MakeMovieSheet, { open: true, source: album });
    await fireEvent.click(await screen.findByRole('button', { name: 'Make movie' }));

    expect(await screen.findByText('Your movie is ready')).toBeInTheDocument();
    expect(screen.getByText('2, each cut on a beat')).toBeInTheDocument();
    expect(screen.getByText('Made for this movie · Calm')).toBeInTheDocument();
    expect(screen.getByLabelText('2 shots, each cut on a beat')).toBeInTheDocument();

    sdkMock.createStudioMovie.mockClear();
    await fireEvent.click(screen.getByRole('button', { name: 'Try another version' }));
    expect(sdkMock.createStudioMovie.mock.calls[0][0].studioMovieCreateDto).toMatchObject({ previousId: 'job-1' });

    await screen.findByText('Your movie is ready');
    await fireEvent.click(screen.getByRole('button', { name: 'Edit in Studio' }));
    expect(goto).toHaveBeenCalledWith(`/studio?project=${result.projectId}`);
  });

  it('says why a movie could not be made', async () => {
    sdkMock.getStudioMovie.mockResolvedValue({
      ...job(MediaOperationStatus.Failed, StudioMovieStep.Music),
      error: 'Close this movie in Studio, then try another version',
    } as never);
    render(MakeMovieSheet, { open: true, source: album });
    await fireEvent.click(await screen.findByRole('button', { name: 'Make movie' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Close this movie in Studio');
  });
});
