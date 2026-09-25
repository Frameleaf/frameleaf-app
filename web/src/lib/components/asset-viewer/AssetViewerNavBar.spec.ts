import { AssetTypeEnum, AssetVisibility } from '@immich/sdk';
import '@testing-library/jest-dom';
import { fireEvent } from '@testing-library/svelte';
import { get } from 'svelte/store';
import { getResizeObserverMock } from '$lib/__mocks__/resize-observer.mock';
import { assetViewerManager } from '$lib/managers/asset-viewer-manager.svelte';
import { authManager } from '$lib/managers/auth-manager.svelte';
import { SlideshowState, slideshowStore } from '$lib/stores/slideshow.store';
import { setSharedLink } from '$lib/utils';
import { renderWithTooltips } from '$tests/helpers';
import { assetFactory } from '@test-data/factories/asset-factory';
import { preferencesFactory } from '@test-data/factories/preferences-factory';
import { sharedLinkFactory } from '@test-data/factories/shared-link-factory';
import { userAdminFactory } from '@test-data/factories/user-factory';
import AssetViewerNavBar from './AssetViewerNavBar.svelte';

vi.mock(import('$lib/managers/feature-flags-manager.svelte'), function () {
  return {
    featureFlagsManager: {
      init: vi.fn(),
      loadFeatureFlags: vi.fn(),
      value: { smartSearch: true, trash: true },
    } as never,
  };
});

