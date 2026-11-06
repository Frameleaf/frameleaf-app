import { LibraryScanPhase, MediaOperationStatus, UserStatus, type LibraryScanResponseDto } from '@frameleaf/sdk';
import { fireEvent, render, screen } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import LibrariesManager from '$lib/components/frameleaf/LibrariesManager.svelte';
import { buildLibraryRows, LIBRARY_SCAN_POLL_MS } from '$lib/frameleaf/libraries';
import en from '../../../../../i18n/en.json';

const navigation = vi.hoisted(() => ({ goto: vi.fn() }));
vi.mock('$app/navigation', () => navigation);

const owner = {
  id: 'owner-1',
  name: 'Taylor',
  status: UserStatus.Active,
  deletedAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
} as never;

const scanOf = (overrides: Partial<LibraryScanResponseDto>): LibraryScanResponseDto => ({
  operationId: 'op-1',
  status: MediaOperationStatus.Rendering,
  phase: LibraryScanPhase.Crawl,
  progress: 10,
  processedUnits: 5,
  totalUnits: 50,
  added: 1,
  checked: 0,
  updated: 0,
  offlined: 0,
  onlined: 0,
  pauseRequested: false,
  retrying: false,
  stopReason: null,
  errorCode: null,
  error: null,
  createdAt: '2026-09-23T10:00:00.000Z',
  startedAt: null,
  finishedAt: null,
  ...overrides,
});

const libraryOf = (scan: LibraryScanResponseDto | null) => ({
  readOnly: false,
  id: 'lib-1',
  name: 'Family photo archive',
  ownerId: 'owner-1',
  importPaths: ['/mnt/photos'],
  exclusionPatterns: [],
  assetCount: 0,
  createdAt: '2026-02-01T00:00:00.000Z',
  updatedAt: '2026-02-01T00:00:00.000Z',
  refreshedAt: null,
  deletedAt: null,
  scan,
});

const setup = (
  scan: LibraryScanResponseDto | null,
  props: { selectedKey?: string | null; createOnOpen?: boolean } = {},
) => {
  const library = libraryOf(scan);
  const rows = buildLibraryRows({
    libraries: [library],
    users: [owner],
    uploads: [],
    statistics: { 'lib-1': { photos: 3, videos: 1, total: 4, usage: 100, usagePhysical: 100 } },
    uploadsName: (name) => `${name}’s uploads`,
  });
  const refresh = vi.fn().mockResolvedValue(undefined);
  const onSelect = vi.fn();
  const result = render(LibrariesManager, {
    rows,
    owners: [owner],
    libraries: [library],
    selectedKey: props.selectedKey === undefined ? 'library:lib-1' : props.selectedKey,
    createOnOpen: props.createOnOpen ?? false,
    snapshotAt: new Date('2026-09-23T10:00:00Z'),
    onSelect,
    onAnalytics: vi.fn(),
    refresh,
  });
  return { ...result, refresh, onSelect, rows, library };
};

