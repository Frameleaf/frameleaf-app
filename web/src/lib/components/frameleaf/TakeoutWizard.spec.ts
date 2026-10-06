import {
  TakeoutPhase,
  TakeoutSourceKind,
  TakeoutState,
  type TakeoutCountsDto,
  type TakeoutResponseDto,
} from '@frameleaf/sdk';
import { render, screen, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { addMessages } from 'svelte-i18n';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import TakeoutWizard from '$lib/components/frameleaf/TakeoutWizard.svelte';
import en from '../../../../../i18n/en.json';

/**
 * FL-65 / FL-83: the Google Photos import wizard, hosted in the Command Center's "Import Google
 * Photos" dialog. Everything it shows is the server's import; every step is a server request.
 */

const state = vi.hoisted(() => ({ goto: vi.fn() }));
vi.mock('$app/navigation', () => ({ goto: state.goto }));
vi.mock('$lib/managers/auth-manager.svelte', () => ({
  authManager: { user: { id: 'me', isAdmin: false }, params: {} },
}));

const counts = (overrides: Partial<TakeoutCountsDto> = {}): TakeoutCountsDto => ({
  failed: 0,
  files: 0,
  hiddenLocked: 0,
  imported: 0,
  importing: 0,
  items: 0,
  matched: 0,
  matchedOriginals: 0,
  newAssets: 0,
  ready: 0,
  rejected: 0,
  review: 0,
  skipped: 0,
  suggestedPairs: 0,
  unresolvedPairs: 0,
  ...overrides,
});

const archive = (id: string) => ({
  id,
  kind: TakeoutSourceKind.Zip,
  name: `${id}.zip`,
  received: 10,
  rejected: 0,
  scanned: true,
  size: 10,
});

const reviewImport = (): TakeoutResponseDto => ({
  action: null,
  albums: [],
  counts: counts({ items: 1560, newAssets: 1248, matchedOriginals: 312, ready: 1248, review: 3, suggestedPairs: 2 }),
  createdAt: '2026-09-20T10:00:00.000Z',
  error: null,
  errorCode: null,
  id: 'import-1',
  name: 'Family export',
  operationId: null,
  options: {
    albums: true,
    archive: true,
    dates: true,
    descriptions: true,
    favorites: true,
    locations: true,
    sidecarReview: true,
    updateMatchedMetadata: false,
  },
  phase: TakeoutPhase.Review,
  processed: 0,
  sources: [archive('takeout-001'), archive('takeout-002')],
  state: TakeoutState.Review,
  total: null,
  updatedAt: '2026-09-20T10:05:00.000Z',
});

describe('TakeoutWizard', () => {
  beforeAll(() => addMessages('dev', en));
  beforeEach(() => {
    vi.resetAllMocks();
    sdkMock.getTakeoutItems.mockResolvedValue({ items: [], total: 0, hiddenLocked: 0 });
    sdkMock.getTakeoutPairs.mockResolvedValue({ pairs: [], total: 0 });
  });

  it("uses the prototype's stages and intro", () => {
    render(TakeoutWizard);
    const steps = screen.getByRole('list', { name: en.frameleaf_takeout_steps_label });
    expect(
      within(steps)
        .getAllByRole('listitem')
        .map((item) => item.textContent?.replace(/^\d+/, '')),
    ).toEqual(['Stage', 'Scan', 'Reconcile']);
    expect(screen.getByText('The import keeps going on the server even if you close this page.')).toBeInTheDocument();
  });

  it("shows the server's import: its stage and facts", () => {
    render(TakeoutWizard, { current: reviewImport() });
    const steps = screen.getByRole('list', { name: en.frameleaf_takeout_steps_label });
    expect(steps.querySelector('[aria-current="step"]')?.textContent).toContain('Reconcile');
    const facts = screen.getByText(en.frameleaf_takeout_fact_source).closest('dl') as HTMLElement;
    const pairs = [...facts.querySelectorAll('dt')].map((term) => [
      term.textContent?.trim(),
      term.nextElementSibling?.textContent?.trim(),
    ]);
    expect(pairs).toEqual([
      ['Source', '2 Takeout archives'],
      ['New photos and videos', (1248).toLocaleString()],
      ['Matched originals', '312 · restore album memberships'],
      ['Needs review', expect.stringContaining('3')],
    ]);
    expect(screen.getByText(en.frameleaf_takeout_flagged_notice)).toBeInTheDocument();
  });

  it('lists earlier imports when none is open', () => {
    render(TakeoutWizard, { imports: [reviewImport()] });
    expect(screen.getByRole('link', { name: /Family export/ })).toHaveAttribute(
      'href',
      '/user-settings?area=backup&section=takeout&workflow=import&import=import-1',
    );
  });

  it('starts an import on the server and opens it in place', async () => {
    sdkMock.createTakeoutImport.mockResolvedValue({ ...reviewImport(), id: 'created' });
    render(TakeoutWizard);
    await userEvent.click(screen.getByRole('button', { name: en.frameleaf_takeout_continue }));
    expect(sdkMock.createTakeoutImport).toHaveBeenCalledWith({
      takeoutCreateDto: { name: en.frameleaf_takeout_default_name },
    });
    expect(state.goto).toHaveBeenCalledWith(
      '/user-settings?area=backup&section=takeout&workflow=import&import=created',
      expect.objectContaining({ noScroll: true }),
    );
  });

  it('closes the dialog with Cancel', async () => {
    const onClose = vi.fn();
    render(TakeoutWizard, { onClose });
    await userEvent.click(screen.getByRole('button', { name: en.frameleaf_takeout_cancel }));
    expect(onClose).toHaveBeenCalled();
    expect(state.goto).not.toHaveBeenCalled();
  });

  it('shows a failed start instead of leaving', async () => {
    sdkMock.createTakeoutImport.mockRejectedValue(new Error('nope'));
    render(TakeoutWizard);
    await userEvent.click(screen.getByRole('button', { name: en.frameleaf_takeout_continue }));
    expect(await screen.findByRole('alert')).toHaveTextContent(en.frameleaf_takeout_error_generic);
    expect(state.goto).not.toHaveBeenCalled();
  });
});
