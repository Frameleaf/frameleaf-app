import { IntegrityReport, type AdminConfigDto } from '@frameleaf/sdk';
import { fireEvent, render, screen, within } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
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
  integrityCheck: {
    jobCounts: { active: 0, waiting: 0, delayed: 0, paused: 0, completed: 0, failed: 0 },
    queueStatus: { isActive: false, isPaused: false },
  },
} as never;

const counts = (missing = 0, damaged = 0, stray = 0) => ({
  missing_file: missing,
  checksum_mismatch: damaged,
  untracked_file: stray,
});
const ran = '2026-10-14T09:40:00.000Z';
const paths = (type: IntegrityReport, list: string[]) =>
  sdkMock.getIntegrityReport.mockImplementation(({ $type }) =>
    Promise.resolve({ items: $type === type ? list.map((path, index) => ({ id: `f${index}`, path, type })) : [] }),
  );

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
    sdkMock.getQueuesLegacy.mockResolvedValue(idle);
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

  it('reads many missing files in one folder as a drive that is unplugged', async () => {
    const folder = '/photos/library/taylor/2024/';
    sdkMock.getIntegrityReportSummary.mockResolvedValue(counts(12));
    paths(
      IntegrityReport.MissingFile,
      Array.from({ length: 12 }, (_, index) => `${folder}IMG_${index}.JPG`),
    );
    newStore();
    render(FileChecks, { pollMs: 60_000 });

    expect(await hero().findByRole('heading', { name: '12 files can’t be found' })).toBeInTheDocument();
    expect(hero().getByText(/Nothing has been removed from your library/)).toBeInTheDocument();
    expect(screen.getByText('Check the drive before anything else')).toBeInTheDocument();
    expect(screen.getByText('Folder can’t be reached')).toBeInTheDocument();
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

    const start = screen.getByRole('combobox', { name: 'Damaged files check starts at' });
    expect(start).toHaveValue('03:00');
    await fireEvent.change(start, { target: { value: '04:00' } });
    expect(store.draft.integrityChecks.checksumFiles.cronExpression).toBe('0 4 * * *');

    await fireEvent.change(screen.getByRole('combobox', { name: 'File health scan starts at' }), {
      target: { value: '01:00' },
    });
    expect(store.draft.libraryCare?.healthScanCronExpression).toBe('0 1 * * *');
    // no expression is ever shown
    expect(screen.queryByText(/\* \* \*/)).not.toBeInTheDocument();
  });
});
