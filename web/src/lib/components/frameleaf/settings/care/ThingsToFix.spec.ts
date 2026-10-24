import { type AdminConfigDto } from '@frameleaf/sdk';
import { fireEvent, render, screen, within } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { SystemConfigDraftStore } from '$lib/frameleaf/system-config-draft.svelte';
import en from '../../../../../../../i18n/en.json';
import ThingsToFix from './ThingsToFix.svelte';

const draft = vi.hoisted(() => ({ store: undefined as unknown }));
const auth = vi.hoisted(() => ({ user: { id: 'u1', isAdmin: true } }));

vi.mock('$app/navigation', () => ({ goto: vi.fn() }));
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
  });
});