describe('AssetViewerNavBar component', () => {
  const additionalProps = {
    preAction: () => {},
    onAction: () => {},
    onClose: () => {},
    isPlayingOriginalVideo: false,
    setPlayOriginalVideo: () => {},
  };

  beforeAll(() => {
    Element.prototype.animate = vi.fn().mockImplementation(function () {
      return {
        cancel: () => {},
      };
    });
    vi.stubGlobal('ResizeObserver', getResizeObserverMock());
  });

  afterEach(() => {
    assetViewerManager.closeEditor();
    authManager.reset();
  });

  afterAll(() => {
    vi.restoreAllMocks();
  });

  it('shows back button', () => {
    const preferences = preferencesFactory.build({ cast: { gCastEnabled: false } });
    authManager.setPreferences(preferences);

    const asset = assetFactory.build({ isTrashed: false });
    const { getByLabelText } = renderWithTooltips(AssetViewerNavBar, { asset, ...additionalProps });
    expect(getByLabelText('frameleaf_viewer_close')).toBeInTheDocument();
  });

  describe('if the current user owns the asset', () => {
    it('shows delete button', () => {
      const ownerId = 'id-of-the-user';
      const user = userAdminFactory.build({ id: ownerId });
      const asset = assetFactory.build({ ownerId, isTrashed: false });
      authManager.setUser(user);

      const preferences = preferencesFactory.build({ cast: { gCastEnabled: false } });
      authManager.setPreferences(preferences);

      const { getByLabelText } = renderWithTooltips(AssetViewerNavBar, { asset, ...additionalProps });
      expect(getByLabelText('delete')).toBeInTheDocument();
    });

    // FL-34: sensitivity is the one lock, offered as a single Mark Sensitive entry (the prototype's
    // `lock`); the separate NSFW review entries were removed with the old mark.
    it('offers Mark Sensitive, and no separate NSFW review entries, for a full-size owned image', () => {
      const ownerId = 'id-of-the-user';
      const user = userAdminFactory.build({ id: ownerId });
      const asset = assetFactory.build({ ownerId, isTrashed: false, type: AssetTypeEnum.Image });
      authManager.setUser(user);

      const preferences = preferencesFactory.build({ cast: { gCastEnabled: false } });
      authManager.setPreferences(preferences);

      const { getByRole, queryByRole } = renderWithTooltips(AssetViewerNavBar, { asset, ...additionalProps });
      expect(getByRole('menuitem', { name: 'frameleaf_bulk_mark_sensitive' })).toBeInTheDocument();
      expect(queryByRole('menuitem', { name: 'mark_nsfw' })).not.toBeInTheDocument();
      expect(queryByRole('menuitem', { name: 'mark_safe' })).not.toBeInTheDocument();
    });

    // FL-34: sensitivity is the one lock, offered as a single Mark Sensitive entry (the prototype's
    // `lock`); the separate NSFW review entries were removed with the old mark.
    it('offers Mark Sensitive, and no separate NSFW review entries, for a full-size owned video', () => {
      const ownerId = 'id-of-the-user';
      const user = userAdminFactory.build({ id: ownerId });
      const asset = assetFactory.build({ ownerId, isTrashed: false, type: AssetTypeEnum.Video });
      authManager.setUser(user);

      const preferences = preferencesFactory.build({ cast: { gCastEnabled: false } });
      authManager.setPreferences(preferences);

      const { getByRole, queryByRole } = renderWithTooltips(AssetViewerNavBar, { asset, ...additionalProps });
      expect(getByRole('menuitem', { name: 'frameleaf_bulk_mark_sensitive' })).toBeInTheDocument();
      expect(queryByRole('menuitem', { name: 'mark_nsfw' })).not.toBeInTheDocument();
      expect(queryByRole('menuitem', { name: 'mark_safe' })).not.toBeInTheDocument();
    });

    it('shows the editor action for a full-size owned video even when client metadata is missing', async () => {
      const ownerId = 'id-of-the-user';
      const user = userAdminFactory.build({ id: ownerId });
      const asset = assetFactory.build({
        ownerId,
        isTrashed: false,
        type: AssetTypeEnum.Video,
        originalPath: '/upload/video.mp4',
        originalFileName: 'video.mp4',
        width: null,
        height: null,
        duration: null,
      });
      authManager.setUser(user);

      const preferences = preferencesFactory.build({ cast: { gCastEnabled: false } });
      authManager.setPreferences(preferences);

      const { getByLabelText } = renderWithTooltips(AssetViewerNavBar, { asset, ...additionalProps });
      await fireEvent.click(getByLabelText('editor'));

      expect(assetViewerManager.isShowEditor).toBe(true);
    });
  });

  describe('FL-35 grouped More menu and EXIF line', () => {
    const signIn = (ownerId: string) => {
      authManager.setUser(userAdminFactory.build({ id: ownerId }));
      authManager.setPreferences(preferencesFactory.build({ cast: { gCastEnabled: false } }));
    };

    it('heads each group it renders and drops the ones with nothing to offer', () => {
      const ownerId = 'id-of-the-user';
      signIn(ownerId);
      const asset = assetFactory.build({ ownerId, isTrashed: false, type: AssetTypeEnum.Image });

      const { getByText, queryByText, queryByRole } = renderWithTooltips(AssetViewerNavBar, {
        asset,
        ...additionalProps,
      });

      expect(getByText('frameleaf_viewer_group_download')).toBeInTheDocument();
      expect(getByText('frameleaf_viewer_group_organize')).toBeInTheDocument();
      expect(getByText('frameleaf_viewer_group_stack')).toBeInTheDocument();
      expect(getByText('frameleaf_viewer_group_go_to')).toBeInTheDocument();
      expect(getByText('frameleaf_viewer_group_jobs')).toBeInTheDocument();
      // "Set as" survives on the profile picture alone.
      expect(getByText('frameleaf_viewer_group_set_as')).toBeInTheDocument();

      // Not opened from an album or a person page, so neither target is offered.
      expect(queryByRole('menuitem', { name: 'set_as_album_cover' })).not.toBeInTheDocument();
      expect(queryByRole('menuitem', { name: 'set_as_featured_photo' })).not.toBeInTheDocument();
      expect(queryByText('frameleaf_viewer_group_trash')).not.toBeInTheDocument();
    });

    it('offers Trash instead of the organizing groups for a trashed asset', () => {
      const ownerId = 'id-of-the-user';
      signIn(ownerId);
      const asset = assetFactory.build({ ownerId, isTrashed: true, type: AssetTypeEnum.Image });

      const { getByText, queryByText } = renderWithTooltips(AssetViewerNavBar, { asset, ...additionalProps });

      expect(getByText('frameleaf_viewer_group_trash')).toBeInTheDocument();
      expect(queryByText('frameleaf_viewer_group_organize')).not.toBeInTheDocument();
      expect(queryByText('frameleaf_viewer_group_stack')).not.toBeInTheDocument();
      expect(queryByText('frameleaf_viewer_group_jobs')).not.toBeInTheDocument();
    });

    it('drops the Jobs group entirely for an asset the user does not own', () => {
      signIn('id-of-the-user');
      const asset = assetFactory.build({ ownerId: 'someone-else', isTrashed: false, type: AssetTypeEnum.Image });

      const { queryByText } = renderWithTooltips(AssetViewerNavBar, { asset, ...additionalProps });

      expect(queryByText('frameleaf_viewer_group_jobs')).not.toBeInTheDocument();
      expect(queryByText('frameleaf_viewer_group_stack')).not.toBeInTheDocument();
    });

    it('offers the encoded-video job for video and the face job for a still', () => {
      const ownerId = 'id-of-the-user';
      signIn(ownerId);

      const video = assetFactory.build({ ownerId, isTrashed: false, type: AssetTypeEnum.Video });
      const rendered = renderWithTooltips(AssetViewerNavBar, { asset: video, ...additionalProps });
      expect(rendered.getByRole('menuitem', { name: 'refresh_encoded_videos' })).toBeInTheDocument();
      expect(rendered.queryByRole('menuitem', { name: 'refresh_faces' })).not.toBeInTheDocument();
      rendered.unmount();

      const still = assetFactory.build({ ownerId, isTrashed: false, type: AssetTypeEnum.Image });
      const { getByRole, queryByRole } = renderWithTooltips(AssetViewerNavBar, { asset: still, ...additionalProps });
      expect(getByRole('menuitem', { name: 'refresh_faces' })).toBeInTheDocument();
      expect(queryByRole('menuitem', { name: 'refresh_encoded_videos' })).not.toBeInTheDocument();
    });

    it('shows the EXIF line under the file name', () => {
      const ownerId = 'id-of-the-user';
      signIn(ownerId);
      const asset = assetFactory.build({
        ownerId,
        isTrashed: false,
        type: AssetTypeEnum.Image,
        originalFileName: 'DSCF1234.RAF',
        width: 6000,
        height: 4000,
        exifInfo: {
          make: 'Fujifilm',
          model: 'X-T5',
          iso: 400,
          exifImageWidth: 6000,
          exifImageHeight: 4000,
          fileSizeInByte: 24_500_000,
        },
      });

      const { getByTestId } = renderWithTooltips(AssetViewerNavBar, { asset, ...additionalProps });

      const line = getByTestId('viewer-exif-line').textContent ?? '';
      expect(line).toContain('Fujifilm X-T5');
      expect(line).toContain('ISO 400');
      expect(line).toContain('24.5 MB');
    });

    it('leaves out the EXIF line when the asset carries no metadata', () => {
      const ownerId = 'id-of-the-user';
      signIn(ownerId);
      const asset = assetFactory.build({
        ownerId,
        isTrashed: false,
        type: AssetTypeEnum.Image,
        width: null,
        height: null,
        duration: null,
        exifInfo: undefined,
      });

      const { queryByTestId } = renderWithTooltips(AssetViewerNavBar, { asset, ...additionalProps });
      expect(queryByTestId('viewer-exif-line')).not.toBeInTheDocument();
    });
  });
  // FL-83: a shared link's viewer has no More menu, so its slideshow sits in the bar, gated as the
  // old public header gated it.
  describe('on a shared link', () => {
    const slideshow = 'frameleaf_viewer_play_slideshow';

    beforeEach(() => {
      authManager.setPreferences(preferencesFactory.build({ cast: { gCastEnabled: false } }));
    });

    afterEach(() => {
      setSharedLink(undefined);
    });

    it('offers Play slideshow in the bar when the link allows downloads', async () => {
      // the factories pick random values: metadata must be shown for a link to send, and a Locked item never is
      setSharedLink(sharedLinkFactory.build({ allowDownload: true, showMetadata: true }));
      const asset = assetFactory.build({
        isTrashed: false,
        type: AssetTypeEnum.Image,
        visibility: AssetVisibility.Timeline,
      });
      const { getByLabelText, queryByLabelText } = renderWithTooltips(AssetViewerNavBar, {
        asset,
        ...additionalProps,
        canNavigateCollection: true,
      });
      expect(queryByLabelText('frameleaf_viewer_more_actions')).not.toBeInTheDocument();
      await fireEvent.click(getByLabelText(slideshow));
      expect(get(slideshowStore.slideshowState)).toBe(SlideshowState.PlaySlideshow);
      slideshowStore.slideshowState.set(SlideshowState.None);
    });

    it('offers the slideshow when the link does not allow downloads (AL-37)', () => {
      setSharedLink(sharedLinkFactory.build({ allowDownload: false }));
      const asset = assetFactory.build({
        isTrashed: false,
        type: AssetTypeEnum.Image,
        visibility: AssetVisibility.Timeline,
      });
      const { queryByLabelText } = renderWithTooltips(AssetViewerNavBar, {
        asset,
        ...additionalProps,
        canNavigateCollection: true,
      });
      expect(queryByLabelText(slideshow)).toBeInTheDocument();
    });

    it('leaves the slideshow out when there is nothing to move to', () => {
      // the factories pick random values: metadata must be shown for a link to send, and a Locked item never is
      setSharedLink(sharedLinkFactory.build({ allowDownload: true, showMetadata: true }));
      const asset = assetFactory.build({
        isTrashed: false,
        type: AssetTypeEnum.Image,
        visibility: AssetVisibility.Timeline,
      });
      const { queryByLabelText } = renderWithTooltips(AssetViewerNavBar, {
        asset,
        ...additionalProps,
        canNavigateCollection: false,
      });
      expect(queryByLabelText(slideshow)).not.toBeInTheDocument();
    });
  });

  it('keeps the slideshow in the More menu, not the bar, for a signed-in library viewer', () => {
    authManager.setPreferences(preferencesFactory.build({ cast: { gCastEnabled: false } }));
    const asset = assetFactory.build({ isTrashed: false, type: AssetTypeEnum.Image });
    const { queryByLabelText } = renderWithTooltips(AssetViewerNavBar, {
      asset,
      ...additionalProps,
      canNavigateCollection: true,
    });
    expect(queryByLabelText('frameleaf_viewer_more_actions')).toBeInTheDocument();
    expect(queryByLabelText('frameleaf_viewer_play_slideshow')).not.toBeInTheDocument();
  });

  // FL-35: the template caps the More menu at calc(100dvh - 150px) and scrolls inside (media-viewer.css:145),
  // so its last entries (Play slideshow) stay clear of the footer, which stacks at the header's level.
  it('caps the More menu clear of the footer and scrolls it inside when it is taller', async () => {
    authManager.setPreferences(preferencesFactory.build({ cast: { gCastEnabled: false } }));
    const asset = assetFactory.build({ isTrashed: false, type: AssetTypeEnum.Image });
    const innerHeight = vi.spyOn(globalThis, 'innerHeight', 'get').mockReturnValue(700);
    const clientHeight = vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(900);
    try {
      const { getByLabelText, getByRole } = renderWithTooltips(AssetViewerNavBar, {
        asset,
        ...additionalProps,
        canNavigateCollection: true,
      });
      await fireEvent.click(getByLabelText('frameleaf_viewer_more_actions'));

      const scrollView = getByRole('menu', { hidden: true }).parentElement!;
      expect(scrollView.style.maxHeight).toBe('550px');
      expect(scrollView).toHaveClass('overflow-auto');
    } finally {
      innerHeight.mockRestore();
      clientHeight.mockRestore();
    }
  });

  // FL-35: on a phone More sits in the bottom toolbar just above the footer, so the menu opens low; its bottom
  // edge must still end above the footer (60px plus the safe area), which paints over the header's level.
  it('ends the More menu above the footer when it opens from the phone toolbar', async () => {
    authManager.setPreferences(preferencesFactory.build({ cast: { gCastEnabled: false } }));
    const asset = assetFactory.build({ isTrashed: false, type: AssetTypeEnum.Image });
    const height = 844;
    const spies = [
      vi.spyOn(globalThis, 'innerWidth', 'get').mockReturnValue(390),
      vi.spyOn(globalThis, 'innerHeight', 'get').mockReturnValue(height),
      vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(520),
      vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
        // The phone toolbar's More button, about 108px above the bottom of the window.
        const y = this.getAttribute('aria-label') === 'frameleaf_viewer_more_actions' ? height - 108 : 0;
        return DOMRect.fromRect({ x: 340, y, width: 44, height: 44 });
      }),
    ];
    try {
      const { getByLabelText, getByRole } = renderWithTooltips(AssetViewerNavBar, {
        asset,
        ...additionalProps,
        canNavigateCollection: true,
      });
      await fireEvent.click(getByLabelText('frameleaf_viewer_more_actions'));

      const scrollView = getByRole('menu', { hidden: true }).parentElement!;
      const px = (value: string) => Number(value.replace(/px$/, ''));
      const bottom = px(scrollView.style.top) + px(scrollView.style.maxHeight);
      expect(bottom).toBeLessThanOrEqual(height - 60);
    } finally {
      for (const spy of spies) {
        spy.mockRestore();
      }
    }
  });

  // FL-35: the template's top row (MediaViewer.jsx:1023-1200), without the legacy Offline and zoom buttons (V-6).
  describe('toolbar', () => {
    it('follows the template order and leaves out the legacy Offline and zoom buttons', () => {
      const ownerId = 'id-of-the-user';
      authManager.setUser(userAdminFactory.build({ id: ownerId }));
      authManager.setPreferences(preferencesFactory.build({ cast: { gCastEnabled: false } }));
      const asset = assetFactory.build({
        ownerId,
        isTrashed: false,
        isOffline: true,
        hasMetadata: true,
        type: AssetTypeEnum.Image,
      });

      const { getByRole } = renderWithTooltips(AssetViewerNavBar, { asset, ...additionalProps });
      const toolbar = getByRole('toolbar', { name: 'frameleaf_viewer_actions' });
      const names = [...toolbar.querySelectorAll('button')].map(
        (button) => button.getAttribute('aria-label') ?? button.textContent?.trim(),
      );

      expect(names).not.toContain('zoom_image');
      expect(names).not.toContain('asset_offline');
      // Download lives in the More menu's Download group; only a shared link, which has no menu, keeps it here.
      expect(names).not.toContain('download');
      const order = ['share', 'frameleaf_viewer_information', 'delete', 'frameleaf_viewer_more_actions'].map((name) =>
        names.indexOf(name),
      );
      expect(order.every((index) => index >= 0)).toBe(true);
      expect(order).toEqual([...order].sort((a, b) => a - b));
    });

    it('offers Send a copy in a shared link’s bar only where the browser can share files', () => {
      authManager.setPreferences(preferencesFactory.build({ cast: { gCastEnabled: false } }));
      // the factories pick random values: metadata must be shown for a link to send, and a Locked item never is
      setSharedLink(sharedLinkFactory.build({ allowDownload: true, showMetadata: true }));
      const asset = assetFactory.build({
        isTrashed: false,
        type: AssetTypeEnum.Image,
        visibility: AssetVisibility.Timeline,
      });

      const withoutShare = renderWithTooltips(AssetViewerNavBar, { asset, ...additionalProps });
      expect(withoutShare.queryByLabelText('frameleaf_send_copy')).not.toBeInTheDocument();
      withoutShare.unmount();

      vi.stubGlobal('navigator', { ...navigator, share: vi.fn(), canShare: () => true });
      const { getByLabelText } = renderWithTooltips(AssetViewerNavBar, { asset, ...additionalProps });
      expect(getByLabelText('frameleaf_send_copy')).toBeInTheDocument();
      vi.unstubAllGlobals();
      vi.stubGlobal('ResizeObserver', getResizeObserverMock());
      setSharedLink(undefined);
    });
  });
});
