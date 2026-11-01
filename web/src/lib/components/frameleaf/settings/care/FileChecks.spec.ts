import {
  IntegrityCheckOutcome,
  IntegrityFindingKind,
  IntegrityReport,
  IntegrityUnreachableFolderKind,
  type AdminConfigDto,
  type IntegrityOverviewResponseDto,
} from '@frameleaf/sdk';
import { fireEvent, render, screen, within } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { goto } from '$app/navigation';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { SystemConfigDraftStore } from '$lib/frameleaf/system-config-draft.svelte';
import en from '../../../../../../../i18n/en.json';
import FileChecks from './FileChecks.svelte';

const draft = vi.hoisted(() => ({ store: undefined as unknown }));
const confirmFrameleaf = vi.hoisted(() => vi.fn());

vi.mock('$app/state', () => ({ page: { url: new URL('http://localhost/user-settings?area=care') } }));
vi.mock('$app/navigation', () => ({ goto: vi.fn() }));
vi.mock('$lib/managers/feature-flags-manager.svelte', () => ({
  featureFlagsManager: { value: { configFile: false } },
}));
vi.mock('$lib/frameleaf/confirm', () => ({ confirmFrameleaf: (...args: unknown[]) => confirmFrameleaf(...args) }));
vi.mock('$lib/frameleaf/system-config-draft.svelte', async (original) => ({
  ...(await original<object>()),
  requireSystemConfigDraft: () => draft.store,
  getSystemConfigDraft: () => draft.store,
}));

const config = () =>
  ({
    integrityChecks: {
      missingFiles: { enabled: true, cronExpression: '0 03 * * *' },
      untrackedFiles: { enabled: true, cronExpression: '0 03 * * *' },
      checksumFiles: { enabled: true, cronExpression: '0 03 * * *', timeLimit: 3_600_000, percentageLimit: 1 },
    },
    libraryCare: {
      healthScan: true,
      healthScanCronExpression: '0 02 * * *',
      checksumScan: true,
      integrityAudit: true,
      livePhotoRepair: true,
      rawRecovery: true,
      duplicateReview: true,
      incrementalEnrichment: true,
      manualMetadata: true,
    },
  }) as unknown as AdminConfigDto;

const newStore = () => {
  const store = new SystemConfigDraftStore(
    { config: config(), revision: 'r1' },
    { defaults: config(), load: vi.fn(), save: vi.fn() },
  ) as SystemConfigDraftStore & { draft: AdminConfigDto };
  draft.store = store;
  return store;
};

const idle = {
  hasUnfinishedWork: false,
  statistics: { active: 0, waiting: 0, delayed: 0, paused: 0, completed: 0, failed: 0 },
} as never;

const counts = (missing = 0, damaged = 0, stray = 0) => ({
  missing_file: missing,
  checksum_mismatch: damaged,
  untracked_file: stray,
});
const ran = '2026-10-14T09:40:00.000Z';
const paths = (type: IntegrityReport, list: string[]) =>
  sdkMock.getIntegrityReport.mockImplementation(({ $type }) =>
    Promise.resolve({
      items: $type === type ? list.map((path, index) => ({ id: `f${index}`, path, type, originalFileName: null })) : [],
    }),
  );

const overview = (value: Partial<IntegrityOverviewResponseDto> = {}): IntegrityOverviewResponseDto => ({
  missing: 0,
  damaged: 0,
  stray: 0,
  rawToMatch: 0,
  unreachable: [],
  running: [],
  history: [],
  ...value,
});

const hero = () => within(screen.getByRole('region', { name: 'File check status' }));

