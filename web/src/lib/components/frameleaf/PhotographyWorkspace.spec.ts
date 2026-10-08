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
}));
vi.mock('$lib/frameleaf/photography/workflow-api', async (original) => ({
  ...(await original<typeof import('$lib/frameleaf/photography/workflow-api')>()),
  loadWorkflowSummaries: vi.fn(),
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

const open = async () => {
  render(PhotographyWorkspace);
  await fireEvent.click(await screen.findByRole('button', { name: /Harbour portraits/ }));
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

  it('calls it a shoot everywhere, with one name per shoot section once a shoot is open', async () => {
    render(PhotographyWorkspace);
    expect(await screen.findByRole('button', { name: 'New shoot' })).toBeInTheDocument();
    expect(screen.queryByText(/project/i)).toBeNull();
    const rail = screen.getByRole('navigation', { name: 'Photography workspace' });
    // a shoot's sections are not offered until a shoot is open
    expect(within(rail).queryByRole('button', { name: 'Selections & delivery' })).toBeNull();
    const card = await screen.findByRole('button', { name: /Harbour portraits/ });
    expect(screen.queryByText(/project/i)).toBeNull();
    await fireEvent.click(card);
    for (const name of ['Photos', 'Intake & assembly', 'Client workflow', 'Selections & delivery', 'Presentation']) {
      expect(await within(rail).findByRole('button', { name })).toBeInTheDocument();
    }
    expect(within(rail).getByRole('button', { name: 'Publish & invite' })).toBeInTheDocument();
    expect(screen.queryByText(/project/i)).toBeNull();
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
