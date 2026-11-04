import { LibrarySetupStageId, LibrarySetupStageStatus, Phase, type LibrarySetupProgressDto } from '@frameleaf/sdk';
import { fireEvent, render, screen } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import SetupBar from '$lib/components/frameleaf/SetupBar.svelte';
import { locale } from '$lib/stores/preferences.store';
import { setupProgress } from '$lib/stores/setup-progress.svelte';
import { handleError } from '$lib/utils/handle-error';
import en from '../../../../../i18n/en.json';

const auth = vi.hoisted(() => ({ authenticated: true, user: { isAdmin: true } }));
vi.mock('$lib/managers/auth-manager.svelte', () => ({ authManager: auth }));
vi.mock('$lib/utils/handle-error', () => ({ handleError: vi.fn() }));

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
  // Reduced motion, so the completion window draws no confetti.
  vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
});
beforeEach(() => {
  vi.clearAllMocks();
  setupProgress.reset();
  localStorage.clear();
  locale.set('en-US');
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

  it('shows intentionally disabled AI processing as off while keeping other setup visible', async () => {
    const value = progress();
    value.stages = value.stages.map((stage) =>
      stage.id === LibrarySetupStageId.Search ? { ...stage, done: 0, total: 0, disabled: true } : stage,
    );
    sdkMock.getLibrarySetupProgress.mockResolvedValue(value);
    render(SetupBar);
    expect(await screen.findByText('Setting up your library')).toBeInTheDocument();
    await fireEvent.click(screen.getByRole('button', { name: /Details/ }));
    expect(screen.getByText('Off')).toBeInTheDocument();
    expect(screen.getByText('AI processing is turned off. You can enable it later.')).toBeInTheDocument();
    expect(screen.queryByText('Starts by itself when the file check is finished.')).not.toBeInTheDocument();
  });

  it('keeps resume available after enabled stages finish while paused', async () => {
    const value = progress({ paused: true, phase: Phase.Verifying });
    value.stages = value.stages.map((stage) =>
      stage.id === LibrarySetupStageId.Search
        ? { ...stage, status: LibrarySetupStageStatus.Waiting, disabled: true, done: 0, total: 0 }
        : { ...stage, status: LibrarySetupStageStatus.Done, done: stage.total },
    );
    sdkMock.getLibrarySetupProgress.mockResolvedValue(value);
    sdkMock.pauseLibrarySetup.mockResolvedValue({ ...value, paused: false });
    render(SetupBar);
    expect(await screen.findByText('Setup is paused')).toBeInTheDocument();
    await fireEvent.click(screen.getByRole('button', { name: 'Resume' }));
    expect(sdkMock.pauseLibrarySetup).toHaveBeenCalledWith({ librarySetupPauseDto: { paused: false } });
    expect(await screen.findByText('Setting up your library')).toBeInTheDocument();
  });

  it('does not promise AI search when completion follows disabled processing', async () => {
    const value = progress({ phase: Phase.Complete, completedAt: '2026-11-03T10:00:00.000Z' });
    value.stages = value.stages.map((stage) =>
      stage.id === LibrarySetupStageId.Search ? { ...stage, disabled: true, done: 0, total: 0 } : stage,
    );
    sdkMock.getLibrarySetupProgress.mockResolvedValue(value);
    render(SetupBar);
    expect(
      await screen.findByText(
        'Everything you imported is in Frameleaf, and every original was checked. AI processing is turned off. You can enable it later.',
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(
        'Everything you imported is in Frameleaf. Every original was checked, and smart search and faces are ready to use.',
      ),
    ).not.toBeInTheDocument();
  });

  it('says when quiet hours start the stage saved for the night, never that it is in progress', async () => {
    const tonight = new Date();
    tonight.setHours(23, 30, 0, 0);
    const value = progress({ phase: Phase.Verifying });
    value.stages = [
      { id: LibrarySetupStageId.Check, status: LibrarySetupStageStatus.Done, done: 823_034, total: 823_034 },
      { id: LibrarySetupStageId.Thumbnails, status: LibrarySetupStageStatus.Done, done: 1_646_068, total: 1_646_068 },
      {
        id: LibrarySetupStageId.Search,
        status: LibrarySetupStageStatus.Waiting,
        heldForNight: true,
        resumesAt: tonight.toISOString(),
        done: 1200,
        total: 1_646_200,
      },
    ];
    sdkMock.getLibrarySetupProgress.mockResolvedValue(value);
    render(SetupBar);
    expect(
      await screen.findByText(
        /Smart search, faces and videos · 1,200 of 1,646,200 · Saved for tonight, starts at 11:30\sPM/,
      ),
    ).toBeInTheDocument();
    await fireEvent.click(screen.getByRole('button', { name: /Details/ }));
    expect(screen.getByRole('region', { name: 'Setting up your library' })).toHaveTextContent(
      /Saved for tonight, starts at 11:30\sPM/,
    );
    expect(screen.queryByText('In progress')).not.toBeInTheDocument();
  });

  it('keeps counting videos while AI processing is off', async () => {
    const value = progress({ phase: Phase.Verifying });
    value.stages = [
      { id: LibrarySetupStageId.Check, status: LibrarySetupStageStatus.Done, done: 823_034, total: 823_034 },
      { id: LibrarySetupStageId.Thumbnails, status: LibrarySetupStageStatus.Done, done: 823_034, total: 823_034 },
      { id: LibrarySetupStageId.Search, status: LibrarySetupStageStatus.Running, disabled: true, done: 4, total: 10 },
    ];
    sdkMock.getLibrarySetupProgress.mockResolvedValue(value);
    render(SetupBar);
    expect(await screen.findByText(/Smart search, faces and videos · 4 of 10/)).toBeInTheDocument();
    await fireEvent.click(screen.getByRole('button', { name: /Details/ }));
    expect(
      screen.getByText('Getting videos ready to play. AI processing is turned off. You can enable it later.'),
    ).toBeInTheDocument();
    expect(screen.queryByText('Off')).not.toBeInTheDocument();
  });

  it('says when quiet hours start the videos left while AI processing is off', async () => {
    const value = progress({ phase: Phase.Verifying });
    value.stages = [
      { id: LibrarySetupStageId.Check, status: LibrarySetupStageStatus.Done, done: 823_034, total: 823_034 },
      { id: LibrarySetupStageId.Thumbnails, status: LibrarySetupStageStatus.Done, done: 823_034, total: 823_034 },
      {
        id: LibrarySetupStageId.Search,
        status: LibrarySetupStageStatus.Waiting,
        disabled: true,
        heldForNight: true,
        resumesAt: null,
        done: 4,
        total: 10,
      },
    ];
    sdkMock.getLibrarySetupProgress.mockResolvedValue(value);
    render(SetupBar);
    await fireEvent.click(await screen.findByRole('button', { name: /Details/ }));
    expect(screen.getByRole('region', { name: 'Setting up your library' })).toHaveTextContent('Saved for the night');
    expect(
      screen.queryByText('Getting videos ready to play. AI processing is turned off. You can enable it later.'),
    ).not.toBeInTheDocument();
  });

  it('keeps the last answer across pages, so the bar never hides and comes back', async () => {
    sdkMock.getLibrarySetupProgress.mockResolvedValue(progress());
    const first = render(SetupBar);
    expect(await screen.findByText('Setting up your library')).toBeInTheDocument();
    first.unmount();

    // The next page shows it before its own request answers.
    sdkMock.getLibrarySetupProgress.mockReturnValue(new Promise(() => {}));
    const next = render(SetupBar);
    expect(await screen.findByText(/Checking original files · 312,640 of 823,034/)).toBeInTheDocument();
    next.unmount();

    // Another account never sees it.
    auth.user.isAdmin = false;
    render(SetupBar);
    expect(screen.queryByText('Setting up your library')).not.toBeInTheDocument();
  });

  it('formats progress using the chosen number locale', async () => {
    locale.set('de-DE');
    sdkMock.getLibrarySetupProgress.mockResolvedValue(progress());
    render(SetupBar);
    expect(await screen.findByText(/Checking original files · 312\.640 of 823\.034/)).toBeInTheDocument();
  });

  it('does not promise both AI features from the combined completion stage', async () => {
    sdkMock.getLibrarySetupProgress.mockResolvedValue(
      progress({
        phase: Phase.Complete,
        completedAt: '2026-11-03T00:00:00Z',
        stages: [{ id: LibrarySetupStageId.Search, status: LibrarySetupStageStatus.Done, done: 1, total: 1 }],
      }),
    );
    render(SetupBar);
    expect(await screen.findByRole('heading', { name: 'Your library is ready' })).toBeInTheDocument();
    expect(
      screen.getByText('Everything you imported is in Frameleaf, and every original was checked.'),
    ).toBeInTheDocument();
  });

  it('formats completion counts using the chosen number locale', async () => {
    locale.set('de-DE');
    sdkMock.getLibrarySetupProgress.mockResolvedValue(
      progress({ phase: Phase.Complete, completedAt: '2026-11-03T10:00:00.000Z' }),
    );
    render(SetupBar);
    expect(await screen.findByText('Your library is ready')).toBeInTheDocument();
    expect(screen.getByText('1.286')).toBeInTheDocument();
  });

  it('pauses and resumes setup', async () => {
    sdkMock.getLibrarySetupProgress.mockResolvedValue(progress());
    sdkMock.pauseLibrarySetup.mockResolvedValue(progress({ paused: true }));
    render(SetupBar);

    await fireEvent.click((await screen.findAllByRole('button', { name: 'Pause' }))[0]);

    expect(sdkMock.pauseLibrarySetup).toHaveBeenCalledWith({ librarySetupPauseDto: { paused: true } });
    expect(await screen.findByText('Setup is paused')).toBeInTheDocument();

    sdkMock.pauseLibrarySetup.mockResolvedValue(progress({ paused: false }));
    await fireEvent.click(screen.getAllByRole('button', { name: 'Resume' })[0]);
    expect(sdkMock.pauseLibrarySetup).toHaveBeenLastCalledWith({ librarySetupPauseDto: { paused: false } });
    expect(await screen.findByText('Setting up your library')).toBeInTheDocument();
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

  it('marks the file check stopped, not in progress, when setup needs attention', async () => {
    sdkMock.getLibrarySetupProgress.mockResolvedValue(progress({ phase: Phase.NeedsAttention }));
    render(SetupBar);
    await fireEvent.click(await screen.findByRole('button', { name: /Details/ }));
    expect(screen.getByText('Stopped')).toBeInTheDocument();
    expect(screen.queryByText('In progress')).not.toBeInTheDocument();
  });

  it('keeps Retry and a general warning when attention follows completed stages', async () => {
    const value = progress({ phase: Phase.NeedsAttention });
    value.stages = value.stages.map((stage) => ({ ...stage, status: LibrarySetupStageStatus.Done, done: stage.total }));
    sdkMock.getLibrarySetupProgress.mockResolvedValue(value);
    render(SetupBar);
    expect(await screen.findByText('Setup needs attention')).toBeInTheDocument();
    expect(
      screen.getByText('Library setup stopped before it finished. Retry it, or see Library care for what happened.'),
    ).toBeInTheDocument();
    await fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(sdkMock.beginLibrarySetup).toHaveBeenCalled();
  });

  it('shows an identity warning without offering stage actions or progress', async () => {
    sdkMock.getLibrarySetupProgress.mockResolvedValue(progress({ phase: Phase.NeedsAttention, stages: [] }));
    render(SetupBar);
    expect(await screen.findByText('Setup needs attention')).toBeInTheDocument();
    expect(screen.getByText('Setup could not be verified. See Library care before continuing.')).toBeInTheDocument();
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Pause' })).not.toBeInTheDocument();
    expect(screen.queryByText('0%')).not.toBeInTheDocument();
    await fireEvent.click(screen.getByRole('button', { name: /Details/ }));
    expect(screen.getByRole('link', { name: 'Library care' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Setting up your library' })).toHaveTextContent(
      'Setup could not be verified. See Library care before continuing.',
    );
    expect(screen.queryByText('Library imported')).not.toBeInTheDocument();
    expect(screen.queryByText('0 items imported')).not.toBeInTheDocument();
  });

  it.each([false, true])('reports rejected setup actions and clears busy, retry=%s', async (retry) => {
    const failure = new Error('synthetic action refusal');
    sdkMock.getLibrarySetupProgress.mockResolvedValue(
      progress({ phase: retry ? Phase.NeedsAttention : Phase.Rescanning }),
    );
    const action = retry ? sdkMock.beginLibrarySetup : sdkMock.pauseLibrarySetup;
    action.mockRejectedValueOnce(failure);
    render(SetupBar);
    const button = await screen.findByRole('button', { name: retry ? 'Retry' : 'Pause' });
    await fireEvent.click(button);
    await vi.waitFor(() =>
      expect(handleError).toHaveBeenCalledWith(failure, 'Unable to update library setup. Try again.'),
    );
    expect(button).not.toBeDisabled();
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
