import {
  MediaHealthCategory,
  MediaHealthRootKind,
  MediaHealthSeverity,
  MediaHealthStatus,
  type MediaHealthItemDto,
  type MediaHealthListResponseDto,
  type MediaHealthSummaryResponseDto,
  type UserAdminResponseDto,
} from '@immich/sdk';
import { render, screen, waitFor, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { addMessages } from 'svelte-i18n';
import en from '../../../../../i18n/en.json';
import LibraryCareHealth from './LibraryCareHealth.svelte';

const state = vi.hoisted(() => ({
  goto: vi.fn(),
  sdk: {
    list: vi.fn(),
    getSummary: vi.fn(),
    dismiss: vi.fn(),
    reopen: vi.fn(),
    relinkMissing: vi.fn(),
    startMissingScan: vi.fn(),
    cancelMediaOperation: vi.fn(),
    restoreAssets: vi.fn(),
  },
}));
vi.mock('$app/navigation', () => ({ goto: state.goto }));
vi.mock('$app/state', () => ({ page: { url: new URL('http://localhost/user-settings?area=utilities') } }));
vi.mock('$lib/managers/auth-manager.svelte', () => ({
  authManager: { user: { id: 'admin', name: 'Taylor', isAdmin: true }, params: {} },
}));
vi.mock('@immich/sdk', async (original) => ({
  ...(await original<typeof import('@immich/sdk')>()),
  ...state.sdk,
}));

const users = [
  { id: 'admin', name: 'Taylor' },
  { id: 'jamie', name: 'Jamie' },
] as UserAdminResponseDto[];

const item = (overrides: Partial<MediaHealthItemDto> = {}): MediaHealthItemDto =>
  ({
    id: 'health-1',
    assetId: 'asset-1',
    category: MediaHealthCategory.Missing,
    status: MediaHealthStatus.Missing,
    severity: MediaHealthSeverity.Critical,
    originalPath: '/data/upload/admin/Lake.jpg',
    originalFileName: 'Lake.jpg',
    evidence: { reason: 'source_file_missing_or_unreadable' },
    resolution: {},
    checkedAt: '2026-09-23T00:00:00.000Z',
    dismissedAt: null,
    resolvedAt: null,
    asset: { ownerId: 'jamie', thumbhash: null, exifInfo: null },
    candidates: [],
    expectedChecksums: [{ algorithm: 'sha1', value: '0a0b0c' }],
    provenance: null,
    ...overrides,
  }) as unknown as MediaHealthItemDto;

const list = (items: MediaHealthItemDto[]): MediaHealthListResponseDto => ({
  buckets: [{ timeBucket: '2026-09-19', count: items.length, items }],
  total: items.length,
  run: null,
});

const summary = (overrides: Partial<MediaHealthSummaryResponseDto> = {}): MediaHealthSummaryResponseDto =>
  ({
    queues: {
      missing: 1,
      missingVerified: 0,
      damagedConfirmed: 0,
      damagedSuspected: 0,
      unsupportedRaw: 0,
      duplicates: 3,
      importReview: 2,
      enrichmentPending: 40,
    },
    care: { healthScan: true, checksumScan: true, integrityAudit: true, rawRecovery: true, duplicateReview: true },
    operation: null,
    runs: { missing: null, corrupt: null },
    recent: [],
    recoveryAvailable: false,
    ...overrides,
  }) as MediaHealthSummaryResponseDto;

const renderPage = (items = [item()], initialSummary = summary()) =>
  render(LibraryCareHealth, {
    category: MediaHealthCategory.Missing,
    initial: list(items),
    initialSummary,
    roots: [],
    users,
    initialOwner: 'all',
  });

describe('Library Care health tool (FL-69)', () => {
  beforeAll(() => addMessages('dev', en));
  beforeEach(() => {
    state.goto.mockReset();
    for (const fn of Object.values(state.sdk)) {
      fn.mockReset();
    }
    state.sdk.list.mockResolvedValue(list([item()]));
    state.sdk.getSummary.mockResolvedValue(summary());
    state.sdk.dismiss.mockResolvedValue(undefined);
    state.sdk.reopen.mockResolvedValue({ results: [{ id: 'health-1', success: true }] });
  });

  it('offers All accounts and then every account by name, the administrator included (UT-13)', () => {
    renderPage();
    const select = screen.getByRole('combobox', { name: 'Account' });
    expect(
      within(select)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['All accounts', 'Taylor', 'Jamie']);
    expect(select).toHaveValue('all');
  });

  it('opens the Job manager from View jobs (UT-14)', async () => {
    renderPage();
    await userEvent.click(screen.getAllByRole('button', { name: 'View jobs' })[0]);
    expect(state.goto).toHaveBeenCalledWith('/user-settings?area=processing&section=queues');
  });

  it('shows the other queues with their tools', async () => {
    renderPage();
    const queues = screen.getByRole('region', { name: 'Other queues' });
    expect(queues).toHaveTextContent('3 groups waiting for review');
    expect(queues).toHaveTextContent('2 items need review');
    expect(queues).toHaveTextContent('40 items waiting');
    await userEvent.click(within(queues).getAllByRole('button', { name: 'Review' })[0]);
    expect(state.goto).toHaveBeenCalledWith('/user-settings?area=utilities&section=duplicates');
  });

  it('says when duplicate grouping and RAW searches are off in Library care settings', () => {
    renderPage(
      [item()],
      summary({
        care: {
          healthScan: true,
          checksumScan: true,
          integrityAudit: true,
          rawRecovery: false,
          duplicateReview: false,
        },
      }),
    );
    expect(screen.getByText('Grouping is turned off in Library care settings')).toBeInTheDocument();
    expect(screen.getByText(/RAW originals are not searched for/)).toBeInTheDocument();
  });

  it('undoes a dismissal from the notice, then says so (UT-2)', async () => {
    renderPage();
    await userEvent.click(screen.getByRole('checkbox', { name: 'Select Lake.jpg' }));
    await userEvent.click(screen.getByRole('button', { name: 'Dismiss findings' }));
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Confirm 1 item' }));

    const notice = await screen.findByRole('status');
    expect(notice).toHaveTextContent('1 item updated.');
    await userEvent.click(within(notice).getByRole('button', { name: 'Undo' }));

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Last change undone.'));
    expect(state.sdk.reopen).toHaveBeenCalledWith({ mediaHealthBulkActionDto: { ids: ['health-1'] } });
    expect(within(screen.getByRole('status')).queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument();

    await userEvent.click(within(screen.getByRole('status')).getByRole('button', { name: 'Dismiss utility message' }));
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('offers no Undo for a relink, which changed the original', async () => {
    const found = item({
      status: MediaHealthStatus.Found,
      candidates: [
        {
          id: 'candidate-1',
          healthId: 'health-1',
          candidatePath: '/data/upload/admin/moved/Lake.jpg',
          status: MediaHealthStatus.Found,
          visualMatchScore: 1,
          evidence: {},
          resolution: { autoRelinkable: true },
          checkedAt: '2026-09-23T00:00:00.000Z',
          rootId: 'managed',
          rootKind: MediaHealthRootKind.Managed,
          checksumMatch: true,
          decodeValid: true,
          chosen: false,
          checksums: [],
        },
      ],
    });
    state.sdk.relinkMissing.mockResolvedValue({ results: [{ id: 'health-1', success: true }], operationId: null });
    renderPage([found]);
    await userEvent.click(screen.getByRole('checkbox', { name: 'Select Lake.jpg' }));
    await userEvent.click(screen.getByRole('button', { name: 'Relink verified matches' }));
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Confirm 1 item' }));

    const notice = await screen.findByRole('status');
    expect(notice).toHaveTextContent('1 item queued for relinking.');
    expect(within(notice).queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument();
  });

  it('undoes a queued scan by cancelling it', async () => {
    state.sdk.startMissingScan.mockResolvedValue({ runId: 'run-1', operationId: 'op-1' });
    state.sdk.cancelMediaOperation.mockResolvedValue({});
    renderPage();
    await userEvent.click(screen.getByRole('button', { name: 'Scan again' }));
    const notice = await screen.findByRole('status');
    await userEvent.click(within(notice).getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(state.sdk.cancelMediaOperation).toHaveBeenCalledWith({ id: 'op-1' }));
  });

  it('shows the recorded checksums, candidate checksums and who repaired an original', async () => {
    const relinked = item({
      status: MediaHealthStatus.Relinked,
      candidates: [
        {
          id: 'candidate-1',
          healthId: 'health-1',
          candidatePath: '/data/upload/admin/moved/Lake.jpg',
          status: MediaHealthStatus.Found,
          visualMatchScore: 1,
          evidence: {},
          resolution: {},
          checkedAt: '2026-09-23T00:00:00.000Z',
          rootId: 'managed',
          rootKind: MediaHealthRootKind.Managed,
          checksumMatch: true,
          decodeValid: true,
          chosen: true,
          checksums: [{ algorithm: 'sha1', value: '0a0b0c' }],
        },
      ],
      provenance: {
        action: 'relinked',
        userId: 'admin',
        rootId: 'managed',
        rootKind: MediaHealthRootKind.Managed,
        rootLabel: 'Library storage',
        at: '2026-09-23T10:00:00.000Z',
        previousPath: '/data/upload/admin/Lake-old.jpg',
        sourcePath: null,
      },
    } as unknown as Partial<MediaHealthItemDto>);
    renderPage([relinked]);
    await userEvent.click(screen.getByRole('button', { name: 'Inspect' }));

    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent('Recorded SHA1');
    expect(within(dialog).getAllByText('0a0b0c')).toHaveLength(2);
    expect(dialog).toHaveTextContent('Relinked');
    expect(dialog).toHaveTextContent('Taylor');
    expect(dialog).toHaveTextContent('/data/upload/admin/Lake-old.jpg');
  });
});
