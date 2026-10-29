import { MlWorkload, MlDestinationKind } from '@frameleaf/sdk';
import { render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/svelte';
import { init, register, waitLocale } from 'svelte-i18n';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { authManager } from '$lib/managers/auth-manager.svelte';
import { eventManager } from '$lib/managers/event-manager.svelte';
import { deferredPromise } from '@test-data/deferred';
import SpokenWordsSettings from './SpokenWordsSettings.svelte';

const status = {
  enabled: false,
  generation: 'generation',
  scope: 'library',
  albumIds: [],
  destinationId: 'local',
  indexed: 0,
  pending: 0,
  failed: 0,
  workerAvailable: true,
  error: null,
};
beforeAll(async () => {
  await init({ fallbackLocale: 'en-US' });
  register('en-US', () => import('$i18n/en.json'));
  await waitLocale('en-US');
  HTMLDialogElement.prototype.showModal ??= () => {
    const dialog = document.querySelector('dialog');
    if (dialog) {
      dialog.open = true;
    }
  };
  HTMLDialogElement.prototype.close ??= () => {
    const dialog = document.querySelector('dialog');
    if (dialog) {
      dialog.open = false;
    }
  };
});
beforeEach(() => {
  vi.resetAllMocks();
  authManager.setUser({ id: 'owner' } as never);
  authManager.setPreferences({} as never);
  sdkMock.getSpeechCapabilities.mockResolvedValue({ version: 1 });
  sdkMock.getSpeechStatus.mockResolvedValue(status as never);
  sdkMock.getAllAlbums.mockResolvedValue([
    { id: 'own', albumUsers: [{ role: 'owner', user: { id: 'owner' } }], albumName: 'My album' },
    {
      id: 'editor',
      albumUsers: [
        { role: 'owner', user: { id: 'other' } },
        { role: 'editor', user: { id: 'owner' } },
      ],
      albumName: 'Shared album',
    },
  ] as never);
  sdkMock.getMlCapabilities.mockResolvedValue({
    workloads: [
      {
        workload: MlWorkload.StudioAi,
        destinations: [
          { id: 'local', name: 'Home worker', kind: MlDestinationKind.Local },
          { id: 'lan', name: 'Network worker', kind: MlDestinationKind.Lan },
          { id: 'cloud', name: 'Cloud worker', kind: MlDestinationKind.FrameleafCloud },
        ],
      },
    ],
  } as never);
  sdkMock.updateSpeechSettings.mockResolvedValue({ ...status, enabled: true } as never);
  sdkMock.deleteSpeechIndex.mockResolvedValue(status as never);
});
afterEach(() => {
  cleanup();
  authManager.reset();
});
it('requires explicit opt-in, owner-safe albums and local/network worker selection with current revision', async () => {
  render(SpokenWordsSettings);
  const toggle = await screen.findByRole('switch', { name: 'Index spoken words' });
  expect(toggle).toHaveAttribute('aria-checked', 'false');
  expect(screen.queryByRole('option', { name: 'Cloud worker' })).not.toBeInTheDocument();
  await fireEvent.change(screen.getByRole('combobox', { name: 'Videos to index' }), { target: { value: 'albums' } });
  expect(screen.queryByText('Shared album')).not.toBeInTheDocument();
  await fireEvent.click(screen.getByRole('checkbox', { name: 'My album' }));
  await fireEvent.click(toggle);
  await fireEvent.click(screen.getByRole('button', { name: 'Save spoken words settings' }));
  await waitFor(() =>
    expect(sdkMock.updateSpeechSettings).toHaveBeenCalledWith({
      speechSettingsUpdateDto: {
        expectedGeneration: 'generation',
        enabled: true,
        scope: 'albums',
        albumIds: ['own'],
        destinationId: 'local',
      },
    }),
  );
});
it('explains purge disables indexing and carries the current revision only', async () => {
  render(SpokenWordsSettings);
  await screen.findByRole('switch', { name: 'Index spoken words' });
  await fireEvent.click(screen.getByRole('button', { name: 'Delete speech index' }));
  const dialog = screen.getByRole('dialog');
  expect(within(dialog).getByText(/turns indexing off/)).toBeInTheDocument();
  await fireEvent.click(within(dialog).getByRole('button', { name: 'Delete speech index' }));
  expect(sdkMock.deleteSpeechIndex).toHaveBeenCalledWith({ speechRevisionDto: { expectedGeneration: 'generation' } });
});
it('hides controls on an older server', async () => {
  sdkMock.getSpeechCapabilities.mockRejectedValue({ status: 404 });
  render(SpokenWordsSettings);
  await waitFor(() => expect(sdkMock.getSpeechCapabilities).toHaveBeenCalled());
  expect(screen.queryByRole('switch')).not.toBeInTheDocument();
  expect(sdkMock.getAllAlbums).not.toHaveBeenCalled();
});

it('keeps the draft and focused control when same-generation progress arrives', async () => {
  render(SpokenWordsSettings);
  const toggle = await screen.findByRole('switch', { name: 'Index spoken words' });
  await fireEvent.click(toggle);
  const scope = screen.getByRole('combobox', { name: 'Videos to index' });
  await fireEvent.change(scope, { target: { value: 'albums' } });
  await fireEvent.click(screen.getByRole('checkbox', { name: 'My album' }));
  await fireEvent.change(screen.getByRole('combobox', { name: 'Transcription worker' }), { target: { value: 'lan' } });
  scope.focus();
  sdkMock.getSpeechStatus.mockResolvedValue({ ...status, indexed: 7 } as never);
  eventManager.emit('SpeechIndexChange');
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('7'));
  expect(document.activeElement).toBe(scope);
  expect(toggle).toHaveAttribute('aria-checked', 'true');
  expect(screen.getByRole('checkbox', { name: 'My album' })).toBeChecked();
  await fireEvent.click(screen.getByRole('button', { name: 'Save spoken words settings' }));
  expect(sdkMock.updateSpeechSettings).toHaveBeenCalledWith({
    speechSettingsUpdateDto: {
      expectedGeneration: 'generation',
      enabled: true,
      scope: 'albums',
      albumIds: ['own'],
      destinationId: 'lan',
    },
  });
});

