import {
  LibraryScope,
  PaletteAlgorithmVersion,
  PaletteRepresentative,
  PaletteStatus,
  ColorTolerance,
  type AssetResponseDto,
} from '@frameleaf/sdk';
import { modalManager } from '@frameleaf/ui';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import LibraryWorkInspector from '$lib/components/frameleaf/LibraryWorkInspector.svelte';
import { authManager } from '$lib/managers/auth-manager.svelte';
import AssetAddToAlbumModal from '$lib/modals/AssetAddToAlbumModal.svelte';
import { albumFactory } from '@test-data/factories/album-factory';
import { timelineAssetFactory } from '@test-data/factories/asset-factory';
import { preferencesFactory } from '@test-data/factories/preferences-factory';
import { userAdminFactory } from '@test-data/factories/user-factory';

const access = vi.hoisted(() => ({ listeners: new Set<() => void>() }));
vi.mock('$lib/frameleaf/library-access', () => ({
  onLibraryAccessChange: (callback: () => void) => {
    access.listeners.add(callback);
    return () => access.listeners.delete(callback);
  },
}));

vi.mock('$lib/utils/handle-error', () => ({ handleError: vi.fn() }));
vi.mock('$lib/frameleaf/icon-catalogue', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/frameleaf/icon-catalogue')>()),
  // The static icon asset is served by Vite, which this component fixture does not start.
  loadIconPaths: async () => ({}),
}));

const detailOf = (id: string, patch: Partial<AssetResponseDto> = {}) =>
  ({
    id,
    ownerId: 'someone-else',
    originalFileName: 'IMG_0042.HEIC',
    width: 4032,
    height: 3024,
    exifInfo: {
      make: 'Apple',
      model: 'iPhone 15 Pro',
      city: 'Vancouver',
      state: 'British Columbia',
      country: 'Canada',
      dateTimeOriginal: '2026-09-20T14:05:00.000Z',
      timeZone: 'UTC',
      rating: null,
    },
    people: [
      { id: 'p1', name: 'Taylor', isHidden: false },
      { id: 'p2', name: '', isHidden: false },
    ],
    tags: [{ id: 't1', value: 'Hikes' }],
    ...patch,
  }) as unknown as AssetResponseDto;

