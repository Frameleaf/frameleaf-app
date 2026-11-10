import { FileProblemTab, ProcessingFailureStep, type AdminConfigDto } from '@frameleaf/sdk';
import { fireEvent, render, screen, within } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { SystemConfigDraftStore } from '$lib/frameleaf/system-config-draft.svelte';
import en from '../../../../../../../i18n/en.json';
import ThingsToFix from './ThingsToFix.svelte';

const draft = vi.hoisted(() => ({ store: undefined as unknown }));
const auth = vi.hoisted(() => ({ user: { id: 'u1', isAdmin: true } }));

const nav = vi.hoisted(() => ({ goto: vi.fn() }));
vi.mock('$app/navigation', () => nav);
vi.mock('$lib/managers/auth-manager.svelte', () => ({ authManager: auth }));
vi.mock('$lib/managers/feature-flags-manager.svelte', () => ({
  featureFlagsManager: { value: { configFile: false } },
}));
vi.mock('$lib/frameleaf/system-config-draft.svelte', async (original) => ({
  ...(await original<object>()),
  requireSystemConfigDraft: () => draft.store,
  getSystemConfigDraft: () => draft.store,
}));

const config = () =>
  ({
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

const summary = (queues: Partial<Record<string, number>> = {}) =>
  ({
    care: { rawRecovery: true },
    recoveryAvailable: false,
    queues: { missing: 0, damagedConfirmed: 0, damagedSuspected: 0, duplicates: 0, enrichmentPending: 0, ...queues },
  }) as never;

/** FL-520: the server's one source of findings. */
const overview = (counts: Partial<Record<'missing' | 'damaged' | 'stray' | 'rawToMatch', number>> = {}) => ({
  missing: 0,
  damaged: 0,
  stray: 0,
  rawToMatch: 0,
  unreachable: [],
  running: [],
  history: [],
  ...counts,
});

/** The Overview's reading, with what Frameleaf fixed in the last 7 days. */
const attention = (fixed: number) =>
  ({
    checkedAt: new Date().toISOString(),
    items: [],
    checks: [],
    dismissed: [],
    fileProblems: { fixed, needsYou: 0, since: null, latest: null },
  }) as never;

const hero = () => within(screen.getByRole('region', { name: 'Things to fix' }));
const row = (name: string) => within(screen.getByText(name, { selector: 'strong' }).closest('li')!);

describe('Things to fix (FL-366)', () => {
  beforeAll(() => {
    addMessages('dev', en);
  });

  beforeEach(() => {
    vi.clearAllMocks();
    auth.user.isAdmin = true;
    sdkMock.getSummary.mockResolvedValue(summary());
    sdkMock.getIntegrityOverview.mockResolvedValue(overview());
    sdkMock.getLivePhotoCandidates.mockResolvedValue({ candidates: [], total: 0, suggestionsEnabled: true });
    sdkMock.getFileProblems.mockResolvedValue({ items: [], total: 0 });
    sdkMock.getAttention.mockResolvedValue(attention(0));
    sdkMock.getProcessingFailures.mockResolvedValue([]);
  });

  it('says "Nothing to fix" when nothing is waiting', async () => {
    newStore();
    render(ThingsToFix);
    expect(await hero().findByRole('heading', { name: 'Nothing to fix' })).toBeInTheDocument();
  });

  it('counts what is waiting, each row with its own Review', async () => {
    sdkMock.getSummary.mockResolvedValue(summary({ duplicates: 38 }));
    sdkMock.getLivePhotoCandidates.mockResolvedValue({ candidates: [], total: 3, suggestionsEnabled: true });
    newStore();
    render(ThingsToFix);

    expect(await hero().findByRole('heading', { name: '41 suggestions are waiting for you' })).toBeInTheDocument();
    expect(row('Live Photos to reconnect').getByText('3 waiting')).toBeInTheDocument();
    expect(row('Look-alike photos').getByText('38 groups')).toBeInTheDocument();
    expect(row('Look-alike photos').getByText('Turned on and off in Duplicates')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Review Live Photos to reconnect' })).toBeInTheDocument();
    expect(screen.queryByText('Just you')).not.toBeInTheDocument();
  });

  it('puts missing and damaged files first, counting each file once', async () => {
    sdkMock.getSummary.mockResolvedValue(summary({ missing: 1, damagedConfirmed: 1 }));
    sdkMock.getIntegrityOverview.mockResolvedValue(overview({ missing: 1, damaged: 1, stray: 4, rawToMatch: 1 }));
    newStore();
    render(ThingsToFix);

    expect(await hero().findByRole('heading', { name: '2 files need attention' })).toBeInTheDocument();
    expect(row('Missing files').getByText('1 found')).toBeInTheDocument();
    // FL-520: the missing RAW originals to match have a count of their own
    expect(row('RAW files to match').getByText('1 waiting')).toBeInTheDocument();
  });

  it("lists the files Frameleaf couldn't process, once each, with how many were set aside (FL-862)", async () => {
    const failure = (assetId: string, step: ProcessingFailureStep, quarantinedAt: string | null) => ({
      assetId,
      step,
      cause: 'unreadable',
      attempts: quarantinedAt ? 3 : 1,
      lastFailedAt: '2026-11-10T08:00:00.000Z',
      quarantinedAt,
      ownerId: 'u1',
      ownerName: 'Taylor',
      fileName: `${assetId}.MOV`,
    });
    sdkMock.getProcessingFailures.mockResolvedValue([
      failure('a1', ProcessingFailureStep.AssetEncodeVideo, '2026-11-10T08:00:00.000Z'),
      failure('a1', ProcessingFailureStep.AssetGenerateThumbnails, null),
      failure('a2', ProcessingFailureStep.Ocr, null),
    ]);
    newStore();
    render(ThingsToFix);

    expect(await hero().findByRole('heading', { name: '2 files couldn’t be processed' })).toBeInTheDocument();
    expect(row('Couldn’t process').getByText('2 files')).toBeInTheDocument();
    expect(row('Couldn’t process').getByText('1 set aside after 3 tries')).toBeInTheDocument();
    await fireEvent.click(screen.getByRole('button', { name: 'Review Couldn’t process' }));
    expect(nav.goto).toHaveBeenCalledWith(expect.stringContaining('section=couldnt-process'));
  });

  it('gives an administrator a switch on the two kinds that can be turned off', async () => {
    sdkMock.getLivePhotoCandidates.mockResolvedValue({ candidates: [], total: 3, suggestionsEnabled: true });
    const store = newStore();
    render(ThingsToFix);

    await fireEvent.click(await screen.findByRole('switch', { name: 'Look for Live Photos to reconnect' }));
    expect(store.draft.libraryCare?.livePhotoRepair).toBe(false);
    expect(row('Live Photos to reconnect').getByText('Not looking')).toBeInTheDocument();
    expect(row('Live Photos to reconnect').getByText('Suggestions already made are kept')).toBeInTheDocument();

    await fireEvent.click(screen.getByRole('switch', { name: 'Look for RAW files to match' }));
    expect(store.draft.libraryCare?.rawRecovery).toBe(false);
  });

  it('shows a member their own lists and no switches', async () => {
    auth.user.isAdmin = false;
    draft.store = undefined;
    sdkMock.getLivePhotoCandidates.mockResolvedValue({ candidates: [], total: 2, suggestionsEnabled: true });
    render(ThingsToFix);

    expect(await hero().findByRole('heading', { name: '2 suggestions are waiting for you' })).toBeInTheDocument();
    expect(sdkMock.getSummary).toHaveBeenCalledWith({});
    expect(sdkMock.getIntegrityOverview).not.toHaveBeenCalled();
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
    expect(screen.queryByText('RAW files to match')).not.toBeInTheDocument();
    // the 7-day count is an administrator's reading
    expect(sdkMock.getAttention).not.toHaveBeenCalled();
    expect(screen.queryByText('Fixed for you')).not.toBeInTheDocument();
  });

  describe('damaged and missing files (FL-1338)', () => {
    /** What the file problems list holds: the Needs you total, and a 30-day Fixed tab Things to fix never reads. */
    const lists = (needs: number) =>
      sdkMock.getFileProblems.mockImplementation(({ tab }: { tab: FileProblemTab }) =>
        Promise.resolve({ items: [], total: tab === FileProblemTab.Needs ? needs : 300 }),
      );

    it('says how many Frameleaf fixed this week, the Overview’s 7-day count, and opens the fixed list', async () => {
      sdkMock.getAttention.mockResolvedValue(attention(287));
      lists(0);
      newStore();
      render(ThingsToFix);

      expect(await screen.findByText('287 this week')).toBeInTheDocument();
      expect(sdkMock.getFileProblems).not.toHaveBeenCalledWith(expect.objectContaining({ tab: FileProblemTab.Fixed }));
      await fireEvent.click(screen.getByRole('button', { name: 'Review Fixed for you' }));
      expect(nav.goto).toHaveBeenCalledWith('/user-settings?area=care&section=files&tab=fixed');
    });

    it('never calls the 30-day Fixed tab "this week" (W2)', async () => {
      lists(0);
      newStore();
      render(ThingsToFix);

      expect(await row('Fixed for you').findByText('None')).toBeInTheDocument();
      expect(screen.queryByText('300 this week')).not.toBeInTheDocument();
    });

    it('opens the damaged and missing files page from Missing files and Damaged files', async () => {
      sdkMock.getIntegrityOverview.mockResolvedValue(overview({ missing: 11, damaged: 2 }));
      sdkMock.getAttention.mockResolvedValue(attention(287));
      lists(13);
      newStore();
      render(ThingsToFix);

      expect(await hero().findByRole('heading', { name: '13 files need you' })).toBeInTheDocument();
      expect(sdkMock.getFileProblems).toHaveBeenCalledWith({ tab: FileProblemTab.Needs, take: 1 });
      expect(
        hero().getByText(/Frameleaf fixed 287 files by itself this week\. 11 missing and 2 damaged are left/),
      ).toBeInTheDocument();
      await fireEvent.click(screen.getByRole('button', { name: 'Review Missing files' }));
      expect(nav.goto).toHaveBeenCalledWith('/user-settings?area=care&section=files&tab=needs');
    });

    it('counts who "need you" from the Needs you list, which a kept file has left (W3)', async () => {
      sdkMock.getIntegrityOverview.mockResolvedValue(overview({ missing: 11, damaged: 2 }));
      sdkMock.getAttention.mockResolvedValue(attention(287));
      lists(12);
      newStore();
      render(ThingsToFix);

      expect(await hero().findByRole('heading', { name: '12 files need you' })).toBeInTheDocument();
    });

    it('never says files "need you" when the Needs you list is empty (W3)', async () => {
      sdkMock.getIntegrityOverview.mockResolvedValue(overview({ missing: 1 }));
      sdkMock.getAttention.mockResolvedValue(attention(287));
      lists(0);
      newStore();
      render(ThingsToFix);

      expect(await hero().findByRole('heading', { name: '1 file needs attention' })).toBeInTheDocument();
      expect(hero().queryByText(/tried everything/)).not.toBeInTheDocument();
    });

    it('says None when nothing was fixed', async () => {
      newStore();
      render(ThingsToFix);
      expect(await hero().findByRole('heading', { name: 'Nothing to fix' })).toBeInTheDocument();
      expect(row('Fixed for you').getByText('None')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Review Fixed for you' })).not.toBeInTheDocument();
    });
  });
});
