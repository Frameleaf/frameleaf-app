import { bulkTagAssets, getAllTags, getAssetInfo, untagAssets, upsertTags, type TagResponseDto } from '@frameleaf/sdk';
import '@testing-library/jest-dom';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { assetViewerManager } from '$lib/managers/asset-viewer-manager.svelte';
import { authManager } from '$lib/managers/auth-manager.svelte';
import { deferredPromise } from '@test-data/deferred';
import { assetFactory } from '@test-data/factories/asset-factory';
import DetailPanelTags from './DetailPanelTags.svelte';

vi.mock('@frameleaf/sdk', async () => {
  const sdk = await vi.importActual<typeof import('@frameleaf/sdk')>('@frameleaf/sdk');
  return {
    ...sdk,
    getAllTags: vi.fn(),
    upsertTags: vi.fn(),
    bulkTagAssets: vi.fn(),
    untagAssets: vi.fn(),
    getAssetInfo: vi.fn(),
  };
});

const tag = (id: string, value: string) =>
  ({ id, value, name: value.split('/').at(-1)!, createdAt: '', updatedAt: '' }) as never;

describe('DetailPanelTags (V-25)', () => {
  beforeEach(() => {
    vi.mocked(getAllTags).mockResolvedValue([tag('t1', 'Trips'), tag('t2', 'Trips/Rockies'), tag('t3', 'Family')]);
  });

  afterEach(() => {
    vi.clearAllMocks();
    assetViewerManager.focusRequest = null;
  });

  it('shows the tags as chips and "No tags yet." when there are none', () => {
    const asset = assetFactory.build({ isTrashed: false, tags: [] });
    render(DetailPanelTags, { asset, isOwner: true });
    expect(screen.getByText('frameleaf_info_no_tags')).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'frameleaf_info_add_tag' })).toBeInTheDocument();
  });

  it('suggests tags as you type and adds the chosen one', async () => {
    const asset = assetFactory.build({ isTrashed: false, tags: [tag('t1', 'Trips')] });
    vi.mocked(getAssetInfo).mockResolvedValue({ ...asset, tags: [tag('t1', 'Trips'), tag('t2', 'Trips/Rockies')] });
    const onAssetRefresh = vi.fn();
    render(DetailPanelTags, { asset, isOwner: true, onAssetRefresh });

    const input = screen.getByRole('combobox', { name: 'frameleaf_info_add_tag' });
    await fireEvent.focus(input);
    await fireEvent.input(input, { target: { value: 'rock' } });
    await waitFor(() => expect(screen.getByRole('option', { name: /Trips\/Rockies/ })).toBeInTheDocument());
    await fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() =>
      expect(bulkTagAssets).toHaveBeenCalledWith({ tagBulkAssetsDto: { tagIds: ['t2'], assetIds: [asset.id] } }),
    );
    await waitFor(() => expect(onAssetRefresh).toHaveBeenCalled());
  });

  it('creates a tag the text does not name, then adds it', async () => {
    const asset = assetFactory.build({ isTrashed: false, tags: [] });
    vi.mocked(upsertTags).mockResolvedValue([tag('new', 'Hiking')]);
    vi.mocked(getAssetInfo).mockResolvedValue(asset);
    render(DetailPanelTags, { asset, isOwner: true });

    const input = screen.getByRole('combobox', { name: 'frameleaf_info_add_tag' });
    await fireEvent.focus(input);
    await fireEvent.input(input, { target: { value: 'Hiking' } });
    await fireEvent.click(await screen.findByRole('option', { name: /frameleaf_info_create_tag/ }));

    await waitFor(() => expect(upsertTags).toHaveBeenCalledWith({ tagUpsertDto: { tags: ['Hiking'] } }));
    await waitFor(() =>
      expect(bulkTagAssets).toHaveBeenCalledWith({ tagBulkAssetsDto: { tagIds: ['new'], assetIds: [asset.id] } }),
    );
  });

  it('removes a tag through untag', async () => {
    const asset = assetFactory.build({ isTrashed: false, tags: [tag('t3', 'Family')] });
    vi.mocked(getAssetInfo).mockResolvedValue({ ...asset, tags: [] });
    render(DetailPanelTags, { asset, isOwner: true });

    await fireEvent.click(screen.getByRole('button', { name: 'frameleaf_info_remove_tag' }));
    await waitFor(() => expect(untagAssets).toHaveBeenCalledWith({ id: 't3', bulkIdsDto: { ids: [asset.id] } }));
  });

  it('is read-only for someone else and hidden when they see no tags', () => {
    const tagged = assetFactory.build({ isTrashed: false, tags: [tag('t3', 'Family')] });
    const { unmount } = render(DetailPanelTags, { asset: tagged, isOwner: false });
    expect(screen.getByText('Family')).toBeInTheDocument();
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'frameleaf_info_remove_tag' })).not.toBeInTheDocument();
    unmount();

    render(DetailPanelTags, { asset: assetFactory.build({ tags: [] }), isOwner: false });
    expect(screen.queryByTestId('detail-panel-tags')).not.toBeInTheDocument();
  });

  it('takes focus when T asks for it (V-15)', async () => {
    const asset = assetFactory.build({ isTrashed: false, tags: [] });
    render(DetailPanelTags, { asset, isOwner: true });
    assetViewerManager.focusRequest = 'tags';
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'frameleaf_info_add_tag' })).toHaveFocus());
    expect(assetViewerManager.focusRequest).toBeNull();
  });
});

