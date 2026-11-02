import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/svelte';
import { init, register, waitLocale } from 'svelte-i18n';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { authManager } from '$lib/managers/auth-manager.svelte';
import { eventManager } from '$lib/managers/event-manager.svelte';
import SpokenWordsActivity from './SpokenWordsActivity.svelte';

beforeAll(async () => {
  await init({ fallbackLocale: 'en-US' });
  register('en-US', () => import('$i18n/en.json'));
  await waitLocale('en-US');
});
beforeEach(() => {
  vi.resetAllMocks();
  authManager.setUser({ id: 'owner' } as never);
  authManager.setPreferences({} as never);
});
afterEach(() => {
  cleanup();
  authManager.reset();
});
it('shows initially unavailable indexing even with no asset operation and retries through current revision', async () => {
  const status = { enabled: true, generation: 'generation', indexed: 0, pending: 0, failed: 0, error: 'unavailable' };
  sdkMock.getSpeechStatus.mockResolvedValue(status as never);
  sdkMock.retrySpeechIndexing.mockResolvedValue(status as never);
  render(SpokenWordsActivity);
  await screen.findByText('The selected worker is unavailable. Indexing will resume when it returns.');
  await fireEvent.click(screen.getByRole('button', { name: 'Retry failed indexing' }));
  expect(sdkMock.retrySpeechIndexing).toHaveBeenCalledWith({ speechRevisionDto: { expectedGeneration: 'generation' } });
  expect(screen.queryByText(/private-source|transcript text/)).not.toBeInTheDocument();
});
it('evicts the safe aggregate on account revocation and ignores late status', async () => {
  let resolve!: (value: never) => void;
  sdkMock.getSpeechStatus.mockImplementation(() => new Promise((done) => (resolve = done)));
  render(SpokenWordsActivity);
  await waitFor(() => expect(sdkMock.getSpeechStatus).toHaveBeenCalled());
  eventManager.emit('AuthLogout');
  resolve({ enabled: true, indexed: 900, pending: 2, failed: 1 } as never);
  await waitFor(() => expect(screen.queryByText(/900 indexed/)).not.toBeInTheDocument());
});
it('clears an earlier retry error when a later retry succeeds', async () => {
  const status = { enabled: true, generation: 'generation', indexed: 0, pending: 0, failed: 1 };
  sdkMock.getSpeechStatus.mockResolvedValue(status as never);
  sdkMock.retrySpeechIndexing.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(status as never);
  render(SpokenWordsActivity);
  const retry = await screen.findByRole('button', { name: 'Retry failed indexing' });
  await fireEvent.click(retry);
  await screen.findByText(/could not be loaded or saved/);
  await fireEvent.click(retry);
  await waitFor(() => expect(screen.queryByText(/could not be loaded or saved/)).not.toBeInTheDocument());
});
