import {
  createJob,
  getAnalyticsReport,
  getAssetStatistics,
  getIdenticalFilesStatus,
  getQueue,
  getIntegrityCheckRuns,
  getIntegrityOverview,
  getServerStatistics,
  getSummary,
  getUtilitiesSummary,
  IntegrityReport,
  ManualJobName,
  QueueName,
  updateQueue,
  type MediaHealthSummaryResponseDto,
} from '@frameleaf/sdk';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import LibraryCareLanding from '$lib/components/frameleaf/settings/care/LibraryCareLanding.svelte';
import { unusedFilesAccess } from '$lib/frameleaf/unused-files.svelte';
import en from '../../../../../../../i18n/en.json';

/**
 * Library care opens on the answer (FL-366): healthy, how many files need attention, or not checked
 * yet. A problem both scanners report is counted once, and a member sees only their own library.
 */
const user = vi.hoisted(() => ({ id: 'owner', isAdmin: true }));

vi.mock('@frameleaf/sdk', async (original) => ({
  ...(await original<object>()),
  createJob: vi.fn(),
  getAssetStatistics: vi.fn(),
  getIntegrityCheckRuns: vi.fn(),
  getIntegrityOverview: vi.fn(),
  getServerStatistics: vi.fn(),
  getSummary: vi.fn(),
  getAnalyticsReport: vi.fn(),
  getIdenticalFilesStatus: vi.fn(),
  getQueue: vi.fn(),
  updateQueue: vi.fn(),
  getUtilitiesSummary: vi.fn(),
}));
vi.mock('$app/navigation', () => ({ goto: vi.fn() }));
vi.mock('$lib/managers/auth-manager.svelte', () => ({ authManager: { user, authenticated: true } }));

const summary = (queues: Partial<MediaHealthSummaryResponseDto['queues']> = {}, finishedAt: string | null = null) =>
  ({
    queues: {
      missing: 0,
      missingVerified: 0,
      damagedConfirmed: 0,
      damagedSuspected: 0,
      unsupportedRaw: 0,
      duplicates: 0,
      importReview: null,
      enrichmentPending: 0,
      ...queues,
    },
    care: {},
    operation: null,
    runs: { missing: finishedAt ? { finishedAt } : null, corrupt: null },
    recent: [],
    recoveryAvailable: false,
  }) as unknown as MediaHealthSummaryResponseDto;

/** FL-520: the server's one source of findings, each file counted once. */
const reports = (missing = 0, damaged = 0, stray = 0) => ({
  missing,
  damaged,
  stray,
  rawToMatch: 0,
  unreachable: [],
  running: [],
  history: [],
});
const runs = (at: string | null) => ({
  [IntegrityReport.MissingFile]: at,
  [IntegrityReport.ChecksumMismatch]: at,
  [IntegrityReport.UntrackedFile]: at,
});
const hero = () => within(screen.getByRole('region', { name: en.frameleaf_carehome_hero_label }));

/** FL-416: the identical-files check an Immich import started. */
const importCheck = (overrides: Record<string, unknown> = {}) =>
  ({
    status: 'running',
    stage: 'scan',
    trigger: 'immich-import',
    startedAt: new Date(Date.now() - 20 * 60_000).toISOString(),
    finishedAt: null,
    totalOriginals: 48_210,
    counts: {
      scanned: 35_278,
      upgraded: 0,
      registered: 0,
      linked: 57,
      photosMerged: 100,
      filesMovedToUnused: 120,
      bytesMovedToUnused: 2_300_000_000,
      orphansFound: 0,
      orphanDuplicates: 0,
      photosRecovered: 0,
      damaged: 0,
      problems: 0,
    },
    recovered: [],
    problems: [],
    ...overrides,
  }) as never;

