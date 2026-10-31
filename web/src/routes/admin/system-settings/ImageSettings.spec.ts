import {
  Colorspace,
  ImageFormat,
  QueueCommand,
  QueueName,
  type AdminConfigDto,
  type QueueResponseDto,
} from '@frameleaf/sdk';
import { fireEvent, render, screen, within } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { SystemConfigDraftStore } from '$lib/frameleaf/system-config-draft.svelte';
import en from '../../../../../i18n/en.json';
import ImageSettings from './ImageSettings.svelte';

const draft = vi.hoisted(() => ({ store: undefined as unknown }));

vi.mock('$lib/managers/feature-flags-manager.svelte', () => ({
  featureFlagsManager: { value: { configFile: false } },
}));
vi.mock('$lib/frameleaf/system-config-draft.svelte', async (original) => ({
  ...(await original<object>()),
  requireSystemConfigDraft: () => draft.store,
  getSystemConfigDraft: () => draft.store,
}));

const config = () =>
  ({
    image: {
      thumbnail: { format: ImageFormat.Webp, size: 250, quality: 80, progressive: false },
      preview: { format: ImageFormat.Jpeg, size: 1440, quality: 80, progressive: false },
      colorspace: Colorspace.P3,
      extractEmbedded: false,
      enhancedRaw: { enabled: true },
      fullsize: { enabled: false, format: ImageFormat.Jpeg, quality: 80, progressive: false },
    },
  }) as unknown as AdminConfigDto;

const newStore = () =>
  new SystemConfigDraftStore(
    { config: config(), revision: 'r1' },
    { defaults: config(), load: vi.fn(), save: vi.fn() },
  ) as SystemConfigDraftStore & { draft: AdminConfigDto };

const queue = (waiting: number) =>
  ({
    name: QueueName.ThumbnailGeneration,
    isPaused: false,
    hasUnfinishedWork: waiting > 0,
    statistics: { active: 0, completed: 0, delayed: 0, failed: 0, paused: 0, waiting },
  }) as QueueResponseDto;

const quality = () => within(screen.getByRole('group', { name: 'Preview quality' }));

