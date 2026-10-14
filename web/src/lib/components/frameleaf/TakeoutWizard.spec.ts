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
 * FL-65 / FL-83: the Google Photos import flow (Upload → Check → Import), hosted in the Command
 * Center's "Import from Google Photos" dialog. Everything it shows is the server's import; every step
 * is a server request.
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
  counts: counts({ items: 1560, newAssets: 1248, matchedOriginals: 312, ready: 1248, review: 3 }),
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
    sidecarReview: false,
    updateMatchedMetadata: false,
    includeTrashed: false,
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

  it('opens on Upload, Check and Import, with one way in', () => {
    render(TakeoutWizard);
    const steps = screen.getByRole('list', { name: en.frameleaf_takeout_steps_label });
    expect(
      within(steps)
        .getAllByRole('listitem')
        .map((item) => item.textContent?.trim().replace(/^\d+/, '')),
    ).toEqual(['Upload', 'Check', 'Import']);
    expect(screen.getByRole('button', { name: en.frameleaf_takeout_choose_zips })).toBeInTheDocument();
  });

  it('shows what was found and imports with one press', async () => {
    sdkMock.getTakeoutPairs.mockResolvedValue({ pairs: [], total: 96 });
    sdkMock.getTakeoutItems.mockResolvedValue({ items: [], total: 0, hiddenLocked: 0 });
    sdkMock.startTakeoutImport.mockResolvedValue({ ...reviewImport(), state: TakeoutState.Importing });
    render(TakeoutWizard, { current: reviewImport() });

    const steps = screen.getByRole('list', { name: en.frameleaf_takeout_steps_label });
    expect(steps.querySelector('[aria-current="step"]')?.textContent).toContain('Import');
    expect(screen.getByText(en.frameleaf_takeout_fact_already)).toBeInTheDocument();
    expect(await screen.findByText('96')).toBeInTheDocument();
    // Large libraries are told they can leave.
    expect(screen.getByText(en.frameleaf_takeout_leave_body)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: `Import ${(1248).toLocaleString()} photos` }));
    expect(sdkMock.startTakeoutImport).toHaveBeenCalledWith({
      id: 'import-1',
      takeoutOptionsDto: expect.objectContaining({ sidecarReview: false, albums: true, selectedAlbums: [] }),
    });
  });

  it('keeps the upload screen honest: stay until the upload finishes', () => {
    render(TakeoutWizard, {
      current: {
        ...reviewImport(),
        phase: TakeoutPhase.Sources,
        state: TakeoutState.Sources,
        sources: [{ ...archive('takeout-001'), received: 4 }],
      },
    });
    expect(screen.getByText(en.frameleaf_takeout_keep_open_title)).toBeInTheDocument();
    expect(screen.getByText('The upload stopped at 0 of 1 files')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: en.frameleaf_takeout_choose_zips })).toBeInTheDocument();
  });

  it('lets the owner choose details for unclear photos, then adds them all', async () => {
    const unclearImport = {
      ...reviewImport(),
      phase: TakeoutPhase.Completed,
      state: TakeoutState.Completed,
      counts: counts({ imported: 1245, review: 1 }),
      options: { ...reviewImport().options, sidecarReview: true },
    };
    sdkMock.getTakeoutItems.mockResolvedValue({
      items: [
        {
          id: 'item-1',
          path: 'Trip/IMG_1.jpg',
          folder: 'Trip',
          source: 'takeout-001.zip',
          kind: 'image',
          size: 10,
          state: 'review',
          assetId: null,
          metadata: { title: 'IMG_1.jpg' },
          candidates: [
            { id: 'a', path: 'Trip/a.json', metadata: { title: 'IMG_1.jpg', takenAt: '2019-06-04T14:02:00.000Z' } },
            { id: 'b', path: 'Trip/b.json', metadata: { title: 'IMG_1.jpg', description: 'Lake' } },
          ],
          sidecarId: 'a',
          albums: ['Trip'],
          warnings: [],
          locked: false,
          error: null,
        },
      ],
      total: 1,
      hiddenLocked: 0,
    } as never);
    sdkMock.resolveTakeoutItem.mockResolvedValue(unclearImport);
    sdkMock.startTakeoutImport.mockResolvedValue({ ...unclearImport, state: TakeoutState.Importing });
    render(TakeoutWizard, { current: unclearImport });

    await userEvent.click(await screen.findByRole('radio', { name: /No date/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Add 1 photo' }));
    expect(sdkMock.resolveTakeoutItem).toHaveBeenCalledWith({
      id: 'import-1',
      itemId: 'item-1',
      takeoutResolveDto: { sidecarId: 'b' },
    });
    expect(sdkMock.startTakeoutImport).toHaveBeenCalledWith(
      expect.objectContaining({ takeoutOptionsDto: expect.objectContaining({ sidecarReview: false }) }),
    );
  });

  it('lists earlier imports when none is open', () => {
    render(TakeoutWizard, { imports: [reviewImport()] });
    expect(screen.getByRole('link', { name: /Family export/ })).toHaveAttribute(
      'href',
      '/user-settings?area=backup&section=takeout&workflow=import&import=import-1',
    );
  });

  it('starts an import from the chosen ZIP files and opens it in place', async () => {
    sdkMock.createTakeoutImport.mockResolvedValue({ ...reviewImport(), id: 'created' });
    const { container } = render(TakeoutWizard);
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    await userEvent.upload(input, new File(['zip'], 'takeout-001.zip', { type: 'application/zip' }));
    expect(sdkMock.createTakeoutImport).toHaveBeenCalledWith({
      takeoutCreateDto: { name: expect.stringContaining('Google Photos') },
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
    const { container } = render(TakeoutWizard);
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    await userEvent.upload(input, new File(['zip'], 'takeout-001.zip', { type: 'application/zip' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(en.frameleaf_takeout_error_generic);
    expect(state.goto).not.toHaveBeenCalled();
  });
});