describe('Library care landing (FL-366)', () => {
  beforeAll(() => addMessages('dev', en));
  beforeEach(() => {
    vi.clearAllMocks();
    user.isAdmin = true;
    vi.mocked(getServerStatistics).mockResolvedValue({ photos: 900, videos: 100 } as never);
    vi.mocked(getAssetStatistics).mockResolvedValue({ images: 40, videos: 2, total: 42 });
    vi.mocked(getIdenticalFilesStatus).mockResolvedValue(importCheck({ trigger: 'manual', status: 'completed' }));
    vi.mocked(getQueue).mockResolvedValue({ isPaused: false } as never);
    vi.mocked(getAnalyticsReport).mockResolvedValue({ summary: { savedBytes: 3_200_000_000 } } as never);
    vi.mocked(getUtilitiesSummary).mockResolvedValue({ unusedFiles: null, unusedBytes: null } as never);
    unusedFilesAccess.reset();
  });

  it('says the library is healthy, with how many files were checked', async () => {
    vi.mocked(getSummary).mockResolvedValue(summary());
    vi.mocked(getIntegrityOverview).mockResolvedValue(reports() as never);
    vi.mocked(getIntegrityCheckRuns).mockResolvedValue(runs(new Date().toISOString()) as never);

    render(LibraryCareLanding);

    expect(await hero().findByText(en.frameleaf_carehome_hero_ok)).toBeInTheDocument();
    expect(hero().getByText(/All 1,000 photos and videos were on the drive/)).toBeInTheDocument();
    expect(getSummary).toHaveBeenCalledWith({ allAccounts: true });
  });

  it('counts a missing file both scanners found once, and lists what needs attention', async () => {
    vi.mocked(getSummary).mockResolvedValue(summary({ missing: 2, damagedConfirmed: 1 }));
    vi.mocked(getIntegrityOverview).mockResolvedValue(reports(2, 1, 1) as never);
    vi.mocked(getIntegrityCheckRuns).mockResolvedValue(runs(new Date().toISOString()) as never);

    render(LibraryCareLanding);

    expect(await hero().findByText('4 files need attention')).toBeInTheDocument();
    expect(screen.getByText('2 missing files')).toBeInTheDocument();
    expect(screen.getByText('1 damaged file')).toBeInTheDocument();
    expect(screen.getByText('1 stray file')).toBeInTheDocument();
  });

  it('says a library that was never checked is not checked yet, and can start a check', async () => {
    vi.mocked(getSummary).mockResolvedValue(summary());
    vi.mocked(getIntegrityOverview).mockResolvedValue(reports() as never);
    vi.mocked(getIntegrityCheckRuns).mockResolvedValue(runs(null) as never);
    vi.mocked(createJob).mockResolvedValue(undefined as never);

    render(LibraryCareLanding);

    // The answer and the files fact both say it.
    expect(await hero().findAllByText(en.frameleaf_carehome_hero_new)).toHaveLength(2);
    await fireEvent.click(hero().getByRole('button', { name: en.frameleaf_carehome_check_now }));
    await waitFor(() => expect(createJob).toHaveBeenCalledTimes(3));
    expect(createJob).toHaveBeenCalledWith({ jobCreateDto: { name: ManualJobName.IntegrityMissingFiles } });
    expect(await screen.findByText(en.frameleaf_carehome_check_started)).toBeInTheDocument();
  });

  it("shows a member their own library, without the administrator's pages", async () => {
    user.isAdmin = false;
    vi.mocked(getSummary).mockResolvedValue(summary({}, new Date().toISOString()));

    render(LibraryCareLanding);

    expect(await hero().findByText(/All 42 of your photos and videos/)).toBeInTheDocument();
    expect(getSummary).toHaveBeenCalledWith({});
    expect(getIntegrityOverview).not.toHaveBeenCalled();
    expect(screen.queryByText(en.frameleaf_carehome_row_checks)).not.toBeInTheDocument();
    expect(screen.getByText(en.frameleaf_carehome_row_fix)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: en.frameleaf_carehome_check_now })).not.toBeInTheDocument();
  });

  it('shows the check after an Immich import, with what it found, and pauses it (FL-416)', async () => {
    vi.mocked(getSummary).mockResolvedValue(summary());
    vi.mocked(getIntegrityOverview).mockResolvedValue(reports() as never);
    vi.mocked(getIntegrityCheckRuns).mockResolvedValue(runs(new Date().toISOString()) as never);
    vi.mocked(getIdenticalFilesStatus).mockResolvedValue(importCheck());
    vi.mocked(updateQueue).mockResolvedValue({ isPaused: true } as never);

    render(LibraryCareLanding);

    const card = within(await screen.findByRole('region', { name: en.frameleaf_import_check_title }));
    expect(card.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '62');
    expect(card.getByText('35,278 of 48,210')).toBeInTheDocument();
    expect(card.getByText('157')).toBeInTheDocument();
    expect(card.getByText('2.3 GB')).toBeInTheDocument();
    expect(card.getByText(en.frameleaf_import_check_recovered_later)).toBeInTheDocument();
    expect(card.getByText('73%')).toBeInTheDocument();

    await fireEvent.click(card.getByRole('button', { name: en.frameleaf_import_check_pause }));
    expect(updateQueue).toHaveBeenCalledWith({
      name: QueueName.StorageTemplateMigration,
      queueUpdateDto: { isPaused: true },
    });
    expect(await card.findByRole('button', { name: en.frameleaf_import_check_resume })).toBeInTheDocument();
    expect(await screen.findByText(en.frameleaf_import_check_paused_said)).toBeInTheDocument();
  });

  it('leaves the card out when the latest check was not an import (FL-416)', async () => {
    vi.mocked(getSummary).mockResolvedValue(summary());
    vi.mocked(getIntegrityOverview).mockResolvedValue(reports() as never);
    vi.mocked(getIntegrityCheckRuns).mockResolvedValue(runs(new Date().toISOString()) as never);

    render(LibraryCareLanding);

    expect(await hero().findByText(en.frameleaf_carehome_hero_ok)).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: en.frameleaf_import_check_title })).toBeNull();
    expect(await screen.findByText('Identical files stored once · 3.2 GB saved')).toBeInTheDocument();
  });

  it('lists Unused files among the tools for the server owner only (FL-416)', async () => {
    vi.mocked(getSummary).mockResolvedValue(summary());
    vi.mocked(getIntegrityOverview).mockResolvedValue(reports() as never);
    vi.mocked(getIntegrityCheckRuns).mockResolvedValue(runs(new Date().toISOString()) as never);

    const { unmount } = render(LibraryCareLanding);
    expect(await hero().findByText(en.frameleaf_carehome_hero_ok)).toBeInTheDocument();
    await waitFor(() => expect(getUtilitiesSummary).toHaveBeenCalled());
    expect(screen.queryByText(en.frameleaf_unused_title)).toBeNull();
    unmount();

    unusedFilesAccess.reset();
    vi.mocked(getUtilitiesSummary).mockResolvedValue({ unusedFiles: 277, unusedBytes: 4_500_000_000 } as never);
    render(LibraryCareLanding);
    expect(await screen.findByText(en.frameleaf_unused_title)).toBeInTheDocument();
    expect(screen.getByText(en.frameleaf_unused_title).closest('a')).toHaveAttribute(
      'href',
      expect.stringContaining('section=unused-files'),
    );
  });
});
