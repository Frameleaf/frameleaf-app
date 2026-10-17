import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { render, screen, within } from '@testing-library/svelte';
import PhotographyDevelop from './PhotographyDevelop.svelte';

const api = vi.hoisted(() => ({ loadWorkspace: vi.fn(), loadPhotos: vi.fn(), ratePhoto: vi.fn() }));
vi.mock('$lib/frameleaf/photography/api', () => api);
vi.mock('$lib/frameleaf/develop-api', () => ({
  PREVIEW_DEBOUNCE_MS: 0,
  developFileUrl: () => '/file',
  followDevelop: () => () => {},
  requestDevelopPreview: () => Promise.resolve(null),
}));

const photo = (id: string, fileName: string, rating: number | null = null) => ({
  id,
  fileName,
  rating,
  canRate: true,
  stackCount: 1,
  currentRevisionId: null,
});

describe('PhotographyDevelop', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.loadWorkspace.mockResolvedValue({
      revision: 'r',
      shoots: [{ id: 'shoot-1', name: 'Cabin weekend', albumId: 'album-1' }],
    });
    api.loadPhotos
      .mockResolvedValueOnce({
        nextCursor: 'next',
        photos: [photo('a', 'A.CR3'), photo('b', 'B.JPG'), photo('c', 'C.NEF', -1)],
      })
      .mockResolvedValueOnce({ nextCursor: null, photos: [photo('d', 'D.ARW', 5)] });
    sdkMock.getAssetDevelop.mockImplementation(({ id }) =>
      Promise.resolve({ assetId: id, currentRevisionId: null, revisions: [] }),
    );
    sdkMock.getDevelopPresets.mockResolvedValue([]);
    sdkMock.getAssetInfo.mockResolvedValue({ exifInfo: {} } as never);
  });

  it("opens every RAW photo of the shoot that isn't rejected, across pages", async () => {
    render(PhotographyDevelop, { shootId: 'shoot-1', only: null, onBack: vi.fn(), onProof: vi.fn() });
    const filmstrip = await screen.findByLabelText('frameleaf_develop_filmstrip');
    expect(within(filmstrip).getAllByText(/CR3|ARW|NEF|JPG/).map((node) => node.textContent)).toEqual(['CR3', 'ARW']);
    expect(api.loadPhotos).toHaveBeenNthCalledWith(2, 'shoot-1', 'next');
    expect(screen.getByText('Cabin weekend')).toBeInTheDocument();
  });

  it('opens only the chosen photos when some were chosen', async () => {
    render(PhotographyDevelop, { shootId: 'shoot-1', only: ['d', 'b'], onBack: vi.fn(), onProof: vi.fn() });
    expect(await screen.findByText('D.ARW', { selector: 'h2' })).toBeInTheDocument();
    expect(screen.queryByLabelText('frameleaf_develop_filmstrip')).not.toBeInTheDocument();
  });

  it('says so when the shoot has no RAW photographs', async () => {
    api.loadPhotos.mockReset().mockResolvedValue({ nextCursor: null, photos: [photo('b', 'B.JPG')] });
    render(PhotographyDevelop, { shootId: 'shoot-1', only: null, onBack: vi.fn(), onProof: vi.fn() });
    expect(await screen.findByText('frameleaf_develop_no_raw')).toBeInTheDocument();
  });
});