beforeEach(() => {
  vi.clearAllMocks();
  addMessages('dev', en);
  // the library page lists its recent changes
  sdkMock.getUserHistoryAdmin.mockResolvedValue({ events: [] } as never);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('LibrariesManager (FL-78)', () => {
  it('shows a failed scan, and the same failure again after a reload', async () => {
    const failed = scanOf({
      status: MediaOperationStatus.Failed,
      errorCode: 'library_source_unavailable',
      error: '/mnt/photos: Path does not exist (ENOENT)',
    });
    const first = setup(failed);

    // Manage › opens the library in place of the lists, under its own name
    expect(screen.getByRole('heading', { level: 1, name: 'Family photo archive' })).toBeInTheDocument();
    const message = screen.getByTestId('library-scan-message');
    expect(message.textContent).toContain('no items were marked missing');
    expect(message.textContent).toContain('/mnt/photos: Path does not exist (ENOENT)');
    // a failed scan can be started again, and nothing polls for it
    expect(screen.getByRole('button', { name: en.frameleaf_libraries_scan_start })).not.toBeDisabled();

    // a reload reads the same durable scan back from the server
    first.unmount();
    setup(failed);
    expect(screen.getByTestId('library-scan-message').textContent).toContain('no items were marked missing');
  });

  it('reads the list again while a scan moves, and cancels it on request', async () => {
    vi.useFakeTimers();
    const { refresh } = setup(scanOf({}));

    expect(screen.getByRole('meter', { name: en.frameleaf_libraries_scan_progress })).toBeInTheDocument();
    await vi.advanceTimersByTimeAsync(LIBRARY_SCAN_POLL_MS * 2 + 10);
    expect(refresh).toHaveBeenCalledTimes(2);

    sdkMock.cancelLibraryScan.mockResolvedValue(undefined as never);
    await fireEvent.click(screen.getByRole('button', { name: en.frameleaf_libraries_stop }));
    expect(sdkMock.cancelLibraryScan).toHaveBeenCalledWith({ id: 'lib-1' });
  });

  it('reads the list once more when the last scan ends, so its sizes are current', async () => {
    const { refresh, rerender, rows, library } = setup(scanOf({}));
    expect(refresh).not.toHaveBeenCalled();

    const done = scanOf({ status: MediaOperationStatus.Completed, finishedAt: new Date().toISOString() });
    await rerender({
      rows: rows.map((row) => ({ ...row, scan: done })),
      libraries: [{ ...library, scan: done }],
    });

    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('does not poll when nothing is scanning', async () => {
    vi.useFakeTimers();
    const { refresh } = setup(null);
    await vi.advanceTimersByTimeAsync(LIBRARY_SCAN_POLL_MS * 3);
    expect(refresh).not.toHaveBeenCalled();
  });

  it('opens a library as a page of its own: its state, the folder, whose library, what it skips, removing it', async () => {
    setup(scanOf({ status: MediaOperationStatus.Completed, finishedAt: '2026-09-23T10:05:00.000Z' }));

    expect(screen.getByRole('heading', { level: 1, name: 'Family photo archive' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: en.frameleaf_library_page_title_ok })).toBeInTheDocument();
    for (const title of [
      en.frameleaf_library_page_holds,
      en.frameleaf_library_page_folder,
      en.frameleaf_library_page_whose,
      en.frameleaf_library_page_skip,
      en.frameleaf_library_page_history,
      en.frameleaf_library_page_remove_title,
    ]) {
      expect(screen.getByRole('heading', { name: title })).toBeInTheDocument();
    }
    // the folder in words, with its whole path under it; no tabs and no monospace path boxes
    expect(screen.getByText('mnt › photos')).toBeInTheDocument();
    expect(screen.getByText('/mnt/photos')).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: en.frameleaf_libraries_tabs_label })).toBeNull();
    expect(await screen.findByText(en.frameleaf_libraries_activity_empty)).toBeInTheDocument();

    // "Change…" opens the edit form, "Remove from Frameleaf…" the removal review
    await fireEvent.click(screen.getAllByRole('button', { name: en.frameleaf_library_page_change })[0]);
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
  });

  it("lists the folders and each person's uploads as the prototype does, with Manage ›", async () => {
    const { onSelect } = setup(
      scanOf({ status: MediaOperationStatus.Failed, finishedAt: '2026-09-23T10:05:00.000Z' }),
      { selectedKey: null },
    );

    expect(screen.getByRole('heading', { name: en.frameleaf_libraries_folders_title })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'The last check skipped Family photo archive' })).toBeInTheDocument();
    expect(screen.getByText('Skipped')).toBeInTheDocument();
    expect(screen.getByText('mnt › photos · in Taylor’s library')).toBeInTheDocument();
    await fireEvent.click(screen.getByRole('button', { name: 'Manage Family photo archive' }));
    expect(onSelect).toHaveBeenCalledWith('library:lib-1');
  });

  it("says when someone's newest upload was added, and opens their uploads as a page", async () => {
    const rows = buildLibraryRows({
      libraries: [],
      users: [owner],
      uploads: [
        {
          ownerId: 'owner-1',
          photos: 2,
          videos: 1,
          total: 3,
          usage: 300,
          usagePhysical: 300,
          lastAddedAt: new Date().toISOString(),
        },
      ],
      statistics: {},
      uploadsName: (name) => `${name}’s uploads`,
    });
    const props = {
      rows,
      owners: [owner],
      libraries: [],
      snapshotAt: new Date(),
      onSelect: vi.fn(),
      onAnalytics: vi.fn(),
      refresh: vi.fn().mockResolvedValue(undefined),
    };
    const list = render(LibrariesManager, { ...props, selectedKey: null });
    expect(screen.getByText(/^Last photo added /)).toBeInTheDocument();
    list.unmount();

    // recent changes are the account's own: a removed library's entries (libraryId gone) stay out
    sdkMock.getUserHistoryAdmin.mockResolvedValue({
      events: [
        {
          id: 'e1',
          action: 'library-deleted',
          subject: 'Old NAS folder',
          detail: '12',
          libraryId: null,
          createdAt: '2026-11-05T07:00:00.000Z',
        },
        {
          id: 'e2',
          action: 'quota-changed',
          subject: 'Taylor',
          detail: null,
          libraryId: null,
          createdAt: '2026-11-04T07:00:00.000Z',
        },
      ],
    } as never);
    render(LibrariesManager, { ...props, selectedKey: 'uploads:owner-1' });
    expect(await screen.findByText('Taylor', { selector: '.kit-history-row *' })).toBeInTheDocument();
    expect(screen.queryByText('Old NAS folder')).toBeNull();
    expect(screen.getByRole('heading', { name: '3 photos and videos' })).toBeInTheDocument();
    expect(
      screen.getByText(/Added by Taylor from a phone, the web or an import\. Last photo added /),
    ).toBeInTheDocument();
    // uploads belong to their account: nothing to remove here
    expect(screen.queryByRole('heading', { name: en.frameleaf_library_page_remove_title })).toBeNull();
  });

  it('starts every scannable library from the answer at the top', async () => {
    sdkMock.scanLibrary.mockResolvedValue(undefined as never);
    setup(null, { selectedKey: null });

    await fireEvent.click(screen.getByRole('button', { name: en.frameleaf_checks_now }));

    expect(sdkMock.scanLibrary).toHaveBeenCalledWith({ id: 'lib-1' });
  });

  it('tells the administrator when the server refuses a scan', async () => {
    sdkMock.scanLibrary.mockRejectedValue(new Error('refused'));
    setup(null);

    await fireEvent.click(screen.getByRole('button', { name: en.frameleaf_libraries_scan_start }));

    expect(await screen.findByRole('alert')).toHaveTextContent(en.frameleaf_libraries_error_scan);
  });

  it('keeps one live region in the page across the list, a library and Add a folder (FL-1248)', async () => {
    const { container, rerender } = setup(null, { selectedKey: null });
    const region = container.querySelector('.kit-said-region');
    expect(region).toHaveAttribute('role', 'status');
    expect(region).toBeEmptyDOMElement();

    await rerender({ selectedKey: 'library:lib-1' });
    expect(container.querySelectorAll('.kit-said-region')).toHaveLength(1);
    expect(container.querySelector('.kit-said-region')).toBe(region);

    await rerender({ createOnOpen: true });
    expect(container.querySelectorAll('.kit-said-region')).toHaveLength(1);
    expect(container.querySelector('.kit-said-region')).toBe(region);
  });

  it('opens Add a folder of photos as a page of its own, in four steps (FL-539)', async () => {
    const first = setup(null, { selectedKey: null });
    await fireEvent.click(screen.getByRole('button', { name: en.frameleaf_libraries_add }));
    expect(navigation.goto).toHaveBeenCalledWith('/user-settings?area=libraries&new=1');
    first.unmount();

    setup(null, { selectedKey: null, createOnOpen: true });

    expect(screen.getByRole('heading', { name: en.frameleaf_addfolder_title, level: 1 })).toBeInTheDocument();
    for (const step of [en.frameleaf_addfolder_step1, en.frameleaf_addfolder_step2, en.frameleaf_addfolder_step3]) {
      expect(screen.getByRole('heading', { name: step })).toBeInTheDocument();
    }
    expect(screen.getByRole('switch', { name: en.frameleaf_addfolder_first })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('button', { name: en.frameleaf_addfolder_add })).toBeDisabled();
  });
});
