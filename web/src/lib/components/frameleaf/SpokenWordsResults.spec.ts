import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/svelte';
import { init, register, waitLocale } from 'svelte-i18n';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { emptyDiscoveryQuery } from '$lib/components/discovery/query';
import { videoSeek } from '$lib/frameleaf/video-seek.svelte';
import { authManager } from '$lib/managers/auth-manager.svelte';
import { eventManager } from '$lib/managers/event-manager.svelte';
import { navigate } from '$lib/utils/navigation';
import SpokenWordsResults from './SpokenWordsResults.svelte';

vi.mock('$lib/utils/navigation', () => ({
  navigate: vi.fn().mockResolvedValue(undefined),
  isSharedLinkRoute: () => false,
}));
const query = {
  ...emptyDiscoveryQuery(),
  mode: 'speech' as const,
  text: '"hello world"',
  filter: { isFavorite: { eq: true } },
};
const item = {
  asset: { id: 'video', originalFileName: 'Family.mp4' },
  transcriptId: 'transcript-1',
  hits: [{ text: 'hello world', startMs: 300_100, endMs: 300_900 }],
  hitsTotal: 1,
  nextHitCursor: null,
};
beforeAll(async () => {
  await init({ fallbackLocale: 'en-US' });
  register('en-US', () => import('$i18n/en.json'));
  await waitLocale('en-US');
});
beforeEach(() => {
  vi.resetAllMocks();
  authManager.setUser({ id: 'owner' } as never);
  authManager.setPreferences({} as never);
  sdkMock.getSpeechCapabilities.mockResolvedValue({ version: 1 });
  sdkMock.getSpeechStatus.mockResolvedValue({ enabled: true, generation: 'generation' } as never);
  sdkMock.searchSpokenWords.mockResolvedValue({ items: [item], total: 1, nextCursor: null } as never);
  videoSeek.pending = null;
});
afterEach(() => {
  cleanup();
  authManager.reset();
});
it('renders original timestamps and revalidates the complete predicate before original-source playback', async () => {
  render(SpokenWordsResults, { query });
  await screen.findByText('hello world');
  await fireEvent.click(screen.getByRole('button', { name: /play.*5:00/i }));
  await waitFor(() => expect(navigate).toHaveBeenCalled());
  expect(sdkMock.searchSpokenWords).toHaveBeenLastCalledWith({
    speechSearchDto: expect.objectContaining({
      query: '"hello world"',
      filter: { isFavorite: { eq: true }, trashedAt: { eq: null }, visibility: { eq: 'timeline' } },
      assetId: 'video',
    }),
  });
  expect(videoSeek.pending).toMatchObject({ assetId: 'video', seconds: 300.1, original: true });
});
it('refuses a cached timestamp after its completed transcript is replaced', async () => {
  render(SpokenWordsResults, { query });
  await screen.findByText('hello world');
  sdkMock.searchSpokenWords.mockResolvedValue({
    items: [{ ...item, transcriptId: 'replacement' }],
    total: 1,
    nextCursor: null,
  } as never);
  await fireEvent.click(screen.getByRole('button', { name: /play.*5:00/i }));
  await waitFor(() => expect(sdkMock.searchSpokenWords).toHaveBeenCalledTimes(3));
  expect(navigate).not.toHaveBeenCalled();
  expect(videoSeek.pending).toBeNull();
});
it('evicts quoted content immediately on content-free invalidation and ignores late stale answers', async () => {
  let resolve!: (value: never) => void;
  sdkMock.searchSpokenWords.mockImplementationOnce(() => new Promise((done) => (resolve = done)));
  render(SpokenWordsResults, { query });
  await waitFor(() => expect(sdkMock.searchSpokenWords).toHaveBeenCalledTimes(1));
  sdkMock.searchSpokenWords.mockResolvedValue({ items: [], total: 0, nextCursor: null });
  eventManager.emit('SpeechIndexChange');
  await waitFor(() => expect(sdkMock.searchSpokenWords).toHaveBeenCalledTimes(2));
  resolve({ items: [item], total: 1, nextCursor: null } as never);
  await waitFor(() => expect(screen.queryByText('hello world')).not.toBeInTheDocument());
});
it('clears quotes when the live invalidation connection is lost', async () => {
  render(SpokenWordsResults, { query });
  await screen.findByText('hello world');
  eventManager.emit('WebsocketDisconnect');
  await waitFor(() => expect(screen.queryByText('hello world')).not.toBeInTheDocument());
});
it('reports unsupported older servers without issuing semantic or metadata searches', async () => {
  sdkMock.getSpeechCapabilities.mockRejectedValue({ status: 404 });
  render(SpokenWordsResults, { query });
  await screen.findByText('This server does not support spoken words search yet.');
  expect(sdkMock.searchSpokenWords).not.toHaveBeenCalled();
  expect(sdkMock.searchSmart).not.toHaveBeenCalled();
  expect(sdkMock.searchAssets).not.toHaveBeenCalled();
});
it('shows a rejected query as invalid without a retry, and clears a failure as soon as a retry starts', async () => {
  sdkMock.searchSpokenWords.mockRejectedValueOnce({ status: 400 });
  render(SpokenWordsResults, { query });
  await screen.findByText("This search can't be run. Close any open quotes and use up to 64 words.");
  expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
  cleanup();

  sdkMock.searchSpokenWords.mockRejectedValueOnce({ status: 500 });
  render(SpokenWordsResults, { query });
  await fireEvent.click(await screen.findByRole('button', { name: 'Retry' }));
  expect(screen.queryByText(/could not be loaded/)).not.toBeInTheDocument();
  await screen.findByText('hello world');
});
