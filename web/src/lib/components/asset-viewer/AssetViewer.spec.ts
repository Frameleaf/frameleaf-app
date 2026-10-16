import {
  AssetTypeEnum,
  AssetVisibility,
  deleteAssets,
  getAllAlbums,
  getAssetDevelop,
  getAssetInfo,
  getStack,
  updatePerson,
  removeAssetFromStack,
  getFaces,
  updateAsset,
  type AssetResponseDto,
} from '@frameleaf/sdk';
import { modalManager } from '@frameleaf/ui';
import { fireEvent, screen, waitFor } from '@testing-library/svelte';
import { get } from 'svelte/store';
import { getAnimateMock } from '$lib/__mocks__/animate.mock';
import { getResizeObserverMock } from '$lib/__mocks__/resize-observer.mock';
import {
  clearRender,
  markRenderReady,
  setRenderProgress,
} from '$lib/components/frameleaf/editor/pending-render.svelte';
import { saveEditorContinuity } from '$lib/frameleaf/editor-continuity';
import { resetPlaybackRevisions, setDevelopPlaybackRevision } from '$lib/frameleaf/playback-revision.svelte';
import { assetCacheManager } from '$lib/managers/AssetCacheManager.svelte';
import { assetViewerManager } from '$lib/managers/asset-viewer-manager.svelte';
import { authManager } from '$lib/managers/auth-manager.svelte';
import { eventManager } from '$lib/managers/event-manager.svelte';
import { SlideshowNavigation, SlideshowState, slideshowStore } from '$lib/stores/slideshow.store';
// The application-wide socket subscription the layout loads; the viewer only listens to its events.
import '$lib/stores/websocket';
import { getAssetUrls } from '$lib/utils';
import { renderWithTooltips } from '$tests/helpers';
import { assetFactory } from '@test-data/factories/asset-factory';
import { personFactory } from '@test-data/factories/person-factory';
import { preferencesFactory } from '@test-data/factories/preferences-factory';
import { userAdminFactory } from '@test-data/factories/user-factory';
import { stubFocusVisible } from '@test-data/focus-visible';
import AssetViewer from './AssetViewer.svelte';

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
};

const { socketListeners } = vi.hoisted(() => ({ socketListeners: new Map<string, (...args: unknown[]) => void>() }));
const { app } = vi.hoisted(() => ({ app: { page: { url: new URL('http://localhost/photos'), state: {} } } }));
vi.mock('$app/state', () => ({ page: app.page }));
vi.mock('$app/navigation', async () => ({
  ...(await vi.importActual<typeof import('$app/navigation')>('$app/navigation')),
  replaceState: vi.fn<(url: string | URL, state: App.PageState) => Promise<void>>(async () => {}),
}));
vi.mock('socket.io-client', () => ({
  io: () => {
    const socket = {
      on: (name: string, handler: (...args: unknown[]) => void) => {
        socketListeners.set(name, handler);
        return socket;
      },
      off: vi.fn(),
    };
    return socket;
  },
}));

vi.mock('$lib/components/asset-viewer/VideoWrapperViewer.svelte', async () => {
  const { default: MockText } = await import('@test-data/components/MockText.svelte');
  return { default: MockText };
});

// The photo-sphere viewer loads its image over the network; the gesture tests only need it mounted.
vi.mock('$lib/components/asset-viewer/ImagePanoramaViewer.svelte', async () => {
  const { default: MockText } = await import('@test-data/components/MockText.svelte');
  return { default: MockText };
});

// FL-148: the guard-parity specs only need isFaceEditMode toggled and FaceTagger mounted, not its own
// (heavier) face-loading/canvas behaviour.
vi.mock('$lib/components/frameleaf/FaceTagger.svelte', async () => {
  const { default: MockViewerControls } = await import('@test-data/components/MockViewerControls.svelte');
  return { default: MockViewerControls };
});

// The information card's contents load albums, people and tags; the viewer specs only need the card's frame.
vi.mock('$lib/components/asset-viewer/DetailPanel.svelte', async () => {
  const { default: MockText } = await import('@test-data/components/MockText.svelte');
  return { default: MockText };
});

vi.mock('$lib/components/frameleaf/editor/QuickEditor.svelte', async () => {
  const { default: MockViewerControls } = await import('@test-data/components/MockViewerControls.svelte');
  return { default: MockViewerControls };
});

vi.mock('$lib/managers/feature-flags-manager.svelte', () => ({
  featureFlagsManager: {
    init: vi.fn(),
    loadFeatureFlags: vi.fn(),
    value: { smartSearch: true, trash: true },
  } as never,
}));

vi.mock('$lib/stores/ocr.svelte', () => ({
  ocrManager: {
    clear: vi.fn(),
    getAssetOcr: vi.fn(),
    hasOcrData: false,
    showOverlay: false,
  },
}));

vi.mock('@frameleaf/sdk', async () => {
  const sdk = await vi.importActual<typeof import('@frameleaf/sdk')>('@frameleaf/sdk');
  return {
    ...sdk,
    updateAsset: vi.fn(),
    getFaces: vi.fn().mockResolvedValue([]),
    getAssetInfo: vi.fn(),
    getAssetDevelop: vi.fn().mockResolvedValue({ assetId: 'asset', currentRevisionId: null, revisions: [] }),
    deleteAssets: vi.fn().mockResolvedValue(undefined),
    deleteStacks: vi.fn().mockResolvedValue(undefined),
    removeAssetFromStack: vi.fn(),
    getStack: vi.fn(),
    updatePerson: vi.fn(),
    // The More menu reads the albums that hold the item, for its "Album cover" entry.
    getAllAlbums: vi.fn().mockResolvedValue([]),
  };
});

