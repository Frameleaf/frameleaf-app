import { LibrarySetupStageId, LibrarySetupStageStatus, Phase, type LibrarySetupProgressDto } from '@frameleaf/sdk';
import { fireEvent, render, screen } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import SetupBar from '$lib/components/frameleaf/SetupBar.svelte';
import en from '../../../../../i18n/en.json';

const auth = vi.hoisted(() => ({ authenticated: true, user: { isAdmin: true } }));
vi.mock('$lib/managers/auth-manager.svelte', () => ({ authManager: auth }));

const progress = (overrides: Partial<LibrarySetupProgressDto> = {}): LibrarySetupProgressDto => ({
  active: true,
  phase: Phase.Rescanning,
  paused: false,
  completedAt: null,
  items: 823_034,
  people: 1286,
  albums: 412,
  flagged: 14,
  stages: [
    { id: LibrarySetupStageId.Check, status: LibrarySetupStageStatus.Running, done: 312_640, total: 823_034 },
    { id: LibrarySetupStageId.Thumbnails, status: LibrarySetupStageStatus.Running, done: 500_000, total: 823_034 },
    { id: LibrarySetupStageId.Search, status: LibrarySetupStageStatus.Waiting, done: 0, total: 823_034 },
  ],
  ...overrides,
});

beforeAll(() => {
  addMessages('dev', en);
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
    this.open = true;
  };
  vi.stubGlobal('matchMedia', () => ({ matches: true }));
});
beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  auth.user.isAdmin = true;
});

/** FL-1146: after an Immich import the library opens at once; this bar shows what is still running. */
describe('SetupBar', () => {
  it('shows the running stage, flagged files and the stages still waiting', async () => {
    sdkMock.getLibrarySetupProgress.mockResolvedValue(progress());
    render(SetupBar);

    expect(await screen.findByText('Setting up your library')).toBeInTheDocument();
    expect(screen.getByText(/Checking original files · 312,640 of 823,034/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /14 files need a look/ })).toBeInTheDocument();

    await fireEvent.click(screen.getByRole('button', { name: /Details/ }));
    expect(screen.getByText('Starts by itself when the file check is finished.')).toBeInTheDocument();
  });

  it('pauses and resumes setup', async () => {
    sdkMock.getLibrarySetupProgress.mockResolvedValue(progress());
    sdkMock.pauseLibrarySetup.mockResolvedValue(progress({ paused: true }));
    render(SetupBar);

    await fireEvent.click((await screen.findAllByRole('button', { name: 'Pause' }))[0]);

    expect(sdkMock.pauseLibrarySetup).toHaveBeenCalledWith({ librarySetupPauseDto: { paused: true } });
    expect(await screen.findByText('Setup is paused')).toBeInTheDocument();
  });

  it('is not shown to members, or when the server was not set up from an import', async () => {
    auth.user.isAdmin = false;
    render(SetupBar);
    await vi.waitFor(() => expect(sdkMock.getLibrarySetupProgress).not.toHaveBeenCalled());

    auth.user.isAdmin = true;
    sdkMock.getLibrarySetupProgress.mockResolvedValue(progress({ active: false, stages: [] }));
    render(SetupBar);
    await vi.waitFor(() => expect(sdkMock.getLibrarySetupProgress).toHaveBeenCalled());
    expect(screen.queryByText('Setting up your library')).not.toBeInTheDocument();
  });

  it('says when setup needs attention and offers a retry instead of pause', async () => {
    sdkMock.getLibrarySetupProgress.mockResolvedValue(progress({ phase: Phase.NeedsAttention }));
    render(SetupBar);

    expect(await screen.findByText('Setup needs attention')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Pause' })).not.toBeInTheDocument();
    await fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(sdkMock.beginLibrarySetup).toHaveBeenCalled();
  });

  it('keeps asking after a failed request', async () => {
    vi.useFakeTimers();
    try {
      sdkMock.getLibrarySetupProgress.mockRejectedValueOnce(new Error('restarting'));
      sdkMock.getLibrarySetupProgress.mockResolvedValue(progress());
      render(SetupBar);
      await vi.advanceTimersByTimeAsync(0);
      expect(screen.queryByText('Setting up your library')).not.toBeInTheDocument();

      await vi.advanceTimersByTimeAsync(15_000);
      expect(screen.getByText('Setting up your library')).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('opens the completion window once when everything has finished', async () => {
    const done = progress({ phase: Phase.Complete, completedAt: '2026-11-03T10:00:00.000Z' });
    sdkMock.getLibrarySetupProgress.mockResolvedValue(done);
    const first = render(SetupBar);

    expect(await screen.findByText('Your library is ready')).toBeInTheDocument();
    expect(screen.queryByText('Setting up your library')).not.toBeInTheDocument();
    expect(screen.getByText('1,286')).toBeInTheDocument();
    await fireEvent.click(screen.getByRole('button', { name: 'Start exploring' }));
    expect(screen.queryByText('Your library is ready')).not.toBeInTheDocument();
    first.unmount();

    render(SetupBar);
    await vi.waitFor(() => expect(sdkMock.getLibrarySetupProgress).toHaveBeenCalledTimes(2));
    expect(screen.queryByText('Your library is ready')).not.toBeInTheDocument();
  });
});
