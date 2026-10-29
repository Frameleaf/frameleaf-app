import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import en from '$i18n/en.json';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { loadPhotos, loadWorkspace, ratePhoto, type Photo, type Shoot } from '$lib/frameleaf/photography/api';
import { loadWorkflowSummaries } from '$lib/frameleaf/photography/workflow-api';
import PhotographyWorkspace from './PhotographyWorkspace.svelte';

vi.mock('$lib/frameleaf/photography/api', async (original) => ({
  ...(await original<typeof import('$lib/frameleaf/photography/api')>()),
  loadWorkspace: vi.fn(),
  loadPhotos: vi.fn(),
  ratePhoto: vi.fn(),
  saveWorkspace: vi.fn(),
  // a section's own data stays loading: these tests look at the workspace around it
  loadBrand: vi.fn(() => new Promise(() => {})),
}));
vi.mock('$lib/frameleaf/photography/workflow-api', async (original) => ({
  ...(await original<typeof import('$lib/frameleaf/photography/workflow-api')>()),
  loadWorkflowSummaries: vi.fn(),
  workflowRequest: vi.fn(() => new Promise(() => {})),
}));
vi.mock('$lib/managers/auth-manager.svelte', () => ({
  authManager: { authenticated: true, user: { id: 'owner', name: 'North Studio' } },
}));

const shoot: Shoot = {
  id: 'shoot',
  albumId: 'album',
  name: 'Harbour portraits',
  client: 'Jamie',
  type: 'Portrait',
  date: '2026-10-02',
  stage: 'Imported',
  unavailable: false,
  coverAssetId: null,
  assetCount: 2,
};
const photo = (id: string, rating: number | null = null): Photo => ({
  id,
  fileName: `${id}.CR3`,
  rating,
  canRate: true,
  stackCount: 1,
  currentRevisionId: null,
});

/** The shoot's card in the list (its name follows the stage chip on the cover). */
const card = () => screen.findByRole('button', { name: /^Imported Harbour portraits/ });
const open = async () => {
  render(PhotographyWorkspace);
  await fireEvent.click(await card());
  return screen.findByRole('button', { name: 'Show one.CR3' });
};

