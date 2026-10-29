import {
  AssetAnnotationKind,
  AssetTypeEnum,
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
import { acquireAnnotations, resetAnnotationsRegistry } from '$lib/frameleaf/boards-annotations-store.svelte';
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
    resetAnnotationsRegistry();
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
      await waitFor(() =>
        expect(screen.getAllByRole('heading', { level: 3 }).map((heading) => heading.textContent)).toEqual([
          'frameleaf_boards_colours',
          'rating',
          'tags',
          'frameleaf_boards_note',
          'frameleaf_boards_collections',
          'frameleaf_boards_source',
          'frameleaf_boards_file',
        ]),
      );
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

    describe('annotations', () => {
      const items = [
        {
          id: 'a1',
          kind: AssetAnnotationKind.Rect,
          geometry: { x: 0.05, y: 0.27, width: 0.45, height: 0.2 },
          note: 'Headline runs to three lines on a phone.',
        },
        { id: 'a2', kind: AssetAnnotationKind.Arrow, geometry: { x: 0.36, y: 0.66, endX: 0.2, endY: 0.56 } },
      ];
      const document = (patch = {}) =>
        ({
          version: 1,
          sourceRevision: 'rev',
          sourceChanged: false,
          canEdit: true,
          items,
          updatedAt: null,
          ...patch,
        }) as never;
      const picture = (id: string) => boardsDetail(id, { type: AssetTypeEnum.Image });

      it('lists them under the name with the switch, and highlights the chosen one on the preview', async () => {
        const asset = timelineAssetFactory.build();
        sdkMock.getAssetInfo.mockResolvedValue(picture(asset.id));
        sdkMock.getAssetAnnotations.mockResolvedValue(document());
        render(LibraryWorkInspector, { asset, onOpen: vi.fn(), onClose: vi.fn(), boards: true });

        const section = await screen.findByTestId('boards-annotations');
        expect(
          within(section).getByRole('heading', { name: 'frameleaf_boards_annotations_count' }),
        ).toBeInTheDocument();
        expect(within(section).getByRole('button', { name: /frameleaf_boards_annotate$/ })).toBeInTheDocument();
        expect(within(section).getAllByRole('listitem')).toHaveLength(2);
        expect(within(section).getByText('frameleaf_boards_annotations_kept')).toBeInTheDocument();
        expect(sdkMock.getAssetAnnotations).toHaveBeenCalledWith(expect.objectContaining({ id: asset.id }));

        // the drawing on the preview is hidden from screen readers: the list is the way in
        const preview = await screen.findByTestId('boards-annotated-image');
        expect(preview.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
        expect(preview.querySelectorAll('.ann')).toHaveLength(2);

        const [first] = within(section).getAllByRole('button', { name: 'frameleaf_boards_annotation_label' });
        await fireEvent.click(first);
        expect(first).toHaveAttribute('aria-pressed', 'true');
        await waitFor(() => expect(preview.querySelector('.ann.on')).not.toBeNull());

        await fireEvent.click(
          within(section).getByRole('switch', { name: 'frameleaf_boards_annotations_show_on_picture' }),
        );
        await waitFor(() => expect(preview.querySelector('svg')).toBeNull());
        // the list stays when they are hidden
        expect(within(section).getAllByRole('listitem')).toHaveLength(2);
      });

      it('shows a save that failed after the viewer closed, with Retry', async () => {
        const asset = timelineAssetFactory.build();
        sdkMock.getAssetInfo.mockResolvedValue(picture(asset.id));
        sdkMock.getAssetAnnotations.mockResolvedValue(document());
        sdkMock.replaceAssetAnnotations.mockRejectedValueOnce(new Error('offline')).mockResolvedValue({} as never);
        render(LibraryWorkInspector, { asset, onOpen: vi.fn(), onClose: vi.fn(), boards: true });

        await fireEvent.click(await screen.findByRole('button', { name: 'frameleaf_boards_viewer_view_large_name' }));
        const viewer = await screen.findByTestId('boards-viewer');
        await fireEvent.click(within(viewer).getByRole('button', { name: /frameleaf_boards_annotate$/ }));
        await fireEvent.click(screen.getAllByRole('button', { name: 'frameleaf_boards_annotation_delete_number' })[0]);
        await fireEvent.click(screen.getByRole('button', { name: 'frameleaf_boards_viewer_close' }));
        await waitFor(() => expect(screen.queryByTestId('boards-viewer')).not.toBeInTheDocument());

        const section = await screen.findByTestId('boards-annotations');
        expect(await within(section).findByText('frameleaf_boards_annotations_save_failed')).toBeInTheDocument();
        await fireEvent.click(within(section).getByRole('button', { name: /retry|try/i }));
        await waitFor(() => expect(sdkMock.replaceAssetAnnotations).toHaveBeenCalledTimes(2));
        expect(
          sdkMock.replaceAssetAnnotations.mock.lastCall?.[0].assetAnnotationsUpdateDto.items.map(({ id }) => id),
        ).toEqual(['a2']);
        await waitFor(() =>
          expect(within(section).queryByText('frameleaf_boards_annotations_save_failed')).not.toBeInTheDocument(),
        );
      });

      it('keeps an unsaved change across moving to another picture and back, with Retry', async () => {
        const a = timelineAssetFactory.build();
        const b = timelineAssetFactory.build();
        sdkMock.getAssetInfo.mockImplementation(({ id }) => Promise.resolve(picture(id)));
        sdkMock.getAssetAnnotations.mockImplementation(({ id }) =>
          Promise.resolve(id === a.id ? document() : document({ items: [] })),
        );
        // saving fails until the person presses Retry
        let online = false;
        sdkMock.replaceAssetAnnotations.mockImplementation(() =>
          online ? Promise.resolve({ sourceRevision: 'rev' } as never) : Promise.reject(new Error('offline')),
        );
        const view = render(LibraryWorkInspector, { asset: a, onOpen: vi.fn(), onClose: vi.fn(), boards: true });

        await fireEvent.click(await screen.findByRole('button', { name: 'frameleaf_boards_viewer_view_large_name' }));
        const viewer = await screen.findByTestId('boards-viewer');
        await fireEvent.click(within(viewer).getByRole('button', { name: /frameleaf_boards_annotate$/ }));
        await fireEvent.click(
          within(viewer).getAllByRole('button', { name: 'frameleaf_boards_annotation_delete_number' })[0],
        );

        // move to B while A's save fails
        await view.rerender({ asset: b, onOpen: vi.fn(), onClose: vi.fn(), boards: true });
        await waitFor(() => expect(sdkMock.replaceAssetAnnotations).toHaveBeenCalled());
        const onB = await screen.findByTestId('boards-annotations');
        expect(within(onB).getByText('frameleaf_boards_annotations_none')).toBeInTheDocument();
        expect(within(onB).queryByText('frameleaf_boards_annotations_save_failed')).not.toBeInTheDocument();

        // back to A: the unsaved change is shown with the notice, and Retry saves it for A
        await view.rerender({ asset: a, onOpen: vi.fn(), onClose: vi.fn(), boards: true });
        const onA = await screen.findByTestId('boards-annotations');
        expect(await within(onA).findByText('frameleaf_boards_annotations_save_failed')).toBeInTheDocument();
        await waitFor(() => expect(within(onA).getAllByRole('listitem')).toHaveLength(1));
        const before = sdkMock.replaceAssetAnnotations.mock.calls.length;
        online = true;
        await fireEvent.click(within(onA).getByRole('button', { name: /retry|try/i }));
        await waitFor(() => expect(sdkMock.replaceAssetAnnotations.mock.calls.length).toBeGreaterThan(before));
        expect(sdkMock.replaceAssetAnnotations.mock.calls.every(([call]) => call.id === a.id)).toBe(true);
        expect(
          sdkMock.replaceAssetAnnotations.mock.lastCall?.[0].assetAnnotationsUpdateDto.items.map(({ id }) => id),
        ).toEqual(['a2']);
        await waitFor(() =>
          expect(within(onA).queryByText('frameleaf_boards_annotations_save_failed')).not.toBeInTheDocument(),
        );
      });

      it('reads the annotations once per selection, and never retries a failed read on its own', async () => {
        // the picture is already registered, as when it is shown again (another view still has it open)
        const asset = timelineAssetFactory.build();
        acquireAnnotations(asset.id);
        sdkMock.getAssetInfo.mockResolvedValue(picture(asset.id));
        sdkMock.getAssetAnnotations.mockResolvedValue(document());
        const view = render(LibraryWorkInspector, { asset, onOpen: vi.fn(), onClose: vi.fn(), boards: true });
        await screen.findByTestId('boards-annotations');
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(sdkMock.getAssetAnnotations).toHaveBeenCalledTimes(1);
        view.unmount();

        const failing = timelineAssetFactory.build();
        acquireAnnotations(failing.id);
        sdkMock.getAssetInfo.mockResolvedValue(picture(failing.id));
        sdkMock.getAssetAnnotations.mockClear();
        sdkMock.getAssetAnnotations.mockRejectedValue(new Error('offline'));
        render(LibraryWorkInspector, { asset: failing, onOpen: vi.fn(), onClose: vi.fn(), boards: true });
        expect(await screen.findByText('frameleaf_boards_annotations_unavailable')).toBeInTheDocument();
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(sdkMock.getAssetAnnotations).toHaveBeenCalledTimes(1);

        // Retry is the person's choice
        sdkMock.getAssetAnnotations.mockResolvedValue(document());
        await fireEvent.click(screen.getByRole('button', { name: /retry|try/i }));
        expect(await screen.findByTestId('boards-annotations')).toBeInTheDocument();
        expect(sdkMock.getAssetAnnotations).toHaveBeenCalledTimes(2);
      });

      it('offers Annotate on an empty picture and opens the Boards viewer from View large', async () => {
        const asset = timelineAssetFactory.build();
        sdkMock.getAssetInfo.mockResolvedValue(picture(asset.id));
        sdkMock.getAssetAnnotations.mockResolvedValue(document({ items: [] }));
        const onOpen = vi.fn();
        render(LibraryWorkInspector, { asset, onOpen, onClose: vi.fn(), boards: true });

        const section = await screen.findByTestId('boards-annotations');
        expect(within(section).getByText('frameleaf_boards_annotations_none')).toBeInTheDocument();
        expect(within(section).queryByRole('switch')).not.toBeInTheDocument();

        await fireEvent.click(screen.getByRole('button', { name: 'frameleaf_boards_viewer_view_large_name' }));
        expect(await screen.findByTestId('boards-viewer')).toBeInTheDocument();
        expect(onOpen).not.toHaveBeenCalled();
      });

      it('shows someone else’s annotations read-only, and nothing when there are none', async () => {
        const asset = timelineAssetFactory.build();
        sdkMock.getAssetInfo.mockResolvedValue(boardsDetail(asset.id, { type: AssetTypeEnum.Image, ownerId: 'other' }));
        sdkMock.getAssetAnnotations.mockResolvedValue(document({ canEdit: false }));
        const view = render(LibraryWorkInspector, { asset, onOpen: vi.fn(), onClose: vi.fn(), boards: true });
        const section = await screen.findByTestId('boards-annotations');
        expect(within(section).queryByRole('button', { name: /frameleaf_boards_annotate$/ })).not.toBeInTheDocument();
        view.unmount();

        sdkMock.getAssetAnnotations.mockResolvedValue(document({ canEdit: false, items: [] }));
        render(LibraryWorkInspector, { asset, onOpen: vi.fn(), onClose: vi.fn(), boards: true });
        await screen.findByRole('heading', { name: 'frameleaf_boards_file' });
        await waitFor(() => expect(sdkMock.getAssetAnnotations).toHaveBeenCalledTimes(2));
        expect(screen.queryByTestId('boards-annotations')).not.toBeInTheDocument();
      });

      it('leaves videos and Photos items without annotations', async () => {
        const asset = timelineAssetFactory.build();
        sdkMock.getAssetInfo.mockResolvedValue(boardsDetail(asset.id, { type: AssetTypeEnum.Video }));
        render(LibraryWorkInspector, { asset, onOpen: vi.fn(), onClose: vi.fn(), boards: true });
        await screen.findByRole('heading', { name: 'frameleaf_boards_file' });
        expect(sdkMock.getAssetAnnotations).not.toHaveBeenCalled();
        expect(screen.queryByTestId('boards-annotated-image')).not.toBeInTheDocument();
      });
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
