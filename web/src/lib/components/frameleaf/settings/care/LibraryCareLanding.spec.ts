import {
  createJob,
  getAssetStatistics,
  getIntegrityCheckRuns,
  getIntegrityOverview,
  getServerStatistics,
  getSummary,
  IntegrityReport,
  ManualJobName,
  type MediaHealthSummaryResponseDto,
} from '@frameleaf/sdk';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import LibraryCareLanding from '$lib/components/frameleaf/settings/care/LibraryCareLanding.svelte';
import en from '../../../../../../../i18n/en.json';

/**
 * Library care opens on the answer (FL-366): healthy, how many files need attention, or not checked
 * yet. A problem both scanners report is counted once, and a member sees only their own library.
 */
const user = vi.hoisted(() => ({ isAdmin: true }));

vi.mock('@frameleaf/sdk', async (original) => ({
  ...(await original<object>()),
  createJob: vi.fn(),
  getAssetStatistics: vi.fn(),
  getIntegrityCheckRuns: vi.fn(),
  getIntegrityOverview: vi.fn(),
  getServerStatistics: vi.fn(),
  getSummary: vi.fn(),
}));
vi.mock('$app/navigation', () => ({ goto: vi.fn() }));
vi.mock('$lib/managers/auth-manager.svelte', () => ({ authManager: { user } }));

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

describe('Library care landing (FL-366)', () => {
  beforeAll(() => addMessages('dev', en));
  beforeEach(() => {
    vi.clearAllMocks();
    user.isAdmin = true;
    vi.mocked(getServerStatistics).mockResolvedValue({ photos: 900, videos: 100 } as never);
    vi.mocked(getAssetStatistics).mockResolvedValue({ images: 40, videos: 2, total: 42 });
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
});