describe('File checks (FL-366)', () => {
  beforeAll(() => {
    addMessages('dev', en);
  });

  beforeEach(() => {
    vi.clearAllMocks();
    sdkMock.getIntegrityReportSummary.mockResolvedValue(counts());
    sdkMock.getIntegrityCheckRuns.mockResolvedValue({ missing_file: ran, checksum_mismatch: ran, untracked_file: ran });
    sdkMock.getIntegrityReport.mockResolvedValue({ items: [] });
    sdkMock.getSummary.mockResolvedValue({ recoveryAvailable: false } as never);
    sdkMock.getQueue.mockResolvedValue(idle);
    sdkMock.getIntegrityOverview.mockResolvedValue(overview());
    confirmFrameleaf.mockResolvedValue(false);
  });

  it('opens on "Not checked yet" when no check has run, never "Not recorded"', async () => {
    sdkMock.getIntegrityCheckRuns.mockResolvedValue({
      missing_file: null,
      checksum_mismatch: null,
      untracked_file: null,
    });
    newStore();
    render(FileChecks, { pollMs: 60_000 });

    expect(await hero().findByRole('heading', { name: 'Not checked yet' })).toBeInTheDocument();
    expect(hero().getByText(/The first check runs tonight/)).toBeInTheDocument();
    expect(screen.queryByText(/Not recorded/)).not.toBeInTheDocument();
  });

  it('says every file is present and undamaged, with when it was last checked', async () => {
    newStore();
    render(FileChecks, { pollMs: 60_000 });

    expect(await hero().findByRole('heading', { name: 'Every file is present and undamaged' })).toBeInTheDocument();
    expect(hero().getByText(/when last checked/)).toBeInTheDocument();
    expect(screen.getByText('None missing')).toBeInTheDocument();
  });

  it('lists what was found with the harmless "Clear this list" before the named destructive action', async () => {
    sdkMock.getIntegrityReportSummary.mockResolvedValue(counts(1, 0, 0));
    paths(IntegrityReport.MissingFile, ['/photos/library/taylor/2025/VID_0412.MOV']);
    sdkMock.clearIntegrityReports.mockResolvedValue({ cleared: 1 });
    newStore();
    render(FileChecks, { pollMs: 60_000 });

    expect(await hero().findByRole('heading', { name: '1 file needs attention' })).toBeInTheDocument();
    expect(await screen.findByText('VID_0412.MOV')).toBeInTheDocument();

    await fireEvent.click(screen.getByRole('button', { name: 'Clear this list' }));
    expect(sdkMock.clearIntegrityReports).toHaveBeenCalledWith({ $type: IntegrityReport.MissingFile });
    expect(confirmFrameleaf).not.toHaveBeenCalled();
    expect(sdkMock.createJob).not.toHaveBeenCalled();

    await fireEvent.click(screen.getByRole('button', { name: 'Move this photo to Trash…' }));
    expect(confirmFrameleaf).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Move 1 photo to Trash?', danger: true }),
    );
    expect(sdkMock.createJob).not.toHaveBeenCalled();
  });

  it('removes one finding from the list without touching its file', async () => {
    sdkMock.getIntegrityReportSummary.mockResolvedValue(counts(0, 0, 2));
    paths(IntegrityReport.UntrackedFile, ['/data/upload/a/IMG_1.JPG', '/data/upload/a/IMG_2.JPG']);
    sdkMock.dismissIntegrityReport.mockResolvedValue(undefined as never);
    newStore();
    render(FileChecks, { pollMs: 60_000 });

    await fireEvent.click(await screen.findByRole('button', { name: 'Remove IMG_1.JPG from the list' }));
    expect(sdkMock.dismissIntegrityReport).toHaveBeenCalledWith({ id: 'f0' });
    expect(sdkMock.deleteIntegrityReport).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Delete these 2 files from the drive…' })).toBeInTheDocument();
  });

  it('says a drive is unplugged when the server cannot reach the folder the missing files are in (FL-520)', async () => {
    sdkMock.getIntegrityReportSummary.mockResolvedValue(counts(12));
    sdkMock.getIntegrityOverview.mockResolvedValue(
      overview({
        missing: 12,
        unreachable: [
          {
            kind: IntegrityUnreachableFolderKind.Library,
            name: 'Taylor’s 2024 photos',
            path: '/mnt/2024',
            missing: 12,
          },
        ],
      }),
    );
    newStore();
    render(FileChecks, { pollMs: 60_000 });

    expect(await hero().findByRole('heading', { name: '12 files can’t be found' })).toBeInTheDocument();
    expect(hero().getByText(/Nothing has been removed from your library/)).toBeInTheDocument();
    expect(screen.getByText('Check the drive before anything else')).toBeInTheDocument();
    expect(screen.getByText('Folder can’t be reached')).toBeInTheDocument();
    expect(screen.getAllByText(/Taylor’s 2024 photos/).length).toBeGreaterThan(0);
  });

  it('no longer guesses an unplugged drive from many missing files in one folder (FL-520)', async () => {
    const folder = '/photos/library/taylor/2024/';
    sdkMock.getIntegrityReportSummary.mockResolvedValue(counts(12));
    paths(
      IntegrityReport.MissingFile,
      Array.from({ length: 3 }, (_, index) => `${folder}IMG_${index}.JPG`),
    );
    newStore();
    render(FileChecks, { pollMs: 60_000 });

    expect(await hero().findByRole('heading', { name: '12 files need attention' })).toBeInTheDocument();
    expect(screen.queryByText('Check the drive before anything else')).not.toBeInTheDocument();
  });

  it('offers a restore from a backup for missing files, and says how many are RAW files to match (FL-520)', async () => {
    sdkMock.getIntegrityReportSummary.mockResolvedValue(counts(2));
    sdkMock.getIntegrityOverview.mockResolvedValue(overview({ missing: 2, rawToMatch: 1 }));
    paths(IntegrityReport.MissingFile, ['/a/IMG_1.CR2', '/a/IMG_2.JPG']);
    newStore();
    render(FileChecks, { pollMs: 60_000 });

    expect(await screen.findByText(/1 of them is a RAW file/)).toBeInTheDocument();
    await fireEvent.click(screen.getByRole('button', { name: 'Restore from a backup' }));
    expect(goto).toHaveBeenCalledWith(expect.stringContaining('area=backups&section=restore&files=missing'));
  });

  it('names a photo by the file name it came with, and a stray file by its path (FL-737)', async () => {
    sdkMock.getIntegrityReportSummary.mockResolvedValue(counts(1, 0, 1));
    sdkMock.getIntegrityReport.mockImplementation(({ $type }) =>
      Promise.resolve({
        items:
          $type === IntegrityReport.MissingFile
            ? [{ id: 'm', type: $type, path: '/data/upload/u/0b/fb/0bfb7144.jpg', originalFileName: 'beach-1.jpg' }]
            : $type === IntegrityReport.UntrackedFile
              ? [{ id: 's', type: $type, path: '/data/upload/u/ab/cd/extra.jpg', originalFileName: null }]
              : [],
      }),
    );
    newStore();
    render(FileChecks, { pollMs: 60_000 });

    expect(await screen.findByText('beach-1.jpg')).toBeInTheDocument();
    expect(screen.queryByText('0bfb7144.jpg')).not.toBeInTheDocument();
    expect(screen.queryByText('/data/upload/u/0b/fb/')).not.toBeInTheDocument();
    expect(screen.getByText('extra.jpg')).toBeInTheDocument();
    expect(screen.getByText('/data/upload/u/ab/cd/')).toBeInTheDocument();
  });

  it('opens Missing files and Damaged files scanning just the photos these checks found (FL-737)', async () => {
    sdkMock.getIntegrityReportSummary.mockResolvedValue(counts(1, 1));
    sdkMock.getSummary.mockResolvedValue({ recoveryAvailable: true } as never);
    sdkMock.getIntegrityFindingAssets.mockImplementation(({ kind }) =>
      Promise.resolve({ assetIds: [kind === IntegrityFindingKind.Missing ? 'a-missing' : 'a-damaged'] }),
    );
    sdkMock.startMissingAssetScan.mockResolvedValue({ runId: 'r', operationId: 'o' });
    sdkMock.startCorruptAssetScan.mockResolvedValue({ runId: 'r', operationId: 'o' });
    newStore();
    render(FileChecks, { pollMs: 60_000 });

    await fireEvent.click(await screen.findByRole('button', { name: 'Find it again' }));
    await vi.waitFor(() => expect(goto).toHaveBeenCalledWith(expect.stringContaining('section=missing-media')));
    expect(sdkMock.startMissingAssetScan).toHaveBeenCalledWith({ mediaHealthScanDto: { assetIds: ['a-missing'] } });

    await fireEvent.click(screen.getByRole('button', { name: 'Look for a good copy' }));
    await vi.waitFor(() => expect(goto).toHaveBeenCalledWith(expect.stringContaining('section=corrupt-media')));
    expect(sdkMock.startCorruptAssetScan).toHaveBeenCalledWith({ mediaHealthScanDto: { assetIds: ['a-damaged'] } });
  });

  it('still opens the tool when its scan cannot start (FL-737)', async () => {
    sdkMock.getIntegrityReportSummary.mockResolvedValue(counts(1));
    sdkMock.getIntegrityFindingAssets.mockResolvedValue({ assetIds: ['a'] });
    sdkMock.startMissingAssetScan.mockRejectedValue(new Error('409'));
    newStore();
    render(FileChecks, { pollMs: 60_000 });

    await fireEvent.click(await screen.findByRole('button', { name: 'Find it again' }));
    await vi.waitFor(() => expect(goto).toHaveBeenCalledWith(expect.stringContaining('section=missing-media')));
  });

  it('shows a running check’s progress and stops it, keeping what was found (FL-520)', async () => {
    sdkMock.getQueue.mockResolvedValue({
      hasUnfinishedWork: true,
      statistics: { active: 1, waiting: 0, delayed: 0, paused: 0, completed: 0, failed: 0 },
    } as never);
    const running = overview({
      running: [{ type: IntegrityReport.ChecksumMismatch, startedAt: ran, done: 37, total: 100 }],
      history: [
        {
          type: IntegrityReport.MissingFile,
          startedAt: ran,
          finishedAt: '2026-10-14T09:44:00.000Z',
          outcome: IntegrityCheckOutcome.Completed,
          found: 0,
          checked: null,
        },
      ],
    });
    sdkMock.getIntegrityOverview.mockResolvedValue(running);
    sdkMock.stopIntegrityChecks.mockResolvedValue(overview());
    newStore();
    render(FileChecks, { pollMs: 10 });

    expect(await hero().findByRole('heading', { name: 'Checking your files now' })).toBeInTheDocument();
    expect(await hero().findByText('Reading files now · 37%')).toBeInTheDocument();
    expect(hero().getByText('Finished')).toBeInTheDocument();

    await fireEvent.click(hero().getByRole('button', { name: 'Stop' }));
    expect(sdkMock.stopIntegrityChecks).toHaveBeenCalled();
    expect(sdkMock.clearIntegrityReports).not.toHaveBeenCalled();
  });

  it('lists recent checks with what each found (FL-520)', async () => {
    sdkMock.getIntegrityOverview.mockResolvedValue(
      overview({
        history: [
          {
            type: IntegrityReport.ChecksumMismatch,
            startedAt: '2026-10-14T09:00:00.000Z',
            finishedAt: '2026-10-14T09:18:00.000Z',
            outcome: IntegrityCheckOutcome.Paused,
            found: 1,
            checked: 4210,
          },
          {
            type: IntegrityReport.MissingFile,
            startedAt: '2026-10-14T08:50:00.000Z',
            finishedAt: '2026-10-14T08:54:00.000Z',
            outcome: IntegrityCheckOutcome.Stopped,
            found: 0,
            checked: null,
          },
          {
            type: IntegrityReport.MissingFile,
            startedAt: '2026-10-14T08:40:00.000Z',
            finishedAt: '2026-10-14T08:40:02.000Z',
            outcome: IntegrityCheckOutcome.Completed,
            found: 0,
            checked: 1200,
          },
        ],
      }),
    );
    newStore();
    render(FileChecks, { pollMs: 60_000 });

    expect(await screen.findByText(/4,210 files read · took 18 minutes · carries on next night/)).toBeInTheDocument();
    expect(screen.getByText('1 found')).toBeInTheDocument();
    expect(screen.getByText('Stopped before it finished')).toBeInTheDocument();
    // a two-second check reads in seconds, not "took 1 minute"
    expect(screen.getByText('1,200 files read · took 2 seconds')).toBeInTheDocument();
  });

  it('one switch per check writes every setting that check is made of', async () => {
    const store = newStore();
    render(FileChecks, { pollMs: 60_000 });

    await fireEvent.click(await screen.findByRole('switch', { name: 'Look for Missing files' }));
    expect(store.draft.integrityChecks.missingFiles.enabled).toBe(false);
    expect(store.draft.libraryCare?.healthScan).toBe(false);
    // Stray files still needs the reference audit.
    expect(store.draft.libraryCare?.integrityAudit).toBe(true);

    await fireEvent.click(screen.getByRole('switch', { name: 'Look for Stray files' }));
    expect(store.draft.integrityChecks.untrackedFiles.enabled).toBe(false);
    expect(store.draft.libraryCare?.integrityAudit).toBe(false);

    await fireEvent.click(screen.getByRole('switch', { name: 'Look for Damaged files' }));
    expect(store.draft.integrityChecks.checksumFiles.enabled).toBe(false);
    expect(store.draft.libraryCare?.checksumScan).toBe(false);
    expect(await hero().findByRole('heading', { name: 'File checks are off' })).toBeInTheDocument();
  });

  it('keeps the limits and start times as plain choices that write the saved values', async () => {
    const store = newStore();
    render(FileChecks, { pollMs: 60_000 });

    const stop = await screen.findByRole('combobox', { name: 'Stop after' });
    expect(stop).toHaveValue('60');
    await fireEvent.change(stop, { target: { value: '120' } });
    expect(store.draft.integrityChecks.checksumFiles.timeLimit).toBe(7_200_000);

    await fireEvent.click(screen.getByRole('button', { name: 'Half' }));
    expect(store.draft.integrityChecks.checksumFiles.percentageLimit).toBe(0.5);

    // FL-363: the overnight schedule decides when the checks run, so no start time is offered here
    expect(screen.queryByRole('combobox', { name: 'Damaged files check starts at' })).not.toBeInTheDocument();
    // no expression is ever shown
    expect(screen.queryByText(/\* \* \*/)).not.toBeInTheDocument();
  });
});