it('keeps its own save response authoritative when the change event arrives first', async () => {
  render(SpokenWordsSettings);
  const toggle = await screen.findByRole('switch', { name: 'Index spoken words' });
  await fireEvent.click(toggle);
  const saved = { ...status, enabled: true, generation: 'saved' };
  const response = deferredPromise<typeof saved>();
  sdkMock.updateSpeechSettings.mockReturnValue(response.promise as never);
  await fireEvent.click(screen.getByRole('button', { name: 'Save spoken words settings' }));
  sdkMock.getSpeechStatus.mockResolvedValue(saved as never);
  eventManager.emit('SpeechIndexChange');
  expect(toggle).toBeInTheDocument();
  response.resolve(saved);
  await waitFor(() => expect(screen.getByRole('button', { name: 'Save spoken words settings' })).toBeEnabled());
  expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'true');
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(sdkMock.getSpeechCapabilities).toHaveBeenCalledTimes(1);
});

it('ignores delayed progress from before a successful save', async () => {
  render(SpokenWordsSettings);
  const toggle = await screen.findByRole('switch', { name: 'Index spoken words' });
  const progress = deferredPromise<typeof status>();
  sdkMock.getSpeechStatus.mockReturnValueOnce(progress.promise as never);
  eventManager.emit('SpeechIndexChange');
  await waitFor(() => expect(sdkMock.getSpeechStatus).toHaveBeenCalledTimes(2));
  await fireEvent.click(toggle);
  sdkMock.updateSpeechSettings.mockResolvedValue({ ...status, enabled: true, generation: 'saved' } as never);
  await fireEvent.click(screen.getByRole('button', { name: 'Save spoken words settings' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Save spoken words settings' })).toBeEnabled());
  progress.resolve({ ...status, indexed: 9 });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'true');
  expect(screen.getByRole('status')).not.toHaveTextContent('9');
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

it('preserves the draft but requires explicit refresh after another settings generation wins', async () => {
  render(SpokenWordsSettings);
  const toggle = await screen.findByRole('switch', { name: 'Index spoken words' });
  await fireEvent.click(toggle);
  sdkMock.getSpeechStatus.mockResolvedValue({ ...status, generation: 'remote', indexed: 4 } as never);
  eventManager.emit('SpeechIndexChange');
  await screen.findByRole('alert');
  expect(toggle).toHaveAttribute('aria-checked', 'true');
  expect(screen.getByRole('status')).toHaveTextContent('4');
  expect(screen.getByRole('button', { name: 'Save spoken words settings' })).toBeDisabled();
  await fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
  await waitFor(() => expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'false'));
  await fireEvent.click(screen.getByRole('button', { name: 'Save spoken words settings' }));
  expect(sdkMock.updateSpeechSettings).toHaveBeenLastCalledWith({
    speechSettingsUpdateDto: expect.objectContaining({ expectedGeneration: 'remote' }),
  });
});

it('names its independent save and never submits an enclosing preferences form', async () => {
  const form = document.createElement('form');
  const submit = vi.fn((event: Event) => event.preventDefault());
  form.addEventListener('submit', submit);
  document.body.append(form);
  try {
    render(SpokenWordsSettings, { target: form });
    await screen.findByRole('switch', { name: 'Index spoken words' });
    const save = screen.getByRole('button', { name: 'Save spoken words settings' });
    expect(save).toHaveAttribute('type', 'button');
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
    await fireEvent.click(save);
    await waitFor(() => expect(sdkMock.updateSpeechSettings).toHaveBeenCalledOnce());
    expect(submit).not.toHaveBeenCalled();
    expect(sdkMock.updateMyPreferences).not.toHaveBeenCalled();
  } finally {
    cleanup();
    form.remove();
  }
});