describe('LibraryWorkInspector', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    access.listeners.clear();
    sdkMock.getAssetPalette.mockRejectedValue(new Error('not indexed'));
    sdkMock.getAssetSources.mockResolvedValue([]);
  });

  it('exposes shared palette selection through its own inspector', async () => {
    const asset = timelineAssetFactory.build();
    sdkMock.getAssetInfo.mockResolvedValue(detailOf(asset.id));
    sdkMock.getAssetPalette.mockResolvedValue({
      version: PaletteAlgorithmVersion.$1,
      sourceRevision: 'rev',
      status: PaletteStatus.Ready,
      representative: PaletteRepresentative.Image,
      hasTransparency: false,
      swatches: [{ hex: '#609060', weight: 1, oklab: [0.6, 0.1, 0.05] }],
    });
    const onChooseColor = vi.fn();
    render(LibraryWorkInspector, { asset, onOpen: vi.fn(), onClose: vi.fn(), onChooseColor });
    await fireEvent.click(await screen.findByRole('button', { name: 'frameleaf_boards_colour_swatch' }));
    expect(onChooseColor).toHaveBeenCalledWith({ hex: '#609060', tolerance: ColorTolerance.Normal, minWeight: 0.05 });
    expect(sdkMock.getAssetSources).not.toHaveBeenCalled();
  });
  it('rejects metadata prepared before an access change', async () => {
    const asset = timelineAssetFactory.build();
    let resolve!: (value: AssetResponseDto) => void;
    sdkMock.getAssetInfo.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    sdkMock.getAssetInfo.mockRejectedValue(new Error('revoked'));
    render(LibraryWorkInspector, { asset, onOpen: vi.fn(), onClose: vi.fn() });
    await waitFor(() => expect(sdkMock.getAssetInfo).toHaveBeenCalledOnce());
    for (const listener of access.listeners) {
      listener();
    }
    resolve(detailOf(asset.id, { originalFileName: 'Private project' }));
    expect(await screen.findByText('frameleaf_item_details_unavailable')).toBeInTheDocument();
    expect(screen.queryByText('Private project')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'frameleaf_work_inspector_open' })).toBeDisabled();
  });

  it('shows the selected item’s information from its full record', async () => {
    const asset = timelineAssetFactory.build({ isVideo: true, duration: 12_000 });
    sdkMock.getAssetInfo.mockResolvedValue(detailOf(asset.id));

    render(LibraryWorkInspector, { asset, selectedCount: 1, onOpen: vi.fn(), onClose: vi.fn() });

    expect(await screen.findByRole('heading', { name: 'IMG_0042.HEIC' })).toBeInTheDocument();
    expect(sdkMock.getAssetInfo).toHaveBeenCalledWith(expect.objectContaining({ id: asset.id }));
    // a timeline duration is milliseconds
    expect(screen.getAllByText('0:12').length).toBeGreaterThan(0);
    expect(screen.getByText('4,032 × 3,024')).toBeInTheDocument();
    expect(screen.getByText('Apple iPhone 15 Pro')).toBeInTheDocument();
    expect(screen.getByText('Vancouver, British Columbia, Canada')).toBeInTheDocument();
    // an unnamed person is not listed
    expect(screen.getByText('Taylor')).toBeInTheDocument();
    expect(screen.getByText('Hikes')).toBeInTheDocument();
    // someone else's item offers no rating
    expect(screen.queryByRole('group', { name: 'rating' })).not.toBeInTheDocument();
  });

  it('opens the item from its preview and closes the panel from its heading', async () => {
    const asset = timelineAssetFactory.build();
    sdkMock.getAssetInfo.mockResolvedValue(detailOf(asset.id));
    const onOpen = vi.fn();
    const onClose = vi.fn();

    render(LibraryWorkInspector, { asset, selectedCount: 1, onOpen, onClose });

    await screen.findByRole('heading', { name: 'IMG_0042.HEIC' });
    await fireEvent.click(screen.getByRole('button', { name: 'frameleaf_work_inspector_open' }));
    await fireEvent.click(screen.getByRole('button', { name: 'frameleaf_work_inspector_close' }));

    expect(onOpen).toHaveBeenCalledWith(asset);
    expect(onClose).toHaveBeenCalled();
  });

  it('lists the item’s people on the People tab', async () => {
    const asset = timelineAssetFactory.build();
    sdkMock.getAssetInfo.mockResolvedValue(detailOf(asset.id, { people: [] }));

    render(LibraryWorkInspector, { asset, selectedCount: 1, onOpen: vi.fn(), onClose: vi.fn() });
    await screen.findByRole('heading', { name: 'IMG_0042.HEIC' });
    await fireEvent.click(screen.getByRole('tab', { name: 'people' }));

    expect(screen.getByRole('tab', { name: 'people' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('frameleaf_work_inspector_no_people')).toBeInTheDocument();
  });

  it('asks for a selection when nothing is selected', () => {
    render(LibraryWorkInspector, { asset: null, selectedCount: 0, onOpen: vi.fn(), onClose: vi.fn() });

    expect(screen.getByText('frameleaf_work_inspector_empty')).toBeInTheDocument();
    expect(sdkMock.getAssetInfo).not.toHaveBeenCalled();
  });

  it('moves keyboard focus and selection together between the Info and People tabs (FL-139)', async () => {
    const user = userEvent.setup();
    const asset = timelineAssetFactory.build();
    sdkMock.getAssetInfo.mockResolvedValue(detailOf(asset.id, { people: [] }));
    render(LibraryWorkInspector, { asset, selectedCount: 1, onOpen: vi.fn(), onClose: vi.fn() });
    await screen.findByRole('heading', { name: 'IMG_0042.HEIC' });
    const info = screen.getByRole('tab', { name: 'frameleaf_work_inspector_tab_info' });
    const people = screen.getByRole('tab', { name: 'people' });
    const panel = screen.getByRole('tabpanel', { name: 'frameleaf_work_inspector_tab_info' });
    expect(info).toHaveAttribute('tabindex', '0');
    expect(people).toHaveAttribute('tabindex', '-1');
    expect(info).toHaveAttribute('aria-controls', panel.id);
    info.focus();

    await fireEvent.keyDown(info, { key: 'ArrowRight' });
    expect(people).toHaveFocus();
    expect(people).toHaveAttribute('aria-selected', 'true');
    expect(people).toHaveAttribute('tabindex', '0');
    expect(info).toHaveAttribute('tabindex', '-1');
    expect(screen.getByRole('tabpanel', { name: 'people' })).toHaveTextContent('frameleaf_work_inspector_no_people');

    await fireEvent.keyDown(people, { key: 'ArrowRight' });
    expect(info).toHaveFocus();
    await fireEvent.keyDown(info, { key: 'ArrowLeft' });
    expect(people).toHaveFocus();
    await fireEvent.keyDown(people, { key: 'Home' });
    expect(info).toHaveFocus();
    await fireEvent.keyDown(info, { key: 'End' });
    expect(people).toHaveFocus();
    expect(people).toHaveAttribute('aria-controls', panel.id);
    expect(panel).toHaveAttribute('aria-labelledby', people.id);
    expect(panel).toHaveAttribute('tabindex', '0');
    await user.tab();
    expect(panel).toHaveFocus();
    await user.tab({ shift: true });
    expect(people).toHaveFocus();
  });

  it('keeps the newest selection when an older answer arrives late', async () => {
    const first = timelineAssetFactory.build();
    const second = timelineAssetFactory.build();
    let answerFirst!: (value: AssetResponseDto) => void;
    sdkMock.getAssetInfo.mockImplementation(({ id }) =>
      id === first.id
        ? new Promise((resolve) => (answerFirst = resolve))
        : Promise.resolve(detailOf(second.id, { originalFileName: 'second.jpg' })),
    );

    const view = render(LibraryWorkInspector, { asset: first, selectedCount: 1, onOpen: vi.fn(), onClose: vi.fn() });
    await view.rerender({ asset: second, selectedCount: 1, onOpen: vi.fn(), onClose: vi.fn() });
    await screen.findByRole('heading', { name: 'second.jpg' });
    answerFirst(detailOf(first.id, { originalFileName: 'first.jpg' }));

    await waitFor(() => expect(screen.getByRole('heading', { name: 'second.jpg' })).toBeInTheDocument());
    expect(screen.queryByRole('heading', { name: 'first.jpg' })).not.toBeInTheDocument();
  });

  describe('in Boards', () => {
    const owner = userAdminFactory.build();
    const boardsDetail = (id: string, patch: Partial<AssetResponseDto> = {}) =>
      detailOf(id, {
        ownerId: owner.id,
        libraryScope: LibraryScope.Design,
        originalMimeType: 'image/png',
        people: [],
        tags: [{ id: 't1', value: 'texture' }] as AssetResponseDto['tags'],
        exifInfo: { description: 'Warm light', rating: null },
        ...patch,
      });

    beforeEach(() => {
      authManager.setUser(owner);
      authManager.setPreferences(preferencesFactory.build());
      sdkMock.getAllAlbums.mockResolvedValue([]);
      sdkMock.updateAsset.mockResolvedValue({} as AssetResponseDto);
    });

    it('shows the Boards details without tabs, in the prototype’s order', async () => {
      const asset = timelineAssetFactory.build();
      sdkMock.getAssetInfo.mockResolvedValue(boardsDetail(asset.id));
      render(LibraryWorkInspector, { asset, onOpen: vi.fn(), onClose: vi.fn() });

      expect(await screen.findByRole('switch', { name: 'frameleaf_boards_scope' })).toHaveAttribute(
        'aria-checked',
        'false',
      );
      expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
      // the Boards-only sections load on demand
      await screen.findByRole('textbox', { name: 'frameleaf_boards_note' });
      const headings = screen.getAllByRole('heading', { level: 3 }).map((heading) => heading.textContent);
      expect(headings).toEqual([
        'frameleaf_boards_colours',
        'rating',
        'tags',
        'frameleaf_boards_note',
        'frameleaf_boards_collections',
        'frameleaf_boards_source',
        'frameleaf_boards_file',
      ]);
      expect(screen.getByText('frameleaf_boards_scope_off')).toBeInTheDocument();
      expect(screen.getByText('image/png')).toBeInTheDocument();
      expect(await screen.findByRole('textbox', { name: 'frameleaf_boards_note' })).toHaveValue('Warm light');
    });

    it('keeps the Photos layout for Photos items unless Boards asks for its own', async () => {
      const asset = timelineAssetFactory.build();
      sdkMock.getAssetInfo.mockResolvedValue(boardsDetail(asset.id, { libraryScope: LibraryScope.Both }));
      const view = render(LibraryWorkInspector, { asset, onOpen: vi.fn(), onClose: vi.fn() });
      expect(await screen.findByRole('tablist')).toBeInTheDocument();
      expect(screen.queryByRole('switch')).not.toBeInTheDocument();

      await view.rerender({ asset, onOpen: vi.fn(), onClose: vi.fn(), boards: true });
      expect(await screen.findByRole('switch', { name: 'frameleaf_boards_scope' })).toHaveAttribute(
        'aria-checked',
        'true',
      );
      expect(screen.getByText('frameleaf_boards_scope_on')).toBeInTheDocument();
    });

    it('writes the library scope from “Show in Photos too” and offers Retry when it fails', async () => {
      const asset = timelineAssetFactory.build();
      sdkMock.getAssetInfo.mockResolvedValue(boardsDetail(asset.id));
      sdkMock.updateAsset.mockRejectedValueOnce(new Error('offline'));
      render(LibraryWorkInspector, { asset, onOpen: vi.fn(), onClose: vi.fn() });

      const toggle = await screen.findByRole('switch', { name: 'frameleaf_boards_scope' });
      await fireEvent.click(toggle);
      expect(sdkMock.updateAsset).toHaveBeenCalledWith({ id: asset.id, updateAssetDto: { libraryScope: 'both' } });
      expect(await screen.findByText('frameleaf_boards_scope_failed')).toBeInTheDocument();
      expect(toggle).toHaveAttribute('aria-checked', 'false');

      await fireEvent.click(screen.getByRole('button', { name: /retry|try/i }));
      await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'true'));
      expect(sdkMock.updateAsset).toHaveBeenCalledTimes(2);
      expect(screen.getByText('frameleaf_boards_scope_on')).toBeInTheDocument();
      expect(screen.queryByText('frameleaf_boards_scope_failed')).not.toBeInTheDocument();
      // the layout stays Boards after the item also shows in Photos
      expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
    });

    it('rejects a file with the thumbs-down before the stars', async () => {
      const asset = timelineAssetFactory.build();
      sdkMock.getAssetInfo.mockResolvedValue(boardsDetail(asset.id));
      render(LibraryWorkInspector, { asset, onOpen: vi.fn(), onClose: vi.fn() });

      const group = await screen.findByRole('group', { name: 'rating' });
      const buttons = within(group).getAllByRole('button');
      expect(buttons[0]).toHaveAccessibleName('frameleaf_library_rating_rejected');
      await fireEvent.click(buttons[0]);
      expect(sdkMock.updateAsset).toHaveBeenCalledWith({ id: asset.id, updateAssetDto: { rating: -1 } });
      expect(buttons[0]).toHaveAttribute('aria-pressed', 'true');
      await waitFor(() => expect(buttons[0]).not.toBeDisabled());
      await fireEvent.click(buttons[0]);
      expect(sdkMock.updateAsset).toHaveBeenLastCalledWith({ id: asset.id, updateAssetDto: { rating: null } });
    });

    it('saves the note when the field loses focus', async () => {
      const asset = timelineAssetFactory.build();
      sdkMock.getAssetInfo.mockResolvedValue(boardsDetail(asset.id));
      render(LibraryWorkInspector, { asset, onOpen: vi.fn(), onClose: vi.fn() });

      const note = await screen.findByRole('textbox', { name: 'frameleaf_boards_note' });
      await fireEvent.blur(note);
      expect(sdkMock.updateAsset).not.toHaveBeenCalled();
      await fireEvent.input(note, { target: { value: 'Use for the hero' } });
      await fireEvent.blur(note);
      expect(sdkMock.updateAsset).toHaveBeenCalledWith({
        id: asset.id,
        updateAssetDto: { description: 'Use for the hero' },
      });
    });

    it('shows the item’s collections as paths with their icon colour', async () => {
      const asset = timelineAssetFactory.build();
      sdkMock.getAssetInfo.mockResolvedValue(boardsDetail(asset.id));
      const parent = albumFactory.build({ albumName: 'Brand refresh 2027', parentId: null, color: 'green' });
      const child = albumFactory.build({ albumName: 'Moodboards', parentId: parent.id, color: 'amber' });
      sdkMock.getAllAlbums.mockResolvedValue([child]);
      sdkMock.getAlbumTree.mockResolvedValue({ albums: [parent, child], collections: [], spaces: [] });
      render(LibraryWorkInspector, { asset, onOpen: vi.fn(), onClose: vi.fn() });

      const link = await screen.findByRole('link', { name: 'Brand refresh 2027 › Moodboards' });
      expect(link).toHaveAttribute('href', `/albums/${child.id}`);
      expect(link.querySelector<HTMLElement>('.mark')!.style.color).toBe('#d9a441');
      expect(sdkMock.getAllAlbums).toHaveBeenCalledWith({ assetId: asset.id }, expect.anything());

      const show = vi.spyOn(modalManager, 'show').mockResolvedValue(undefined as never);
      await fireEvent.click(screen.getByRole('button', { name: 'add_to' }));
      expect(show).toHaveBeenCalledWith(AssetAddToAlbumModal, { assetIds: [asset.id] });
      // the item's collections are read again once the picker closes
      await waitFor(() => expect(sdkMock.getAllAlbums).toHaveBeenCalledTimes(2));
      show.mockRestore();
    });

    it('shows someone else’s item read-only', async () => {
      const asset = timelineAssetFactory.build();
      sdkMock.getAssetInfo.mockResolvedValue(boardsDetail(asset.id, { ownerId: 'someone-else' }));
      render(LibraryWorkInspector, { asset, onOpen: vi.fn(), onClose: vi.fn() });

      expect(await screen.findByText('texture')).toBeInTheDocument();
      expect(screen.getByText('Warm light')).toBeInTheDocument();
      expect(screen.queryByRole('switch')).not.toBeInTheDocument();
      expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
      expect(screen.queryByRole('group', { name: 'rating' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'add_to' })).not.toBeInTheDocument();
      expect(sdkMock.getAssetSources).not.toHaveBeenCalled();
    });
  });
});
