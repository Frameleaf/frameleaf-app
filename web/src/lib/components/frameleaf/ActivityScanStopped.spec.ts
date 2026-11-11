import { MediaOperationKind, MediaOperationStatus, type MediaOperationDto } from '@frameleaf/sdk';
import { fireEvent, render, screen } from '@testing-library/svelte';
import { init, register, waitLocale } from 'svelte-i18n';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import ActivityScanStopped from '$lib/components/frameleaf/ActivityScanStopped.svelte';
import { fromMediaOperation } from '$lib/frameleaf/activity';

const RAW = 'The library queue attempt was interrupted';
const scan = (overrides: Partial<MediaOperationDto> = {}) =>
  fromMediaOperation({
    id: 'scan-1',
    kind: MediaOperationKind.LibraryScan,
    status: MediaOperationStatus.Failed,
    destination: 'local',
    label: 'Family archive',
    settings: {},
    progress: 43,
    processedUnits: '7103',
    totalUnits: '16317',
    autoRetries: 1,
    error: RAW,
    errorCode: 'library_scan_interrupted',
    createdAt: '2026-11-10T09:00:00.000Z',
    startedAt: '2026-11-10T09:00:05.000Z',
    finishedAt: '2026-11-10T09:20:00.000Z',
    ...overrides,
  } as MediaOperationDto);

/** FL-1409 (M7; prototype `ScanInterrupted`). */
describe('a library scan that stopped early, on Activity (FL-1409)', () => {
  beforeAll(async () => {
    await init({ fallbackLocale: 'en-US' });
    register('en-US', () => import('$i18n/en.json'));
    await waitLocale('en-US');
  });
  beforeEach(() => {
    vi.resetAllMocks();
    sdkMock.getAllLibraries.mockResolvedValue([
      { id: 'library-1', name: 'Family archive', assetCount: 7103, scan: { operationId: 'scan-1' } },
      { id: 'library-2', name: 'Scans', assetCount: 12, scan: { operationId: 'scan-9' } },
    ] as never);
  });

  it('says what happened, that nothing was lost and how far it got, and offers Scan again', async () => {
    const onScanAgain = vi.fn();
    const onDismiss = vi.fn();
    render(ActivityScanStopped, { item: scan(), onScanAgain, onDismiss });

    expect(screen.getByRole('heading', { name: 'The scan of “Family archive” was interrupted' })).toBeInTheDocument();
    expect(
      await screen.findByText(
        'The server restarted while it was reading the folder. Nothing was lost: 7,103 files are in your library, and the rest are still on the drive.',
      ),
    ).toBeInTheDocument();

    await fireEvent.click(screen.getByRole('button', { name: 'Scan again' }));
    expect(onScanAgain).toHaveBeenCalledWith('library-1');
    await fireEvent.click(screen.getByRole('button', { name: 'Not now' }));
    expect(onDismiss).toHaveBeenCalled();
  });

  it('keeps what the server reported under Technical details, never in the main line', () => {
    render(ActivityScanStopped, { item: scan(), onScanAgain: vi.fn(), onDismiss: vi.fn() });

    const raw = screen.getByText(RAW);
    expect(raw.closest('details')).not.toBeNull();
    expect(raw.closest('details')).not.toHaveAttribute('open');
    expect(screen.getByRole('heading')).not.toHaveTextContent(RAW);
    expect(screen.getByText('Technical details')).toBeInTheDocument();
  });

  it('still says nothing was lost when the library can’t be read, and offers no Scan again', async () => {
    sdkMock.getAllLibraries.mockRejectedValue(new Error('forbidden'));
    render(ActivityScanStopped, { item: scan(), onScanAgain: vi.fn(), onDismiss: vi.fn() });

    expect(await screen.findByText(/Nothing was lost: the files it had read are in your library/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Scan again' })).not.toBeInTheDocument();
  });

  it('says Waiting for a drive, names the library and offers no Scan again when the folder is offline', async () => {
    const item = scan({ errorCode: 'library_source_unavailable', error: '/mnt/archive: Path does not exist (ENOENT)' });
    render(ActivityScanStopped, { item, onScanAgain: vi.fn(), onDismiss: vi.fn() });
    await vi.waitFor(() => expect(sdkMock.getAllLibraries).toHaveBeenCalled());

    expect(screen.getByRole('heading', { name: 'Waiting for a drive' })).toBeInTheDocument();
    expect(screen.getByText(/can’t reach the folder of “Family archive”/)).toBeInTheDocument();
    expect(screen.queryByText(/interrupted/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Scan again' })).not.toBeInTheDocument();
    expect(screen.getByText('/mnt/archive: Path does not exist (ENOENT)').closest('details')).not.toBeNull();
  });
});