describe('AssetViewer', () => {
  beforeEach(() => {
    vi.mocked(getAssetDevelop).mockResolvedValue({ assetId: 'asset', currentRevisionId: null, revisions: [] });
    vi.mocked(getFaces).mockResolvedValue([]);
    vi.mocked(getAllAlbums).mockResolvedValue([]);
  });

  beforeAll(() => {
    Element.prototype.animate = getAnimateMock();
    vi.stubGlobal('ResizeObserver', getResizeObserverMock());
  });

  afterEach(() => {
    sessionStorage.clear();
    slideshowStore.slideshowState.set(SlideshowState.None);
    assetCacheManager.invalidate();
    authManager.reset();
    resetPlaybackRevisions();
    vi.clearAllMocks();
  });

  afterAll(() => {
    vi.restoreAllMocks();
  });

  describe('slideshow continuation ownership', () => {
    const prepare = () => {
      const user = userAdminFactory.build();
      const asset = assetFactory.build({ ownerId: user.id, type: AssetTypeEnum.Image });
      authManager.setUser(user);
      authManager.setPreferences(preferencesFactory.build({ cast: { gCastEnabled: false } }));
      assetViewerManager.setAsset(asset);
      slideshowStore.slideshowAutoplay.set(true);
      slideshowStore.slideshowRepeat.set(false);
      slideshowStore.slideshowDelay.set(60);
      onTestFinished(() => {
        slideshowStore.slideshowDelay.set(5);
        slideshowStore.slideshowRepeat.set(false);
      });
      return asset;
    };
    // VIEWER-P1: the slideshow keeps the viewer's chrome instead of a floating capsule. Its progress line
    // says it is running, and the arrow keys step it (SlideshowBar), as the capsule's buttons did.
    const slideshowStarted = (view: { findByTestId: (id: string) => Promise<HTMLElement> }) =>
      view.findByTestId('slideshow-progress');
    const step = (order: 'next' | 'previous') =>
      fireEvent.keyDown(document, { key: order === 'next' ? 'ArrowRight' : 'ArrowLeft' });

    it('does not stop a replacement slideshow after an old random callback finishes', async () => {
      const asset = prepare();
      const pending = deferred<{ id: string } | undefined>();
      const onRandom = vi.fn().mockReturnValue(pending.promise);
      slideshowStore.slideshowNavigation.set(SlideshowNavigation.Shuffle);
      const view = renderWithTooltips(AssetViewer, { cursor: { current: asset }, showNavigation: true, onRandom });
      slideshowStore.slideshowState.set(SlideshowState.PlaySlideshow);
      await slideshowStarted(view);
      await step('next');
      await waitFor(() => expect(onRandom).toHaveBeenCalledOnce());
      view.unmount();
      slideshowStore.slideshowState.set(SlideshowState.PlaySlideshow);
      pending.resolve(undefined);
      await pending.promise;
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(get(slideshowStore.slideshowState)).toBe(SlideshowState.PlaySlideshow);
    });

    it('does not end a new run when an old fullscreen exit completes', async () => {
      const asset = prepare();
      const pending = deferred<void>();
      const exit = vi.fn().mockReturnValue(pending.promise);
      const previousExit = document.exitFullscreen;
      const previousElement = Object.getOwnPropertyDescriptor(document, 'fullscreenElement');
      document.exitFullscreen = exit;
      const view = renderWithTooltips(AssetViewer, { cursor: { current: asset }, showNavigation: false });
      Object.defineProperty(document, 'fullscreenElement', { configurable: true, value: view.container });
      onTestFinished(() => {
        document.exitFullscreen = previousExit;
        if (previousElement) {
          Object.defineProperty(document, 'fullscreenElement', previousElement);
        } else {
          Reflect.deleteProperty(document, 'fullscreenElement');
        }
      });
      slideshowStore.slideshowState.set(SlideshowState.PlaySlideshow);
      slideshowStore.slideshowState.set(SlideshowState.StopSlideshow);
      expect(exit).toHaveBeenCalledOnce();
      slideshowStore.slideshowState.set(SlideshowState.PlaySlideshow);
      pending.resolve(undefined);
      await pending.promise;
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(get(slideshowStore.slideshowState)).toBe(SlideshowState.PlaySlideshow);
    });

    it.each([
      { kind: 'history', retired: true },
      { kind: 'repeat', retired: true },
      { kind: 'history', retired: false },
      { kind: 'repeat', retired: false },
    ] as const)('owns the $kind load completion (retired: $retired)', async ({ kind, retired }) => {
      const asset = prepare();
      const next = assetFactory.build({ ownerId: asset.ownerId, type: AssetTypeEnum.Image });
      const pending = deferred<AssetResponseDto>();
      const restart = vi.fn();
      const unsubscribe = slideshowStore.restartProgress.subscribe((value) => {
        if (value) {
          restart();
        }
      });
      onTestFinished(unsubscribe);
      vi.mocked(getAssetInfo).mockReset().mockReturnValueOnce(pending.promise);
      const onRandom = vi.fn().mockResolvedValue({ id: next.id });
      slideshowStore.slideshowNavigation.set(
        kind === 'history' ? SlideshowNavigation.Shuffle : SlideshowNavigation.DescendingOrder,
      );
      slideshowStore.slideshowRepeat.set(kind === 'repeat');
      const view = renderWithTooltips(AssetViewer, {
        cursor: { current: asset, nextAsset: null, previousAsset: null },
        showNavigation: true,
        onRandom,
      });
      slideshowStore.slideshowState.set(SlideshowState.PlaySlideshow);
      await slideshowStarted(view);
      if (kind === 'history') {
        await step('next');
        await waitFor(() => expect(onRandom).toHaveBeenCalledOnce());
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      await step(kind === 'history' ? 'previous' : 'next');
      await waitFor(() => expect(getAssetInfo).toHaveBeenCalledOnce());
      restart.mockClear();
      if (retired) {
        assetViewerManager.showAssetViewer(false);
        view.unmount();
      }
      pending.resolve(asset);
      await pending.promise;
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(restart).toHaveBeenCalledTimes(retired ? 0 : 1);
    });
    it('keeps a successful random navigation eligible after its asset ID changes', async () => {
      const asset = prepare();
      const target = assetFactory.build({ ownerId: asset.ownerId, type: AssetTypeEnum.Image });
      const onRandom = vi.fn<() => Promise<{ id: string }>>();
      slideshowStore.slideshowNavigation.set(SlideshowNavigation.Shuffle);
      const view = renderWithTooltips(AssetViewer, { cursor: { current: asset }, showNavigation: true, onRandom });
      onRandom.mockImplementation(async () => {
        assetViewerManager.setAsset(target);
        await view.rerender({ componentProps: { cursor: { current: target }, showNavigation: true, onRandom } });
        return { id: target.id };
      });
      slideshowStore.slideshowState.set(SlideshowState.PlaySlideshow);
      await slideshowStarted(view);
      const restart = vi.fn();
      const unsubscribe = slideshowStore.restartProgress.subscribe((value) => {
        if (value) {
          restart();
        }
      });
      onTestFinished(unsubscribe);
      await step('next');
      await waitFor(() => expect(restart).toHaveBeenCalledOnce());
      expect(get(slideshowStore.slideshowState)).toBe(SlideshowState.PlaySlideshow);
    });
  });

  it.each(['remove', 'keep'])('ignores a late stack %s in a replacement viewer selection', async (kind) => {
    const user = userAdminFactory.build();
    authManager.setUser(user);
    authManager.setPreferences(preferencesFactory.build({ cast: { gCastEnabled: false } }));
    const [primary, original, other, replacement] = assetFactory.buildList(4, { ownerId: user.id });
    original.stack = { id: 'stack', primaryAssetId: primary.id, assetCount: 3 };
    const stack = { id: 'stack', primaryAssetId: primary.id, assets: [primary, original, other] };
    vi.mocked(getStack).mockResolvedValue(stack);
    const removal = deferred<void>();
    const confirmation = deferred<boolean>();
    vi.mocked(removeAssetFromStack).mockReturnValue(removal.promise as ReturnType<typeof removeAssetFromStack>);
    const dialog = vi.spyOn(modalManager, 'showDialog').mockReturnValue(confirmation.promise);
    const onClose = vi.fn();
    const onAction = vi.fn();
    try {
      const props = { cursor: { current: original }, withStacked: true, showNavigation: false, onClose, onAction };
      const view = renderWithTooltips(AssetViewer, props);
      await screen.findByTestId('viewer-stack-strip');
      // VIEWER-P3: both stack decisions are in the ⋯ menu; the stack card only shows the members.
      await fireEvent.click(screen.getByRole('button', { name: 'frameleaf_viewer_more_actions' }));
      await fireEvent.click(
        screen.getByRole('menuitem', {
          name: kind === 'keep' ? 'frameleaf_viewer_menu_keep_this' : 'frameleaf_viewer_menu_remove_from_stack',
        }),
      );
      await view.rerender({ componentProps: { ...props, cursor: { current: replacement } } });
      confirmation.resolve(true);
      removal.resolve();
      await waitFor(() => expect(onAction).toHaveBeenCalled());
      expect(onClose).not.toHaveBeenCalled();
      expect(document.querySelector('#immich-asset-viewer')).toHaveAttribute('data-asset-id', replacement.id);
    } finally {
      dialog.mockRestore();
    }
  });

  it.each(['replace', 'close', 'session'])('ignores an editor refresh after %s', async (change) => {
    const user = userAdminFactory.build();
    authManager.setUser(user);
    authManager.setPreferences(preferencesFactory.build({ cast: { gCastEnabled: false } }));
    const [original, replacement] = assetFactory.buildList(2, { ownerId: user.id });
    const pending = deferred<AssetResponseDto>();
    vi.mocked(getAssetInfo).mockReturnValueOnce(pending.promise);
    assetViewerManager.isShowEditor = true;
    const onAssetChange = vi.fn();
    const props = { cursor: { current: original }, showNavigation: false, onAssetChange };
    const view = renderWithTooltips(AssetViewer, props);
    await fireEvent.click(view.getByRole('button', { name: 'Save video edits' }));
    await waitFor(() => expect(getAssetInfo).toHaveBeenCalledWith({ id: original.id }));
    if (change === 'replace') {
      await view.rerender({ componentProps: { ...props, cursor: { current: replacement } } });
    } else if (change === 'close') {
      view.unmount();
    } else {
      authManager.reset();
    }
    pending.resolve({ ...original, isEdited: true });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onAssetChange).not.toHaveBeenCalled();
  });

  it('ignores a face refresh after the viewer moves to another asset', async () => {
    const user = userAdminFactory.build();
    authManager.setUser(user);
    authManager.setPreferences(preferencesFactory.build({ cast: { gCastEnabled: false } }));
    const [original, replacement] = assetFactory.buildList(2, { ownerId: user.id });
    const pending = deferred<AssetResponseDto>();
    vi.mocked(getAssetInfo).mockReturnValueOnce(pending.promise);
    assetViewerManager.openFaceEditMode();
    const onAssetChange = vi.fn();
    const props = { cursor: { current: original }, showNavigation: false, onAssetChange };
    const view = renderWithTooltips(AssetViewer, props);
    await fireEvent.click(view.getByRole('button', { name: 'Save face tags' }));
    await waitFor(() => expect(getAssetInfo).toHaveBeenCalledWith({ id: original.id }));
    await view.rerender({ componentProps: { ...props, cursor: { current: replacement } } });
    pending.resolve(original);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onAssetChange).not.toHaveBeenCalled();
  });

  it('keeps the latest stack when an earlier stack lookup finishes last', async () => {
    const user = userAdminFactory.build();
    authManager.setUser(user);
    authManager.setPreferences(preferencesFactory.build({ cast: { gCastEnabled: false } }));
    const [original, replacement] = assetFactory.buildList(2, { ownerId: user.id });
    original.stack = { id: 'old-stack', primaryAssetId: original.id, assetCount: 1 };
    replacement.stack = { id: 'new-stack', primaryAssetId: replacement.id, assetCount: 1 };
    const oldStack = deferred<Awaited<ReturnType<typeof getStack>>>();
    vi.mocked(getStack)
      .mockReturnValueOnce(oldStack.promise)
      .mockResolvedValue({
        id: 'new-stack',
        primaryAssetId: replacement.id,
        assets: [replacement],
      });
    const props = { cursor: { current: original }, withStacked: true, showNavigation: false };
    const view = renderWithTooltips(AssetViewer, props);
    await waitFor(() => expect(getStack).toHaveBeenCalledWith({ id: 'old-stack' }));
    await view.rerender({ componentProps: { ...props, cursor: { current: replacement } } });
    await screen.findByTestId('viewer-stack-strip');
    oldStack.resolve({ id: 'old-stack', primaryAssetId: original.id, assets: [original] });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.getByTestId('viewer-stack-strip')).toBeInTheDocument();
  });

  it('keeps the stack card while it shows a member that has no stack of its own (VIEWER-P3)', async () => {
    const user = userAdminFactory.build();
    authManager.setUser(user);
    authManager.setPreferences(preferencesFactory.build({ cast: { gCastEnabled: false } }));
    const [primary, member] = assetFactory.buildList(2, { ownerId: user.id });
    primary.stack = { id: 'stack', primaryAssetId: primary.id, assetCount: 2 };
    // the stack's members come back without a stack of their own, as the server maps them
    const shown = { ...member, stack: undefined };
    vi.mocked(getStack).mockResolvedValue({ id: 'stack', primaryAssetId: primary.id, assets: [primary, shown] });
    const props = { cursor: { current: primary }, withStacked: true, showNavigation: false };
    const view = renderWithTooltips(AssetViewer, props);
    await screen.findByTestId('viewer-stack-strip');
    await view.rerender({ componentProps: { ...props, cursor: { current: shown } } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.getByTestId('viewer-stack-strip')).toBeInTheDocument();
    expect(getStack).toHaveBeenCalledTimes(1);
  });

  it('opens a stack member clicked after pointing at it (VIEWER-P3)', async () => {
    const user = userAdminFactory.build();
    authManager.setUser(user);
    authManager.setPreferences(preferencesFactory.build({ cast: { gCastEnabled: false } }));
    const [primary, member] = assetFactory.buildList(2, { ownerId: user.id });
    primary.stack = { id: 'stack', primaryAssetId: primary.id, assetCount: 2 };
    const shown = { ...member, stack: undefined };
    vi.mocked(getStack).mockResolvedValue({ id: 'stack', primaryAssetId: primary.id, assets: [primary, shown] });
    renderWithTooltips(AssetViewer, { cursor: { current: primary }, withStacked: true, showNavigation: false });
    const strip = await screen.findByTestId('viewer-stack-strip');
    const tile = strip.querySelector<HTMLElement>(`[data-asset="${CSS.escape(member.id)}"]`)!;
    // a mouse always points at a tile before it clicks; pointing previews the member
    await fireEvent.mouseEnter(tile);
    await fireEvent.click(tile);
    await fireEvent.mouseLeave(tile);
    await waitFor(() =>
      expect(document.querySelector('#immich-asset-viewer')).toHaveAttribute('data-asset-id', member.id),
    );
    expect(screen.getByTestId('viewer-stack-strip').querySelectorAll('[aria-current="true"]')).toHaveLength(1);
  });

  it.each(['before', 'after'])(
    'keeps a featured-photo refresh owned when navigation occurs %s the lookup',
    async (change) => {
      vi.mocked(getAssetInfo).mockReset();
      const user = userAdminFactory.build();
      authManager.setUser(user);
      authManager.setPreferences(preferencesFactory.build({ cast: { gCastEnabled: false } }));
      const person = personFactory.build({ name: 'Person', isHidden: false });
      const original = assetFactory.build({ ownerId: user.id, type: AssetTypeEnum.Image, people: [person] });
      const replacement = assetFactory.build({ ownerId: user.id, type: AssetTypeEnum.Image, people: [] });
      const update = deferred<typeof person>();
      const lookup = deferred<AssetResponseDto>();
      vi.mocked(updatePerson).mockReturnValueOnce(update.promise);
      if (change === 'before') {
        vi.mocked(getAssetInfo).mockResolvedValueOnce(original);
      } else {
        vi.mocked(getAssetInfo).mockReturnValueOnce(lookup.promise);
      }
      const dialog = vi
        .spyOn(modalManager, 'show')
        .mockImplementation((async () => ({ kind: 'person', person })) as typeof modalManager.show);
      const onAction = vi.fn();
      const onAssetUpdate = vi.fn();
      const props = { cursor: { current: original }, showNavigation: false, onAction, onAssetUpdate };
      const view = renderWithTooltips(AssetViewer, props);
      try {
        await fireEvent.click(screen.getByRole('button', { name: 'frameleaf_viewer_more_actions' }));
        await fireEvent.click(screen.getByRole('menuitem', { name: 'frameleaf_viewer_menu_person_featured' }));
        await waitFor(() => expect(updatePerson).toHaveBeenCalled());
        if (change === 'before') {
          await view.rerender({ componentProps: { ...props, cursor: { current: replacement } } });
        }
        update.resolve(person);
        if (change === 'after') {
          await waitFor(() => expect(getAssetInfo).toHaveBeenCalledWith({ id: original.id }));
          await view.rerender({ componentProps: { ...props, cursor: { current: replacement } } });
          lookup.resolve(original);
        }
        await waitFor(() => expect(onAction).toHaveBeenCalled());
        expect(onAssetUpdate).not.toHaveBeenCalled();
        if (change === 'before') {
          expect(getAssetInfo).not.toHaveBeenCalled();
        }
      } finally {
        update.resolve(person);
        lookup.resolve(original);
        dialog.mockRestore();
      }
    },
  );

  it('notifies the parent when the current asset changes through an event', async () => {
    const user = userAdminFactory.build();
    const asset = assetFactory.build({ ownerId: user.id, type: AssetTypeEnum.Image });
    const onAssetUpdate = vi.fn();
    authManager.setUser(user);
    authManager.setPreferences(preferencesFactory.build({ cast: { gCastEnabled: false } }));
    renderWithTooltips(AssetViewer, { cursor: { current: asset }, showNavigation: false, onAssetUpdate });
    const updated = { ...asset, isFavorite: !asset.isFavorite };
    eventManager.emit('AssetUpdate', updated);
    await waitFor(() => expect(onAssetUpdate).toHaveBeenCalledWith(updated));
    onAssetUpdate.mockClear();
    eventManager.emit('AssetUpdate', { ...updated, id: 'another-asset' });
    expect(onAssetUpdate).not.toHaveBeenCalled();
  });

  it('loads the owner photo current develop revision before selecting its viewer URL', async () => {
    const user = userAdminFactory.build();
    const asset = assetFactory.build({ ownerId: user.id, type: AssetTypeEnum.Image, thumbhash: 'photo-hash' });
    authManager.setUser(user);
    authManager.setPreferences(preferencesFactory.build({ cast: { gCastEnabled: false } }));
    vi.mocked(getAssetDevelop).mockResolvedValue({
      assetId: asset.id,
      currentRevisionId: 'rendered-photo',
      revisions: [],
    });

    renderWithTooltips(AssetViewer, { cursor: { current: asset }, showNavigation: false });

    await waitFor(() => expect(getAssetDevelop).toHaveBeenCalledWith({ id: asset.id }));
    await waitFor(() =>
      expect(new URL(getAssetUrls(asset).preview, 'http://x').searchParams.get('c')).toBe(
        'photo-hash-develop-rendered-photo',
      ),
    );
  });

  it('puts the photo on screen before the develop lookup answers, so the opening zoom has somewhere to land', async () => {
    const user = userAdminFactory.build();
    const asset = assetFactory.build({ ownerId: user.id, type: AssetTypeEnum.Image, thumbhash: null });
    authManager.setUser(user);
    authManager.setPreferences(preferencesFactory.build({ cast: { gCastEnabled: false } }));
    const lookup = deferred<Awaited<ReturnType<typeof getAssetDevelop>>>();
    vi.mocked(getAssetDevelop).mockReturnValue(lookup.promise);

    renderWithTooltips(AssetViewer, { cursor: { current: asset }, showNavigation: false });

    expect(document.querySelector('#immich-asset-viewer [data-viewer-hero]')).toBeInTheDocument();
    await waitFor(() => expect(getAssetDevelop).toHaveBeenCalledWith({ id: asset.id }));
    lookup.resolve({ assetId: asset.id, currentRevisionId: null, revisions: [] });
  });

  it('keeps the photo mounted from one item to the next instead of blanking the canvas', async () => {
    const user = userAdminFactory.build();
    const first = assetFactory.build({ ownerId: user.id, type: AssetTypeEnum.Image, thumbhash: null });
    const second = assetFactory.build({ ownerId: user.id, type: AssetTypeEnum.Image, thumbhash: null });
    authManager.setUser(user);
    authManager.setPreferences(preferencesFactory.build({ cast: { gCastEnabled: false } }));
    const view = renderWithTooltips(AssetViewer, { cursor: { current: first }, showNavigation: false });
    const hero = document.querySelector('#immich-asset-viewer [data-viewer-hero]');
    expect(hero).toBeInTheDocument();

    vi.mocked(getAssetDevelop).mockReturnValue(new Promise(() => {}));
    await view.rerender({ componentProps: { cursor: { current: second }, showNavigation: false } });

    expect(document.querySelector('#immich-asset-viewer [data-viewer-hero]')).toBe(hero);
  });

  it('says on the photo that a saved edit is being finished, then that it is ready', async () => {
    const user = userAdminFactory.build();
    const asset = assetFactory.build({ ownerId: user.id, type: AssetTypeEnum.Image });
    authManager.setUser(user);
    authManager.setPreferences(preferencesFactory.build({ cast: { gCastEnabled: false } }));
    renderWithTooltips(AssetViewer, { cursor: { current: asset }, showNavigation: false });
    expect(screen.queryByTestId('viewer-edit-status')).not.toBeInTheDocument();

    try {
      setRenderProgress(asset.id, 40);
      const status = await screen.findByTestId('viewer-edit-status');
      expect(status).toHaveAttribute('role', 'status');
      expect(status).toHaveTextContent('frameleaf_viewer_edit_finishing_progress');

      markRenderReady(asset.id);
      await waitFor(() =>
        expect(screen.getByTestId('viewer-edit-status')).toHaveTextContent('frameleaf_viewer_edit_ready'),
      );
    } finally {
      clearRender(asset.id);
    }
  });

  it('keeps the information card’s Close above its scrolling details', async () => {
    const user = userAdminFactory.build();
    const asset = assetFactory.build({ ownerId: user.id, type: AssetTypeEnum.Image, hasMetadata: true });
    authManager.setUser(user);
    authManager.setPreferences(preferencesFactory.build({ cast: { gCastEnabled: false } }));
    renderWithTooltips(AssetViewer, { cursor: { current: asset }, showNavigation: false });
    if (!assetViewerManager.isShowDetailPanel) {
      assetViewerManager.toggleDetailPanel();
    }

    const card = await waitFor(() => {
      const element = document.querySelector<HTMLElement>('#detail-panel');
      expect(element).not.toBeNull();
      return element!;
    });
    const head = card.querySelector('header')!;
    const body = card.querySelector('.fl-viewer-info-body')!;
    expect(head.nextElementSibling).toBe(body);
    expect(body.contains(head)).toBe(false);

    await fireEvent.click(head.querySelector('button')!);
    expect(assetViewerManager.isShowDetailPanel).toBe(false);
    await waitFor(() => expect(document.querySelector('#detail-panel')).toBeNull());
  });

  it('keeps both preview and zoom on the media route after a failed develop lookup', async () => {
    const user = userAdminFactory.build();
    const asset = assetFactory.build({
      ownerId: user.id,
      type: AssetTypeEnum.Image,
      originalPath: 'image.jpg',
      originalMimeType: 'image/jpeg',
    });
    authManager.setUser(user);
    authManager.setPreferences(preferencesFactory.build({ cast: { gCastEnabled: false } }));
    vi.mocked(getAssetDevelop).mockRejectedValue(new Error('offline'));
    renderWithTooltips(AssetViewer, { cursor: { current: asset }, showNavigation: false });

    await waitFor(() => expect(getAssetDevelop).toHaveBeenCalledWith({ id: asset.id }));
    await waitFor(() =>
      expect(new URL(getAssetUrls(asset).original, 'http://x').searchParams.get('size')).toBe('fullsize'),
    );
    expect(new URL(getAssetUrls(asset).preview, 'http://x').searchParams.get('size')).toBe('preview');
    expect(new URL(getAssetUrls(asset).original, 'http://x').pathname).toContain(`/${asset.id}/thumbnail`);
  });

  it('drops a render refresh started before navigating A to B and back to A', async () => {
    const user = userAdminFactory.build();
    const first = assetFactory.build({ ownerId: user.id, type: AssetTypeEnum.Image, thumbhash: 'a-hash' });
    const second = assetFactory.build({ ownerId: user.id, type: AssetTypeEnum.Image });
    const late = deferred<AssetResponseDto>();
    authManager.setUser(user);
    authManager.setPreferences(preferencesFactory.build({ cast: { gCastEnabled: false } }));
    assetViewerManager.isShowEditor = true;
    const onAssetChange = vi.fn();
    const view = renderWithTooltips(AssetViewer, {
      cursor: { current: first },
      showNavigation: false,
      onAssetChange,
    });
    await waitFor(() => expect(getAssetDevelop).toHaveBeenCalledTimes(1));
    vi.mocked(getAssetDevelop).mockResolvedValueOnce({
      assetId: first.id,
      currentRevisionId: 'stale-render',
      revisions: [],
    });
    vi.mocked(getAssetInfo).mockReturnValueOnce(late.promise);
    await fireEvent.click(view.getByRole('button', { name: 'Publish photo render' }));
    await waitFor(() => expect(getAssetInfo).toHaveBeenCalledWith({ id: first.id }));

    await view.rerender({ componentProps: { cursor: { current: second }, showNavigation: false, onAssetChange } });
    await waitFor(() => expect(getAssetDevelop).toHaveBeenCalledTimes(3));
    await view.rerender({ componentProps: { cursor: { current: first }, showNavigation: false, onAssetChange } });
    await waitFor(() => expect(getAssetDevelop).toHaveBeenCalledTimes(4));
    late.resolve({ ...first, thumbhash: 'stale-hash' });
    await Promise.resolve();

    expect(onAssetChange).not.toHaveBeenCalled();
    expect(new URL(getAssetUrls(first).preview, 'http://x').searchParams.get('c')).toBe('a-hash');
  });

  it('ignores an older failed refresh after a newer render refresh succeeds for the same photo', async () => {
    const user = userAdminFactory.build();
    const asset = assetFactory.build({ ownerId: user.id, type: AssetTypeEnum.Image, thumbhash: 'photo-hash' });
    const old = deferred<Awaited<ReturnType<typeof getAssetDevelop>>>();
    const published = { ...asset, thumbhash: 'published-hash' };
    authManager.setUser(user);
    authManager.setPreferences(preferencesFactory.build({ cast: { gCastEnabled: false } }));
    assetViewerManager.isShowEditor = true;
    const onAssetChange = vi.fn();
    const view = renderWithTooltips(AssetViewer, { cursor: { current: asset }, showNavigation: false, onAssetChange });
    await waitFor(() => expect(getAssetDevelop).toHaveBeenCalledTimes(1));
    vi.mocked(getAssetDevelop)
      .mockReturnValueOnce(old.promise)
      .mockResolvedValueOnce({ assetId: asset.id, currentRevisionId: 'new-render', revisions: [] });
    vi.mocked(getAssetInfo).mockResolvedValueOnce(published);

    await fireEvent.click(view.getByRole('button', { name: 'Publish photo render' }));
    await waitFor(() => expect(getAssetDevelop).toHaveBeenCalledTimes(2));
    await fireEvent.click(view.getByRole('button', { name: 'Publish photo render' }));
    await waitFor(() => expect(onAssetChange).toHaveBeenCalledExactlyOnceWith(published));
    old.reject(new Error('offline'));
    await Promise.resolve();

    expect(new URL(getAssetUrls(asset).preview, 'http://x').searchParams.get('c')).toBe(
      'photo-hash-develop-new-render',
    );
    expect(onAssetChange).toHaveBeenCalledTimes(1);
  });

  it('removes stored face hotspots when a developed crop becomes the displayed image', async () => {
    const user = userAdminFactory.build();
    const asset = assetFactory.build({ ownerId: user.id, type: AssetTypeEnum.Image });
    authManager.setUser(user);
    authManager.setPreferences(preferencesFactory.build({ cast: { gCastEnabled: false } }));
    vi.mocked(getFaces).mockResolvedValue([
      {
        id: 'face',
        imageWidth: 200,
        imageHeight: 150,
        boundingBoxX1: 20,
        boundingBoxX2: 60,
        boundingBoxY1: 30,
        boundingBoxY2: 80,
        person: { id: 'person', name: 'Someone', isHidden: false },
      } as never,
    ]);
    renderWithTooltips(AssetViewer, { cursor: { current: asset }, showNavigation: false });
    await waitFor(() => expect(screen.getByTestId('face-hotspot')).toBeInTheDocument());

    setDevelopPlaybackRevision(asset.id, 'cropped-version');
    await waitFor(() => expect(screen.queryByTestId('face-hotspot')).not.toBeInTheDocument());
  });

  describe('back from Studio to the quick editor (FL-113)', () => {
    afterEach(() => {
      app.page.url = new URL('http://localhost/photos');
      assetViewerManager.closeEditor();
    });

    it('opens the editor for ?edit=1 on the owner’s item and drops the flag from the address', async () => {
      const user = userAdminFactory.build();
      authManager.setUser(user);
      authManager.setPreferences(preferencesFactory.build({ cast: { gCastEnabled: false } }));
      const asset = assetFactory.build({ ownerId: user.id, type: AssetTypeEnum.Video });
      app.page.url = new URL(`http://localhost/photos/${asset.id}?edit=1`);

      renderWithTooltips(AssetViewer, { cursor: { current: asset }, showNavigation: false });

      await waitFor(() => expect(assetViewerManager.isShowEditor).toBe(true));
      const { replaceState } = await import('$app/navigation');
      const [url] = vi.mocked(replaceState).mock.calls.at(-1) ?? [];
      expect(String(url)).toBe(`http://localhost/photos/${asset.id}`);
    });

    it('does not open an editor on someone else’s item', async () => {
      const user = userAdminFactory.build();
      authManager.setUser(user);
      authManager.setPreferences(preferencesFactory.build({ cast: { gCastEnabled: false } }));
      const asset = assetFactory.build({ ownerId: 'someone-else', type: AssetTypeEnum.Image });
      app.page.url = new URL(`http://localhost/photos/${asset.id}?edit=1`);
      saveEditorContinuity({
        assetId: asset.id,
        kind: 'photo',
        draft: { edits: [] },
        base: '{}',
        tool: 'adjust',
        playhead: { num: 0, den: 1 },
      });

      renderWithTooltips(AssetViewer, { cursor: { current: asset }, showNavigation: false });

      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(assetViewerManager.isShowEditor).toBe(false);
    });

    it('reopens an unsaved owner draft in an authenticated shared album', async () => {
      const user = userAdminFactory.build();
      authManager.setUser(user);
      authManager.setPreferences(preferencesFactory.build({ cast: { gCastEnabled: false } }));
      const asset = assetFactory.build({ ownerId: user.id, type: AssetTypeEnum.Image });
      saveEditorContinuity({
        assetId: asset.id,
        kind: 'photo',
        draft: { edits: [] },
        base: '{}',
        tool: 'adjust',
        playhead: { num: 0, den: 1 },
      });

      renderWithTooltips(AssetViewer, { cursor: { current: asset }, showNavigation: false, isShared: true });
      await waitFor(() => expect(assetViewerManager.isShowEditor).toBe(true));
    });
  });

  describe('the open item removed elsewhere (FL-35)', () => {
    const setup = (props: Record<string, unknown> = {}, { alone = false } = {}) => {
      const user = userAdminFactory.build();
      authManager.setUser(user);
      authManager.setPreferences(preferencesFactory.build({ cast: { gCastEnabled: false } }));
      const current = assetFactory.build({ ownerId: user.id, type: AssetTypeEnum.Image });
      const nextAsset = assetFactory.build({ ownerId: user.id, type: AssetTypeEnum.Image });
      const onNavigateToAsset = vi.fn().mockResolvedValue(undefined);
      const onClose = vi.fn();
      renderWithTooltips(AssetViewer, {
        cursor: alone ? { current } : { current, nextAsset },
        showNavigation: true,
        onNavigateToAsset,
        onClose,
        ...props,
      });
      return { current, nextAsset, onNavigateToAsset, onClose };
    };

    it('moves to a neighbour that is still there', async () => {
      const { current, nextAsset, onNavigateToAsset, onClose } = setup();
      eventManager.emit('AssetsDelete', [current.id]);
      await waitFor(() => expect(onNavigateToAsset).toHaveBeenCalledWith(nextAsset));
      expect(onClose).not.toHaveBeenCalled();
    });

    it('closes when the neighbours went too', async () => {
      const { current, nextAsset, onNavigateToAsset, onClose } = setup();
      eventManager.emit('AssetsDelete', [current.id, nextAsset.id]);
      await waitFor(() => expect(onClose).toHaveBeenCalledWith(current.id));
      expect(onNavigateToAsset).not.toHaveBeenCalled();
    });

    it('moves on when the open item is Locked elsewhere and this session has not unlocked', async () => {
      const { current, nextAsset, onNavigateToAsset } = setup();
      eventManager.emit('AssetUpdate', { ...current, visibility: AssetVisibility.Locked });
      await waitFor(() => expect(onNavigateToAsset).toHaveBeenCalledWith(nextAsset));
    });

    it('does not close when the page already moved on from an item removed here (trash viewer ordering)', async () => {
      // The page's preAction navigated to the next item and reset its neighbour lookup, so until the
      // next item loads the viewer still shows the removed one, with no neighbours.
      const preAction = vi.fn().mockResolvedValue(undefined);
      const { current, onNavigateToAsset, onClose } = setup({ preAction }, { alone: true });
      await fireEvent.click(await screen.findByLabelText('frameleaf_viewer_move_to_trash'));
      await waitFor(() => expect(deleteAssets).toHaveBeenCalled());
      expect(preAction).toHaveBeenCalledWith(
        expect.objectContaining({ asset: expect.objectContaining({ id: current.id }) }),
      );
      // the viewer's own event has fired; now the server's arrives for the same item
      eventManager.emit('AssetsDelete', [current.id]);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(onClose).not.toHaveBeenCalled();
      expect(onNavigateToAsset).not.toHaveBeenCalled();
    });

    it('still moves on by itself from an item removed here when no page step does', async () => {
      const { nextAsset, onNavigateToAsset } = setup();
      await fireEvent.click(await screen.findByLabelText('frameleaf_viewer_move_to_trash'));
      await waitFor(() => expect(onNavigateToAsset).toHaveBeenCalledWith(nextAsset));
    });

    it('ignores deletions of other items', async () => {
      const { onNavigateToAsset, onClose } = setup();
      eventManager.emit('AssetsDelete', ['someone-else']);
      await Promise.resolve();
      expect(onNavigateToAsset).not.toHaveBeenCalled();
      expect(onClose).not.toHaveBeenCalled();
    });
  });

  describe('ArrowRight/ArrowLeft races the neighbour lookup (FL-148)', () => {
    const buildAssets = () => {
      const user = userAdminFactory.build();
      authManager.setUser(user);
      authManager.setPreferences(preferencesFactory.build({ cast: { gCastEnabled: false } }));
      const current = assetFactory.build({ ownerId: user.id, type: AssetTypeEnum.Image });
      const nextAsset = assetFactory.build({ ownerId: user.id, type: AssetTypeEnum.Image });
      return { current, nextAsset };
    };

    it('queues an ArrowRight press made before the caller resolves the next asset, and replays it once it does', async () => {
      const { current, nextAsset } = buildAssets();
      const onNavigateToAsset = vi.fn().mockResolvedValue(undefined);

      // The caller's async neighbour lookup (TimelineAssetViewer's loadCloseAssets) has not resolved
      // yet - there is no on-screen "next" button - but a real ArrowRight keypress must not be lost.
      const view = renderWithTooltips(AssetViewer, {
        cursor: { current },
        showNavigation: true,
        onNavigateToAsset,
      });

      await fireEvent.keyDown(document, { key: 'ArrowRight' });
      await Promise.resolve();
      expect(onNavigateToAsset).not.toHaveBeenCalled();

      // The lookup settles for the same asset.
      await view.rerender({
        componentProps: { cursor: { current, nextAsset }, showNavigation: true, onNavigateToAsset },
      });

      await waitFor(() => expect(onNavigateToAsset).toHaveBeenCalledWith(nextAsset));
    });

    it('drops a queued press if the displayed asset changes for another reason first', async () => {
      const { current, nextAsset } = buildAssets();
      const anotherAsset = assetFactory.build({ ownerId: current.ownerId, type: AssetTypeEnum.Image });
      const onNavigateToAsset = vi.fn().mockResolvedValue(undefined);

      const view = renderWithTooltips(AssetViewer, {
        cursor: { current },
        showNavigation: true,
        onNavigateToAsset,
      });

      await fireEvent.keyDown(document, { key: 'ArrowRight' });
      await Promise.resolve();

      // The viewer moved to a different asset before the original lookup resolved (e.g. the user
      // clicked a thumbnail elsewhere); the stale queued intent must not fire once that new asset's
      // own neighbours resolve.
      await view.rerender({
        componentProps: { cursor: { current: anotherAsset, nextAsset }, showNavigation: true, onNavigateToAsset },
      });
      await Promise.resolve();

      expect(onNavigateToAsset).not.toHaveBeenCalled();
    });

    it('replays the latest ArrowRight press made while a navigation is still in flight', async () => {
      const { current, nextAsset } = buildAssets();

      let resolveFirst!: () => void;
      const onNavigateToAsset = vi.fn().mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            resolveFirst = resolve;
          }),
      );

      renderWithTooltips(AssetViewer, {
        cursor: { current, nextAsset },
        showNavigation: true,
        onNavigateToAsset,
      });

      await fireEvent.keyDown(document, { key: 'ArrowRight' });
      await waitFor(() => expect(onNavigateToAsset).toHaveBeenCalledTimes(1));

      // The first navigation is still in flight (`tracker.isActive()`); this press must be queued,
      // not dropped.
      await fireEvent.keyDown(document, { key: 'ArrowRight' });
      await Promise.resolve();
      expect(onNavigateToAsset).toHaveBeenCalledTimes(1);

      resolveFirst();
      await waitFor(() => expect(onNavigateToAsset).toHaveBeenCalledTimes(2));
    });

    afterEach(() => {
      // These guard-parity tests open the editor / face-edit mode directly on the shared manager.
      assetViewerManager.resetPanelState();
    });

    it('drops a queued press if the editor opens before the neighbour resolves', async () => {
      const { current, nextAsset } = buildAssets();
      const onNavigateToAsset = vi.fn().mockResolvedValue(undefined);

      const view = renderWithTooltips(AssetViewer, {
        cursor: { current },
        showNavigation: true,
        onNavigateToAsset,
      });

      await fireEvent.keyDown(document, { key: 'ArrowRight' });
      await Promise.resolve();

      // The person opened the quick editor before the lookup settled.
      assetViewerManager.openEditor();
      await Promise.resolve();

      await view.rerender({
        componentProps: { cursor: { current, nextAsset }, showNavigation: true, onNavigateToAsset },
      });
      await Promise.resolve();

      expect(onNavigateToAsset).not.toHaveBeenCalled();
    });

    it('drops a queued press if face-edit mode opens before the neighbour resolves', async () => {
      const { current, nextAsset } = buildAssets();
      const onNavigateToAsset = vi.fn().mockResolvedValue(undefined);

      const view = renderWithTooltips(AssetViewer, {
        cursor: { current },
        showNavigation: true,
        onNavigateToAsset,
      });

      await fireEvent.keyDown(document, { key: 'ArrowRight' });
      await Promise.resolve();

      // The person opened the face tagger (FaceTagger.svelte) before the lookup settled.
      assetViewerManager.toggleFaceEditMode();
      await Promise.resolve();

      await view.rerender({
        componentProps: { cursor: { current, nextAsset }, showNavigation: true, onNavigateToAsset },
      });
      await Promise.resolve();

      expect(onNavigateToAsset).not.toHaveBeenCalled();
    });

    it('drops a queued press if a slideshow starts before the neighbour resolves', async () => {
      const { current, nextAsset } = buildAssets();
      const onNavigateToAsset = vi.fn().mockResolvedValue(undefined);

      const view = renderWithTooltips(AssetViewer, {
        cursor: { current },
        showNavigation: true,
        onNavigateToAsset,
      });

      await fireEvent.keyDown(document, { key: 'ArrowRight' });
      await Promise.resolve();

      // A slideshow started (from elsewhere - e.g. the footer's Play button) before the lookup settled;
      // slideshow navigation runs its own path (isShuffle / slideshowHistory), not this queued intent.
      slideshowStore.slideshowState.set(SlideshowState.PlaySlideshow);
      await Promise.resolve();

      await view.rerender({
        componentProps: { cursor: { current, nextAsset }, showNavigation: true, onNavigateToAsset },
      });
      await Promise.resolve();

      expect(onNavigateToAsset).not.toHaveBeenCalled();
    });

    it('does not replay a queued press once it has gone stale (about 1.5s after the keypress)', async () => {
      const { current, nextAsset } = buildAssets();
      const onNavigateToAsset = vi.fn().mockResolvedValue(undefined);
      const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);

      const view = renderWithTooltips(AssetViewer, {
        cursor: { current },
        showNavigation: true,
        onNavigateToAsset,
      });

      await fireEvent.keyDown(document, { key: 'ArrowRight' });
      await Promise.resolve();

      // The lookup only settles a while later - long enough that replaying the original press would
      // move the person with no fresh interaction of their own.
      now.mockReturnValue(1_000_000 + 2000);
      await view.rerender({
        componentProps: { cursor: { current, nextAsset }, showNavigation: true, onNavigateToAsset },
      });
      await Promise.resolve();

      expect(onNavigateToAsset).not.toHaveBeenCalled();
      now.mockRestore();
    });

    it('moves on from a sideways flick on the photo, and stays put where there is no neighbour', async () => {
      const { current, nextAsset } = buildAssets();
      const onNavigateToAsset = vi.fn().mockResolvedValue(undefined);
      const view = renderWithTooltips(AssetViewer, {
        cursor: { current, nextAsset },
        showNavigation: true,
        onNavigateToAsset,
      });
      const canvas = view.container.ownerDocument.querySelector<HTMLElement>('[data-viewer-content]')!;

      // Towards the right there is nothing before this item: the photo springs back.
      await fireEvent.pointerDown(canvas, { pointerId: 1, clientX: 200, clientY: 200 });
      await fireEvent.pointerMove(document, { pointerId: 1, clientX: 320, clientY: 204 });
      expect(canvas).toHaveClass('following');
      await fireEvent.pointerUp(document, { pointerId: 1, clientX: 380, clientY: 204 });
      expect(canvas).not.toHaveClass('following');
      expect(onNavigateToAsset).not.toHaveBeenCalled();

      // Towards the left the next item is shown beside the photo, and the release moves on to it.
      await fireEvent.pointerDown(canvas, { pointerId: 1, clientX: 300, clientY: 200 });
      await fireEvent.pointerMove(document, { pointerId: 1, clientX: 240, clientY: 202 });
      expect(canvas.querySelector('[data-viewer-peek="next"]')).toBeInTheDocument();
      expect(canvas.querySelector('[data-viewer-peek="previous"]')).not.toBeInTheDocument();
      await fireEvent.pointerMove(document, { pointerId: 1, clientX: 20, clientY: 202 });
      await fireEvent.pointerUp(document, { pointerId: 1, clientX: 20, clientY: 202 });
      await waitFor(() => expect(onNavigateToAsset).toHaveBeenCalledExactlyOnceWith(nextAsset));
    });

    it('ignores an ArrowRight press when navigation is turned off for this viewer instance', async () => {
      // Guard parity: the same canNavigateByKey() check that gates the replay paths above must also
      // gate the original keypress, matching the buttons never being rendered with showNavigation=false.
      const { current, nextAsset } = buildAssets();
      const onNavigateToAsset = vi.fn().mockResolvedValue(undefined);

      renderWithTooltips(AssetViewer, {
        cursor: { current, nextAsset },
        showNavigation: false,
        onNavigateToAsset,
      });

      await fireEvent.keyDown(document, { key: 'ArrowRight' });
      await Promise.resolve();

      expect(onNavigateToAsset).not.toHaveBeenCalled();
    });
  });

  it('puts the Live badge on a Live Photo (V-16)', () => {
    const user = userAdminFactory.build();
    authManager.setUser(user);
    authManager.setPreferences(preferencesFactory.build({ cast: { gCastEnabled: false } }));
    const asset = assetFactory.build({
      ownerId: user.id,
      type: AssetTypeEnum.Image,
      livePhotoVideoId: 'motion',
      exifInfo: { projectionType: null },
    });
    const view = renderWithTooltips(AssetViewer, { cursor: { current: asset }, showNavigation: false });
    expect(view.getByTestId('viewer-live-badge')).toBeInTheDocument();
  });

  it('refreshes the asset when the video editor explicitly requests it', async () => {
    const user = userAdminFactory.build();
    const asset = assetFactory.build({ ownerId: user.id, type: AssetTypeEnum.Image });
    const updated = { ...asset, isEdited: true, thumbhash: 'new-thumbhash' };
    authManager.setUser(user);
    authManager.setPreferences(preferencesFactory.build({ cast: { gCastEnabled: false } }));
    assetViewerManager.isShowEditor = true;
    vi.mocked(getAssetInfo).mockResolvedValue(updated);
    const onAssetChange = vi.fn();
    const { getByRole } = renderWithTooltips(AssetViewer, {
      cursor: { current: asset },
      showNavigation: false,
      onAssetChange,
    });

    await fireEvent.click(getByRole('button', { name: 'Save video edits' }));

    await waitFor(() => expect(onAssetChange).toHaveBeenCalledWith(updated));
    expect(assetViewerManager.asset).toEqual(updated);
    expect(assetViewerManager.isShowEditor).toBe(false);
  });

  it.each([true, false])(
    'refreshes the viewer and cached asset after the queued editor unmounts (isEdited=%s)',
    async (isEdited) => {
      const user = userAdminFactory.build();
      const asset = assetFactory.build({ ownerId: user.id, type: AssetTypeEnum.Video, isEdited: !isEdited });
      const published = { ...asset, isEdited, duration: 5000, thumbhash: 'published-thumbhash' };
      authManager.setUser(user);
      authManager.setPreferences(preferencesFactory.build({ cast: { gCastEnabled: false } }));
      vi.mocked(getAssetInfo).mockResolvedValue(asset);
      await assetCacheManager.getAsset({ id: asset.id });
      assetViewerManager.isShowEditor = true;
      const onAssetUpdate = vi.fn();
      const view = renderWithTooltips(AssetViewer, {
        cursor: { current: asset },
        showNavigation: false,
        onAssetUpdate,
      });

      // Queue acceptance closes the editor before media publication changes metadata.
      await fireEvent.click(view.getByRole('button', { name: 'Save video edits' }));
      await waitFor(() => expect(view.queryByRole('button', { name: 'Save video edits' })).not.toBeInTheDocument());
      expect(assetViewerManager.isShowEditor).toBe(false);
      vi.mocked(getAssetInfo).mockResolvedValue(published);

      // This is the application-wide socket subscription, not an editor listener.
      const publish = socketListeners.get('on_asset_update');
      expect(publish).toBeDefined();
      publish?.(published);
      await waitFor(() => expect(onAssetUpdate).toHaveBeenCalledWith(published));
      expect(await assetCacheManager.getAsset({ id: asset.id })).toEqual(published);
      onAssetUpdate.mockClear();
      publish?.({ ...published, id: 'unrelated-asset' });
      expect(onAssetUpdate).not.toHaveBeenCalled();
    },
  );

  it.skip('updates the top bar favorite action after pressing favorite', async () => {
    const ownerId = 'owner-id';
    const user = userAdminFactory.build({ id: ownerId });
    const asset = assetFactory.build({ ownerId, isFavorite: false, isTrashed: false, type: AssetTypeEnum.Image });

    authManager.setUser(user);
    authManager.setPreferences(preferencesFactory.build({ cast: { gCastEnabled: false } }));

    vi.mocked(updateAsset).mockResolvedValue({ ...asset, isFavorite: true });

    const { getByLabelText, queryByLabelText } = renderWithTooltips(AssetViewer, {
      cursor: { current: asset },
      showNavigation: false,
    });

    expect(getByLabelText('frameleaf_viewer_add_to_favorites')).toBeInTheDocument();
    expect(queryByLabelText('frameleaf_viewer_remove_from_favorites')).toBeNull();

    await fireEvent.click(getByLabelText('frameleaf_viewer_add_to_favorites'));

    await waitFor(() =>
      expect(updateAsset).toHaveBeenCalledWith({ id: asset.id, updateAssetDto: { isFavorite: true } }),
    );
    await waitFor(() => expect(getByLabelText('frameleaf_viewer_remove_from_favorites')).toBeInTheDocument());
  });

  // FL-35 hands-on viewer (apple-style.css:366-407, MediaViewer.jsx:524-578).
  describe('hands-on viewer', () => {
    const renderImage = (props: Record<string, unknown> = {}, overrides: Partial<AssetResponseDto> = {}) => {
      const user = userAdminFactory.build();
      const asset = assetFactory.build({ ownerId: user.id, type: AssetTypeEnum.Image, ...overrides });
      authManager.setUser(user);
      authManager.setPreferences(preferencesFactory.build({ cast: { gCastEnabled: false } }));
      const view = renderWithTooltips(AssetViewer, { cursor: { current: asset }, showNavigation: false, ...props });
      const viewer = view.container.ownerDocument.querySelector<HTMLElement>('#immich-asset-viewer')!;
      const canvas = viewer.querySelector<HTMLElement>('[data-viewer-content]')!;
      return { asset, viewer, canvas };
    };

    it('draws a pure black canvas with the viewer tokens', () => {
      const { viewer } = renderImage();
      expect(viewer).toHaveClass('fl-media-viewer');
      expect(viewer).toHaveAttribute('data-theme', 'dark');
    });

    it('hides and shows the chrome on a tap on the photo', async () => {
      const { viewer, canvas } = renderImage();
      await fireEvent.pointerDown(canvas, { pointerId: 1, clientX: 200, clientY: 200 });
      await fireEvent.pointerUp(document, { pointerId: 1, clientX: 201, clientY: 200 });
      expect(viewer).toHaveClass('chrome-hidden');

      await fireEvent.pointerDown(canvas, { pointerId: 1, clientX: 200, clientY: 200 });
      await fireEvent.pointerUp(document, { pointerId: 1, clientX: 200, clientY: 200 });
      expect(viewer).not.toHaveClass('chrome-hidden');
    });

    it('closes on a downward swipe at normal zoom', async () => {
      const onClose = vi.fn();
      const { asset, viewer, canvas } = renderImage({ onClose });
      await fireEvent.pointerDown(canvas, { pointerId: 1, clientX: 200, clientY: 200 });
      await fireEvent.pointerMove(document, { pointerId: 1, clientX: 200, clientY: 300 });
      expect(viewer).toHaveClass('dragging');
      expect(canvas.style.transform).toContain('scale(');
      await fireEvent.pointerUp(document, { pointerId: 1, clientX: 200, clientY: 340 });
      expect(onClose).toHaveBeenCalledWith(asset.id);
    });

    it('springs back from a short swipe and ignores presses on controls', async () => {
      const onClose = vi.fn();
      const { viewer, canvas } = renderImage({ onClose });
      await fireEvent.pointerDown(canvas, { pointerId: 1, clientX: 200, clientY: 200 });
      await fireEvent.pointerMove(document, { pointerId: 1, clientX: 200, clientY: 250 });
      await fireEvent.pointerUp(document, { pointerId: 1, clientX: 200, clientY: 250 });
      expect(onClose).not.toHaveBeenCalled();
      expect(viewer).not.toHaveClass('dragging');
      expect(canvas.style.transform).toBe('');

      const button = document.createElement('button');
      canvas.append(button);
      await fireEvent.pointerDown(button, { pointerId: 1, clientX: 200, clientY: 200 });
      await fireEvent.pointerUp(document, { pointerId: 1, clientX: 200, clientY: 200 });
      expect(viewer).not.toHaveClass('chrome-hidden');
    });

    const swipeDown = async (canvas: HTMLElement) => {
      await fireEvent.pointerDown(canvas, { pointerId: 1, clientX: 200, clientY: 200 });
      await fireEvent.pointerMove(document, { pointerId: 1, clientX: 200, clientY: 300 });
      await fireEvent.pointerUp(document, { pointerId: 1, clientX: 200, clientY: 360 });
    };

    // B1: a two-finger pinch at normal zoom must never close the viewer.
    it('never closes on a pinch: a second finger ends the gesture and neither finger restarts it', async () => {
      const onClose = vi.fn();
      const { viewer, canvas } = renderImage({ onClose });
      await fireEvent.pointerDown(canvas, { pointerId: 1, clientX: 200, clientY: 200 });
      await fireEvent.pointerDown(canvas, { pointerId: 2, clientX: 300, clientY: 200 });
      await fireEvent.pointerMove(document, { pointerId: 1, clientX: 200, clientY: 400 });
      await fireEvent.pointerMove(document, { pointerId: 2, clientX: 300, clientY: 450 });
      await fireEvent.pointerUp(document, { pointerId: 2, clientX: 300, clientY: 450 });
      await fireEvent.pointerUp(document, { pointerId: 1, clientX: 200, clientY: 400 });
      expect(onClose).not.toHaveBeenCalled();
      expect(viewer).not.toHaveClass('dragging');
      expect(viewer).not.toHaveClass('chrome-hidden');
    });

    it('never restarts the swipe when one finger of a pinch is lifted and put back', async () => {
      const onClose = vi.fn();
      const { viewer, canvas } = renderImage({ onClose });
      await fireEvent.pointerDown(canvas, { pointerId: 1, clientX: 200, clientY: 200 });
      await fireEvent.pointerDown(canvas, { pointerId: 2, clientX: 300, clientY: 200 });
      await fireEvent.pointerUp(document, { pointerId: 1, clientX: 200, clientY: 200 });
      // Finger 2 is still down: putting finger 1 back is still a pinch, not a new swipe.
      await fireEvent.pointerDown(canvas, { pointerId: 1, clientX: 200, clientY: 200 });
      await fireEvent.pointerMove(document, { pointerId: 1, clientX: 200, clientY: 420 });
      expect(viewer).not.toHaveClass('dragging');
      await fireEvent.pointerUp(document, { pointerId: 1, clientX: 200, clientY: 420 });
      await fireEvent.pointerUp(document, { pointerId: 2, clientX: 300, clientY: 200 });
      expect(onClose).not.toHaveBeenCalled();

      // With every finger up, a single finger swipes again.
      await fireEvent.pointerDown(canvas, { pointerId: 3, clientX: 200, clientY: 200 });
      await fireEvent.pointerMove(document, { pointerId: 3, clientX: 200, clientY: 300 });
      await fireEvent.pointerUp(document, { pointerId: 3, clientX: 200, clientY: 360 });
      expect(onClose).toHaveBeenCalledOnce();
    });

    it('ignores another pointer’s moves and releases while following one', async () => {
      const onClose = vi.fn();
      const { canvas } = renderImage({ onClose });
      await fireEvent.pointerDown(canvas, { pointerId: 1, clientX: 200, clientY: 200 });
      await fireEvent.pointerMove(document, { pointerId: 9, clientX: 200, clientY: 500 });
      await fireEvent.pointerUp(document, { pointerId: 9, clientX: 200, clientY: 500 });
      expect(onClose).not.toHaveBeenCalled();
    });

    it('lets go when the photo is zoomed in mid-drag', async () => {
      const onClose = vi.fn();
      const { viewer, canvas } = renderImage({ onClose });
      await fireEvent.pointerDown(canvas, { pointerId: 1, clientX: 200, clientY: 200 });
      await fireEvent.pointerMove(document, { pointerId: 1, clientX: 200, clientY: 260 });
      assetViewerManager.zoom = 2;
      await fireEvent.pointerMove(document, { pointerId: 1, clientX: 200, clientY: 400 });
      await fireEvent.pointerUp(document, { pointerId: 1, clientX: 200, clientY: 400 });
      expect(onClose).not.toHaveBeenCalled();
      expect(viewer).not.toHaveClass('dragging');
      assetViewerManager.resetZoomState();
    });

    it('never closes a panorama, the editor or a slideshow by swiping', async () => {
      const onClose = vi.fn();
      const panorama = renderImage({ onClose }, { exifInfo: { projectionType: 'EQUIRECTANGULAR' } });
      await swipeDown(panorama.canvas);
      expect(onClose).not.toHaveBeenCalled();
      panorama.viewer.remove();

      assetViewerManager.isShowEditor = true;
      const editor = renderImage({ onClose });
      await swipeDown(editor.canvas);
      expect(onClose).not.toHaveBeenCalled();
      assetViewerManager.closeEditor();
      editor.viewer.remove();

      slideshowStore.slideshowState.set(SlideshowState.PlaySlideshow);
      const slideshow = renderImage({ onClose });
      await swipeDown(slideshow.canvas);
      expect(onClose).not.toHaveBeenCalled();
    });

    it('brings hidden chrome back when the keyboard is used', async () => {
      const { viewer, canvas } = renderImage();
      await fireEvent.pointerDown(canvas, { pointerId: 1, clientX: 200, clientY: 200 });
      await fireEvent.pointerUp(document, { pointerId: 1, clientX: 200, clientY: 200 });
      expect(viewer).toHaveClass('chrome-hidden');
      await fireEvent.keyDown(document, { key: 'Tab' });
      expect(viewer).not.toHaveClass('chrome-hidden');
    });

    // V-13 / V-12: the footer with the position.
    it('draws the footer with the position in the collection', () => {
      const { viewer } = renderImage({ position: { index: 2, total: 40 } });
      const footer = viewer.querySelector('[data-testid="viewer-footer"]')!;
      expect(footer).not.toBeNull();
      expect(footer.querySelector('[data-testid="viewer-position"]')).toHaveAttribute('aria-live', 'polite');
    });
  });

  // FL-36 / V-18 (MediaViewer.jsx:254-263): the slideshow plays in the viewer; full screen is a choice.
  it('starts a slideshow in the viewer without forcing full screen', async () => {
    const user = userAdminFactory.build();
    const asset = assetFactory.build({ ownerId: user.id, type: AssetTypeEnum.Image });
    authManager.setUser(user);
    authManager.setPreferences(preferencesFactory.build({ cast: { gCastEnabled: false } }));
    const requestFullscreen = vi.fn().mockResolvedValue(undefined);
    HTMLElement.prototype.requestFullscreen = requestFullscreen;
    Object.defineProperty(document, 'fullscreenEnabled', { value: true, configurable: true });
    const { findByTestId, getByLabelText } = renderWithTooltips(AssetViewer, {
      cursor: { current: asset },
      showNavigation: false,
    });

    slideshowStore.slideshowState.set(SlideshowState.PlaySlideshow);

    expect(await findByTestId('slideshow-progress')).toBeInTheDocument();
    expect(requestFullscreen).not.toHaveBeenCalled();
    // VIEWER-P1: the header stays, with the name and its actions; no floating capsule
    expect(await findByTestId('viewer-title')).toBeInTheDocument();
    expect(await findByTestId('asset-viewer-navbar-actions')).toBeInTheDocument();
    // the footer stays while the slideshow plays, with Pause, the settings and full screen
    expect(await findByTestId('viewer-footer')).toBeInTheDocument();
    expect(getByLabelText('frameleaf_viewer_pause_slideshow')).toBeInTheDocument();
    await fireEvent.click(getByLabelText('frameleaf_viewer_enter_fullscreen'));
    expect(requestFullscreen).toHaveBeenCalledOnce();

    // the viewer renders the settings panel for the footer's cog
    await fireEvent.click(getByLabelText('frameleaf_viewer_slideshow_settings'));
    expect(await findByTestId('slideshow-settings')).toBeInTheDocument();
    slideshowStore.slideshowState.set(SlideshowState.StopSlideshow);
    await waitFor(() => expect(get(slideshowStore.settingsOpen)).toBe(false));
  });

  // FL-36 + V-13: during a slideshow a tap on the photo toggles the one chrome state (header, footer, arrows).
  it('toggles the shared chrome with a tap during a slideshow and restores it when the slideshow ends', async () => {
    // the focus trap's initial focus is not keyboard focus here, so it does not hold the chrome
    const focusVisible = stubFocusVisible();
    onTestFinished(() => focusVisible.restore());
    const user = userAdminFactory.build();
    const asset = assetFactory.build({ ownerId: user.id, type: AssetTypeEnum.Image });
    authManager.setUser(user);
    authManager.setPreferences(preferencesFactory.build({ cast: { gCastEnabled: false } }));
    const { container, findByTestId } = renderWithTooltips(AssetViewer, {
      cursor: { current: asset },
      showNavigation: false,
    });
    const viewer = container.querySelector<HTMLElement>(':scope #immich-asset-viewer')!;
    const canvas = viewer.querySelector<HTMLElement>(':scope [data-viewer-content]')!;

    slideshowStore.slideshowState.set(SlideshowState.PlaySlideshow);
    await findByTestId('slideshow-progress');
    await fireEvent.pointerDown(canvas, { clientX: 10, clientY: 10, pointerId: 1 });
    await fireEvent.pointerUp(canvas, { clientX: 10, clientY: 10, pointerId: 1 });
    await waitFor(() => expect(viewer).toHaveClass('chrome-hidden'));

    slideshowStore.slideshowState.set(SlideshowState.StopSlideshow);
    await waitFor(() => expect(viewer).not.toHaveClass('chrome-hidden'));
  });

  // VIEWER-P1 (MediaViewer.jsx:1071-1074): opening Information pauses a playing slideshow and shows the card.
  it('pauses a playing slideshow when Information opens', async () => {
    const user = userAdminFactory.build();
    const asset = assetFactory.build({ ownerId: user.id, type: AssetTypeEnum.Image, hasMetadata: true });
    authManager.setUser(user);
    authManager.setPreferences(preferencesFactory.build({ cast: { gCastEnabled: false } }));
    slideshowStore.slideshowDelay.set(60);
    assetViewerManager.closeDetailPanel();
    try {
      const { container } = renderWithTooltips(AssetViewer, { cursor: { current: asset }, showNavigation: false });
      slideshowStore.slideshowState.set(SlideshowState.PlaySlideshow);
      await waitFor(() => expect(container.querySelector('[data-testid="slideshow-progress"]')).not.toBeNull());

      assetViewerManager.toggleDetailPanel();
      await waitFor(() => expect(get(slideshowStore.slideshowState)).toBe(SlideshowState.PauseSlideshow));
      await waitFor(() => expect(container.querySelector('#detail-panel')).not.toBeNull());
    } finally {
      assetViewerManager.closeDetailPanel();
      slideshowStore.slideshowDelay.set(5);
    }
  });

  // MediaViewer.jsx:740: with the settings open, Escape closes them first, wherever focus is.
  it('closes the slideshow settings on Escape before anything else sees it', async () => {
    const user = userAdminFactory.build();
    const asset = assetFactory.build({ ownerId: user.id, type: AssetTypeEnum.Image });
    authManager.setUser(user);
    authManager.setPreferences(preferencesFactory.build({ cast: { gCastEnabled: false } }));
    const onClose = vi.fn();
    const { findByTestId, queryByTestId } = renderWithTooltips(AssetViewer, {
      cursor: { current: asset },
      showNavigation: false,
      onClose,
    });
    slideshowStore.openSettings();
    await findByTestId('slideshow-settings');
    (document.activeElement as HTMLElement | null)?.blur();

    await fireEvent.keyDown(document.body, { key: 'Escape' });
    await waitFor(() => expect(queryByTestId('slideshow-settings')).not.toBeInTheDocument());
    expect(onClose).not.toHaveBeenCalled();
  });

  // Owner, 2026-10-16: Escape in a full-screen slideshow leaves full screen and ends the slideshow; the
  // next Escape closes the viewer. Chromium leaves full screen itself and keeps that key from the page.
  describe('Escape and full screen', () => {
    const previousElement = Object.getOwnPropertyDescriptor(document, 'fullscreenElement');
    const previousExit = document.exitFullscreen;
    const setFullscreen = (element: Element | null) => {
      Object.defineProperty(document, 'fullscreenElement', { configurable: true, value: element });
      document.dispatchEvent(new Event('fullscreenchange'));
    };
    const open = () => {
      const user = userAdminFactory.build();
      const asset = assetFactory.build({ ownerId: user.id, type: AssetTypeEnum.Image });
      authManager.setUser(user);
      authManager.setPreferences(preferencesFactory.build({ cast: { gCastEnabled: false } }));
      const onClose = vi.fn();
      const view = renderWithTooltips(AssetViewer, { cursor: { current: asset }, showNavigation: false, onClose });
      return { onClose, view };
    };
    /**
     * Escape closes the viewer through the header's Close shortcut, which the app's shortcut layer runs
     * from a window listener (not mounted here). Whether the key gets there untouched is what decides.
     */
    const escapeReachesClose = async () => {
      let reached = false;
      const listen = (event: KeyboardEvent) => {
        reached = event.key === 'Escape' && !event.defaultPrevented;
      };
      addEventListener('keydown', listen);
      try {
        await fireEvent.keyDown(document.body, { key: 'Escape' });
      } finally {
        removeEventListener('keydown', listen);
      }
      return reached;
    };
    afterEach(() => {
      document.exitFullscreen = previousExit;
      if (previousElement) {
        Object.defineProperty(document, 'fullscreenElement', previousElement);
      } else {
        Reflect.deleteProperty(document, 'fullscreenElement');
      }
    });

    it('ends the slideshow when the browser leaves full screen on Escape, and only the next Escape closes', async () => {
      const { onClose, view } = open();
      setFullscreen(view.container);
      slideshowStore.slideshowState.set(SlideshowState.PlaySlideshow);
      await view.findByTestId('slideshow-progress');

      // The browser took the key and left full screen: the page only hears `fullscreenchange`.
      setFullscreen(null);
      await waitFor(() => expect(get(slideshowStore.slideshowState)).toBe(SlideshowState.None));
      expect(onClose).not.toHaveBeenCalled();

      // The same press reaching the page just after the exit does not close the viewer as well.
      expect(await escapeReachesClose()).toBe(false);

      // A second press, a moment later, closes the viewer.
      const later = performance.now() + 1000;
      const now = vi.spyOn(performance, 'now').mockReturnValue(later);
      onTestFinished(() => now.mockRestore());
      expect(await escapeReachesClose()).toBe(true);
    });

    it('leaves full screen, without closing, when the page hears Escape while still in full screen', async () => {
      const { onClose, view } = open();
      const exit = vi.fn().mockImplementation(() => {
        setFullscreen(null);
        return Promise.resolve();
      });
      document.exitFullscreen = exit;
      setFullscreen(view.container);
      slideshowStore.slideshowState.set(SlideshowState.PlaySlideshow);
      await view.findByTestId('slideshow-progress');

      expect(await escapeReachesClose()).toBe(false);

      expect(exit).toHaveBeenCalledOnce();
      await waitFor(() => expect(get(slideshowStore.slideshowState)).toBe(SlideshowState.None));
      expect(onClose).not.toHaveBeenCalled();
    });

    it('keeps the slideshow playing when full screen is left from the footer', async () => {
      const { view } = open();
      document.exitFullscreen = vi.fn().mockImplementation(() => {
        setFullscreen(null);
        return Promise.resolve();
      });
      setFullscreen(view.container);
      slideshowStore.slideshowState.set(SlideshowState.PlaySlideshow);
      await view.findByTestId('slideshow-progress');

      await fireEvent.click(view.getByLabelText('frameleaf_viewer_exit_fullscreen'));

      expect(document.exitFullscreen).toHaveBeenCalledOnce();
      expect(get(slideshowStore.slideshowState)).toBe(SlideshowState.PlaySlideshow);
    });

    it('leaves Escape to Close viewer outside full screen, which ends a slideshow on the way', async () => {
      const { onClose, view } = open();
      slideshowStore.slideshowState.set(SlideshowState.PlaySlideshow);
      await view.findByTestId('slideshow-progress');

      expect(await escapeReachesClose()).toBe(true);
      // Close viewer (the header's back arrow, and the Escape shortcut) ends the slideshow and closes.
      await fireEvent.click(view.getByLabelText('frameleaf_viewer_close_label'));
      expect(onClose).toHaveBeenCalledOnce();
      await waitFor(() => expect(get(slideshowStore.slideshowState)).toBe(SlideshowState.None));
    });
  });

  // VIEWER-P1: Play always plays, even for someone who once turned the old Autoplay preference off.
  it('plays at once when Play is pressed, whatever the old Autoplay preference says', async () => {
    const user = userAdminFactory.build();
    const asset = assetFactory.build({ ownerId: user.id, type: AssetTypeEnum.Image });
    authManager.setUser(user);
    authManager.setPreferences(preferencesFactory.build({ cast: { gCastEnabled: false } }));
    slideshowStore.slideshowAutoplay.set(false);
    renderWithTooltips(AssetViewer, { cursor: { current: asset }, showNavigation: false });

    slideshowStore.slideshowState.set(SlideshowState.PlaySlideshow);
    await Promise.resolve();
    expect(get(slideshowStore.slideshowState)).toBe(SlideshowState.PlaySlideshow);
    slideshowStore.slideshowState.set(SlideshowState.PauseSlideshow);
    slideshowStore.slideshowState.set(SlideshowState.PlaySlideshow);
    await Promise.resolve();
    expect(get(slideshowStore.slideshowState)).toBe(SlideshowState.PlaySlideshow);
    slideshowStore.slideshowAutoplay.set(true);
  });

  // VIEWER-P1: Pause holds the item where it is; it never restarts (and freezes) the item's fade-in.
  it('pauses a slideshow without restarting the item on stage', async () => {
    const user = userAdminFactory.build();
    const asset = assetFactory.build({ ownerId: user.id, type: AssetTypeEnum.Image });
    authManager.setUser(user);
    authManager.setPreferences(preferencesFactory.build({ cast: { gCastEnabled: false } }));
    slideshowStore.slideshowDelay.set(60);
    try {
      const { container } = renderWithTooltips(AssetViewer, { cursor: { current: asset }, showNavigation: false });
      const stage = container.querySelector<HTMLElement>(':scope [data-viewer-content] .fl-viewer-stage')!;
      const animate = vi.fn(Element.prototype.animate);
      stage.animate = animate;

      slideshowStore.slideshowState.set(SlideshowState.PlaySlideshow);
      await waitFor(() => expect(animate).toHaveBeenCalled());
      const started = animate.mock.calls.length;
      slideshowStore.slideshowState.set(SlideshowState.PauseSlideshow);
      await Promise.resolve();
      slideshowStore.slideshowState.set(SlideshowState.PlaySlideshow);
      await Promise.resolve();
      expect(animate).toHaveBeenCalledTimes(started);
    } finally {
      slideshowStore.slideshowDelay.set(5);
    }
  });

  // VIEWER-P1: the header's back arrow closes the viewer from a slideshow, and ends the slideshow.
  it('ends the slideshow when the viewer is closed from the header', async () => {
    const user = userAdminFactory.build();
    const asset = assetFactory.build({ ownerId: user.id, type: AssetTypeEnum.Image });
    authManager.setUser(user);
    authManager.setPreferences(preferencesFactory.build({ cast: { gCastEnabled: false } }));
    const onClose = vi.fn();
    const { getByLabelText } = renderWithTooltips(AssetViewer, {
      cursor: { current: asset },
      showNavigation: false,
      onClose,
    });
    slideshowStore.slideshowState.set(SlideshowState.PlaySlideshow);

    await fireEvent.click(getByLabelText('frameleaf_viewer_close_label'));
    expect(onClose).toHaveBeenCalledWith(asset.id);
    await waitFor(() => expect(get(slideshowStore.slideshowState)).toBe(SlideshowState.None));
  });
});