it.each(['current', 'replace', 'close', 'session'])(
  'keeps created-tag continuation with its original photo: %s',
  async (change) => {
    const asset = assetFactory.build({ isTrashed: false, tags: [] });
    const replacement = assetFactory.build({ isTrashed: false, tags: [] });
    const pending = deferredPromise<TagResponseDto[]>();
    vi.mocked(getAllTags).mockResolvedValue([]);
    vi.mocked(upsertTags).mockReturnValueOnce(pending.promise);
    vi.mocked(getAssetInfo).mockResolvedValue(asset);
    vi.mocked(bulkTagAssets).mockClear();
    const onAssetRefresh = vi.fn();
    const view = render(DetailPanelTags, { asset, isOwner: true, onAssetRefresh });
    const input = screen.getByRole('combobox');
    await fireEvent.focus(input);
    await fireEvent.input(input, { target: { value: 'Hiking' } });
    await fireEvent.click(await screen.findByRole('option', { name: /frameleaf_info_create_tag/ }));
    await waitFor(() => expect(upsertTags).toHaveBeenCalled());
    if (change === 'replace') await view.rerender({ asset: replacement });
    if (change === 'close') view.unmount();
    if (change === 'session') authManager.reset();
    pending.resolve([tag('new', 'Hiking')]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (change === 'current') {
      expect(bulkTagAssets).toHaveBeenCalledWith({ tagBulkAssetsDto: { tagIds: ['new'], assetIds: [asset.id] } });
      expect(onAssetRefresh).toHaveBeenCalledWith(asset);
    } else {
      expect(bulkTagAssets).not.toHaveBeenCalled();
      expect(onAssetRefresh).not.toHaveBeenCalled();
    }
  },
);

it.each(['current', 'replace', 'return', 'close', 'session'])(
  'publishes a tag refresh only to its owning view: %s',
  async (change) => {
    const asset = assetFactory.build({ isTrashed: false, tags: [tag('old', 'Original')] });
    const replacement = assetFactory.build({ isTrashed: false, tags: [tag('other', 'Replacement')] });
    const updated = { ...asset, tags: [] };
    const pending = deferredPromise<typeof asset>();
    vi.mocked(untagAssets).mockResolvedValueOnce([]);
    vi.mocked(getAssetInfo).mockReturnValueOnce(pending.promise);
    vi.mocked(getAssetInfo).mockClear();
    const onAssetRefresh = vi.fn();
    const view = render(DetailPanelTags, { asset, isOwner: true, onAssetRefresh });
    await fireEvent.click(screen.getByRole('button', { name: 'frameleaf_info_remove_tag' }));
    await waitFor(() => expect(getAssetInfo).toHaveBeenCalledWith({ id: asset.id }));
    if (change === 'replace' || change === 'return') await view.rerender({ asset: replacement });
    if (change === 'return') await view.rerender({ asset });
    if (change === 'close') view.unmount();
    if (change === 'session') authManager.reset();
    pending.resolve(updated);
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (change === 'current') expect(onAssetRefresh).toHaveBeenCalledWith(updated);
    else expect(onAssetRefresh).not.toHaveBeenCalled();
    if (change === 'replace') expect(screen.getByText('Replacement')).toBeInTheDocument();
    if (change === 'return') expect(screen.getByText('Original')).toBeInTheDocument();
  },
);
