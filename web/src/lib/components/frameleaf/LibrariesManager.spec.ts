import { LibraryScanPhase, MediaOperationStatus, UserStatus, type LibraryScanResponseDto } from '@immich/sdk';
import { fireEvent, render, screen, within } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import LibrariesManager from '$lib/components/frameleaf/LibrariesManager.svelte';
import { buildLibraryRows, LIBRARY_SCAN_POLL_MS } from '$lib/frameleaf/libraries';
import en from '../../../../../i18n/en.json';

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

const setup = (scan: LibraryScanResponseDto | null, props: { selectedKey?: string | null } = {}) => {
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
    selectedKey: props.selectedKey ?? 'library:lib-1',
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

    const table = screen.getByRole('region', { name: en.frameleaf_libraries_table_label });
    expect(within(table).getByText(en.frameleaf_libraries_status_failed)).toBeInTheDocument();
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

    expect(screen.getByRole('progressbar', { name: en.frameleaf_libraries_scan_progress })).toBeInTheDocument();
    await vi.advanceTimersByTimeAsync(LIBRARY_SCAN_POLL_MS * 2 + 10);
    expect(refresh).toHaveBeenCalledTimes(2);

    sdkMock.cancelLibraryScan.mockResolvedValue(undefined as never);
    await fireEvent.click(screen.getByRole('button', { name: en.frameleaf_libraries_scan_cancel }));
    expect(sdkMock.cancelLibraryScan).toHaveBeenCalledWith({ id: 'lib-1' });
  });

  it('does not poll when nothing is scanning', async () => {
    vi.useFakeTimers();
    const { refresh } = setup(null);
    await vi.advanceTimersByTimeAsync(LIBRARY_SCAN_POLL_MS * 3);
    expect(refresh).not.toHaveBeenCalled();
  });

  it('starts every scannable library from the header', async () => {
    sdkMock.scanLibrary.mockResolvedValue(undefined as never);
    setup(null, { selectedKey: null });

    await fireEvent.click(screen.getByRole('button', { name: 'Scan 1 library' }));

    expect(sdkMock.scanLibrary).toHaveBeenCalledWith({ id: 'lib-1' });
  });

  it('tells the administrator when the server refuses a scan', async () => {
    sdkMock.scanLibrary.mockRejectedValue(new Error('refused'));
    setup(null);

    await fireEvent.click(screen.getByRole('button', { name: en.frameleaf_libraries_scan_start }));

    expect(await screen.findByRole('alert')).toHaveTextContent(en.frameleaf_libraries_error_scan);
  });

  it('opens the add form from the header, over the list', async () => {
    setup(null, { selectedKey: null });

    await fireEvent.click(screen.getByRole('button', { name: en.frameleaf_libraries_add }));

    expect(screen.getByRole('heading', { name: en.frameleaf_libraries_form_create_title })).toBeInTheDocument();
  });
});