describe('PhotographyWorkspace', () => {
  beforeAll(() => addMessages('dev', en));

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(loadWorkspace).mockResolvedValue({ revision: 'r1', shoots: [shoot] });
    vi.mocked(loadPhotos).mockResolvedValue({ photos: [photo('one'), photo('two')], nextCursor: null });
    vi.mocked(loadWorkflowSummaries).mockResolvedValue({ galleries: [] });
    vi.mocked(ratePhoto).mockResolvedValue();
    sdkMock.getAllAlbums.mockResolvedValue([]);
    sdkMock.getAssetDevelop.mockResolvedValue({ revisions: [] } as never);
  });

  it('calls it a shoot everywhere, with its sections as tabs under the open shoot', async () => {
    render(PhotographyWorkspace);
    expect(await screen.findByRole('button', { name: 'New shoot' })).toBeInTheDocument();
    expect(screen.queryByText(/project/i)).toBeNull();
    const rail = screen.getByRole('navigation', { name: 'Clients' });
    // the rail holds the studio-wide places only; a shoot's sections never join it
    for (const name of ['Shoots', 'Galleries', 'Studio website', 'Watermarks', 'Branding']) {
      expect(within(rail).getByRole('button', { name })).toBeInTheDocument();
    }
    await fireEvent.click(await card());
    const tabs = await screen.findByRole('navigation', { name: 'Shoot sections' });
    for (const name of ['Photographs', 'Intake & assembly', 'Client workflow', 'Orders & delivery', 'Presentation']) {
      expect(within(tabs).getByRole('button', { name })).toBeInTheDocument();
    }
    expect(within(tabs).getByRole('button', { name: 'Photographs' })).toHaveAttribute('aria-current', 'page');
    expect(within(rail).queryByRole('button', { name: 'Orders & delivery' })).toBeNull();
    expect(screen.queryByText(/project/i)).toBeNull();
  });

  it("opens the shoot's RAW photos in the RAW editor, the chosen ones once some are chosen (FL-420)", async () => {
    vi.mocked(loadPhotos).mockResolvedValue({
      photos: [photo('one'), photo('two'), { ...photo('three'), fileName: 'three.JPG' }],
      nextCursor: null,
    });
    const thumbnail = await open();
    expect(screen.getByRole('link', { name: /RAW compatibility/ })).toHaveAttribute('href', '/raw-support');
    expect(await screen.findByRole('link', { name: 'Open in RAW editor' })).toHaveAttribute(
      'href',
      '/photography/develop?shoot=shoot',
    );
    await fireEvent.click(screen.getByRole('checkbox', { name: 'Select two.CR3' }));
    await fireEvent.click(screen.getByRole('checkbox', { name: 'Select three.JPG' }));
    // the JPEG is chosen too, but only RAW photos open in the RAW editor
    const chosen = screen.getByRole('link', { name: 'Open in RAW editor (1)' }).getAttribute('href');
    expect(chosen).toMatch(/^\/photography\/develop\?shoot=shoot(&photo=one)?&only=two$/);
    await fireEvent.click(thumbnail);
    expect(screen.getByRole('link', { name: /^Open in RAW editor \(\d\)$/ }).getAttribute('href')).toContain(
      'photo=one',
    );
  });

  it('opens the shoot it is given, at its galleries for Proof', async () => {
    render(PhotographyWorkspace, { initialShoot: 'shoot', initialSection: 'galleries' });
    expect(await screen.findByRole('heading', { level: 1, name: 'Galleries' })).toBeInTheDocument();
    expect(await screen.findByRole('combobox', { name: 'Current shoot' })).toHaveValue('shoot');
  });

  it('shows what each shoot needs next and opens the shoot at that section', async () => {
    vi.mocked(loadWorkflowSummaries).mockResolvedValue({
      galleries: [
        {
          shootId: 'shoot',
          revision: 'r',
          title: 'Harbour portraits',
          mode: 'select-before-editing',
          selectionDeadline: null,
          expiresAt: null,
          published: true,
          submittedRounds: 0,
          unpaidOrders: 1,
          readyCount: 0,
          pendingEdits: 0,
          outstanding: 2500,
          currency: 'CAD',
          invited: 1,
        },
      ],
    });
    render(PhotographyWorkspace);
    // the prototype's tiles: awaiting selections and the outstanding amount in the gallery's currency
    expect(await screen.findByText('Outstanding · CAD')).toBeInTheDocument();
    expect(screen.getByText('Awaiting selections').nextElementSibling).toHaveTextContent('1');
    const step = await screen.findByRole('button', { name: 'Harbour portraits Waiting for payment' });
    await fireEvent.click(step);
    expect(await screen.findByRole('heading', { level: 1, name: 'Orders & delivery' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Current shoot' })).toHaveValue('shoot');
  });

  it('rates at once after clicking a photo and pressing a number, without locking the grid', async () => {
    let finish: () => void = () => {};
    vi.mocked(ratePhoto).mockImplementation(() => new Promise<void>((resolve) => (finish = resolve)));
    const thumbnail = await open();
    await fireEvent.click(thumbnail);
    await fireEvent.keyDown(thumbnail, { key: '4' });

    // shown before the server answers, and nothing is disabled while it saves
    expect(screen.getByRole('button', { name: '4 stars for one.CR3' })).toHaveAttribute('aria-pressed', 'true');
    expect(ratePhoto).toHaveBeenCalledWith('shoot', 'one', 4);
    expect(screen.getByRole('button', { name: '5 stars for two.CR3' })).toBeEnabled();
    expect(screen.getByText('Saving…')).toBeInTheDocument();

    // the arrow keys keep working with focus on the thumbnail; X rejects the next photo
    await fireEvent.keyDown(thumbnail, { key: 'ArrowRight' });
    await fireEvent.keyDown(thumbnail, { key: 'x' });
    expect(ratePhoto).toHaveBeenCalledWith('shoot', 'two', -1);
    expect(screen.getByRole('button', { name: 'Restore two.CR3' })).toHaveAttribute('aria-pressed', 'true');
    finish();
  });

  it('puts one tile back when its rating cannot be saved and offers a retry on the tile', async () => {
    vi.mocked(ratePhoto).mockRejectedValueOnce(new Error('offline'));
    const thumbnail = await open();
    await fireEvent.click(screen.getByRole('button', { name: '5 stars for one.CR3' }));
    expect(await screen.findByText('Rating not saved.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '5 stars for one.CR3' })).toHaveAttribute('aria-pressed', 'false');
    expect(thumbnail).toBeEnabled();

    await fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(ratePhoto).toHaveBeenCalledTimes(2));
    expect(screen.getByRole('button', { name: '5 stars for one.CR3' })).toHaveAttribute('aria-pressed', 'true');
    await waitFor(() => expect(screen.queryByText('Rating not saved.')).toBeNull());
  });
});