describe('Image previews (FL-366)', () => {
  beforeAll(() => {
    addMessages('dev', en);
  });

  beforeEach(() => {
    sdkMock.getQueue.mockReset().mockResolvedValue(queue(0));
    sdkMock.runQueueCommandLegacy.mockReset().mockResolvedValue({} as never);
  });

  it('opens on the answer and reads the server defaults as Balanced', async () => {
    draft.store = newStore();
    render(ImageSettings);

    const status = within(screen.getByRole('region', { name: 'Preview status' }));
    expect(status.getByRole('heading', { name: 'Every photo has a preview' })).toBeInTheDocument();
    expect(quality().getByRole('button', { name: 'Balanced', pressed: true })).toBeInTheDocument();
  });

  it('says previews are being made while the work is waiting', async () => {
    sdkMock.getQueue.mockResolvedValue(queue(12));
    draft.store = newStore();
    render(ImageSettings);

    expect(await screen.findByRole('heading', { name: 'Making previews' })).toBeInTheDocument();
    expect(screen.getByText(/12 photos and videos are waiting/)).toBeInTheDocument();
  });

  it('writes the thumbnail and preview numbers and warns before saving', async () => {
    const store = newStore();
    draft.store = store;
    render(ImageSettings);

    expect(screen.queryByText('These choices apply to photos added from now on')).not.toBeInTheDocument();
    await fireEvent.click(quality().getByRole('button', { name: 'Sharpest' }));
    expect(store.draft.image.thumbnail).toMatchObject({ size: 480, quality: 90, format: ImageFormat.Webp });
    expect(store.draft.image.preview).toMatchObject({ size: 2160, quality: 90, format: ImageFormat.Jpeg });
    expect(screen.getByText('These choices apply to photos added from now on')).toBeInTheDocument();

    await fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(store.draft.image.preview).toMatchObject({ size: 1440, quality: 80 });
    expect(quality().getByRole('button', { name: 'Balanced', pressed: true })).toBeInTheDocument();
  });

  it('reads Custom when one number is set under Advanced', async () => {
    const store = newStore();
    draft.store = store;
    render(ImageSettings);

    await fireEvent.change(screen.getByRole('combobox', { name: 'Thumbnail size' }), { target: { value: '720' } });
    expect(store.draft.image.thumbnail.size).toBe(720);
    expect(quality().getByRole('button', { name: 'Custom', pressed: true })).toBeInTheDocument();
  });

  it('keeps every field: full-size copies, colour and RAW', async () => {
    const store = newStore();
    draft.store = store;
    render(ImageSettings);

    await fireEvent.click(screen.getByRole('switch', { name: 'Make full-size viewing copies' }));
    expect(store.draft.image.fullsize.enabled).toBe(true);
    await fireEvent.click(screen.getByRole('button', { name: 'sRGB' }));
    expect(store.draft.image.colorspace).toBe(Colorspace.Srgb);
    await fireEvent.click(screen.getByRole('switch', { name: 'Use the camera’s own preview' }));
    expect(store.draft.image.extractEmbedded).toBe(true);
    await fireEvent.click(screen.getByRole('switch', { name: 'Better RAW previews' }));
    expect(store.draft.image.enhancedRaw).toEqual({ enabled: false });
  });

  it('rebuilds every preview with the thumbnail job', async () => {
    sdkMock.getQueue.mockResolvedValueOnce(queue(0)).mockResolvedValueOnce(queue(30));
    draft.store = newStore();
    render(ImageSettings);
    expect(await screen.findByRole('heading', { name: 'Every photo has a preview' })).toBeInTheDocument();

    await fireEvent.click(screen.getByRole('button', { name: 'Rebuild previews' }));
    expect(sdkMock.runQueueCommandLegacy).toHaveBeenCalledWith({
      name: QueueName.ThumbnailGeneration,
      queueCommandDto: { command: QueueCommand.Start, force: true },
    });
    expect(await screen.findByText(/Every preview is being made again/)).toBeInTheDocument();
    // the queue is read again, so the running rebuild shows without a reload
    expect(await screen.findByRole('heading', { name: 'Making previews' })).toBeInTheDocument();
    expect(screen.getByText(/30 photos and videos are waiting/)).toBeInTheDocument();
  });

  it('says the space previews take, about what each choice would take, and saves a rebuild for tonight (FL-521)', async () => {
    sdkMock.getMediaCopies.mockResolvedValue({
      photos: 900,
      withoutPreview: 0,
      videos: 100,
      withCopy: 10,
      previewsBytes: 41_000_000_000,
      playbackBytes: null,
      measuredAt: '2026-10-22T03:00:00.000Z',
      tonight: [],
      videoMinutes: 0,
      copyMinutes: 0,
      videoCard: { failedAt: null, slowdown: null, lastTest: null },
    });
    sdkMock.redoLibraryWork.mockResolvedValue({ tonight: ['thumbnailGeneration' as never] });
    const store = newStore();
    const saveKeys = vi.spyOn(store, 'saveKeys').mockResolvedValue(true);
    draft.store = store;
    render(ImageSettings);

    expect(await screen.findByText(/They take 41 GB for your 1,000 photos and videos/)).toBeInTheDocument();
    expect(screen.getByText(/Previews would take about 41 GB for your library/)).toBeInTheDocument();

    await fireEvent.click(quality().getByRole('button', { name: 'Sharpest' }));
    await fireEvent.click(screen.getByRole('button', { name: 'Save and rebuild tonight' }));
    expect(saveKeys).toHaveBeenCalledWith(['image']);
    expect(sdkMock.redoLibraryWork).toHaveBeenCalledWith({
      libraryRedoDto: { queue: 'thumbnailGeneration', when: 'tonight' },
    });
  });

  it('stops a rebuild that is running (FL-521)', async () => {
    sdkMock.getQueue.mockResolvedValue(queue(40));
    sdkMock.emptyQueue.mockResolvedValue(undefined as never);
    draft.store = newStore();
    render(ImageSettings);

    await fireEvent.click(await screen.findByRole('button', { name: 'Stop' }));
    expect(sdkMock.emptyQueue).toHaveBeenCalledWith({
      name: QueueName.ThumbnailGeneration,
      queueDeleteDto: { failed: false },
    });
  });
});
