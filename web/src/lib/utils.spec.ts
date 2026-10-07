import { AssetTypeEnum } from '@frameleaf/sdk';
import {
  bumpPlaybackRevision,
  markDevelopPlaybackUnresolved,
  resetPlaybackRevisions,
  setDevelopPlaybackRevision,
} from '$lib/frameleaf/playback-revision.svelte';
import { authManager } from '$lib/managers/auth-manager.svelte';
import { AbortError, cancelUploadRequests, getAssetUrl, getAssetUrls, semverToName, uploadRequest } from '$lib/utils';
import { assetFactory } from '@test-data/factories/asset-factory';
import { preferencesFactory } from '@test-data/factories/preferences-factory';
import { sharedLinkFactory } from '@test-data/factories/shared-link-factory';
import { userAdminFactory } from '@test-data/factories/user-factory';

describe('utils', () => {
  describe('FL-45 cancelling uploads', () => {
    class FakeXhr extends EventTarget {
      upload = new EventTarget();
      readyState = 0;
      status = 0;
      response = null;
      responseType = '';
      open() {}
      send() {}
      abort() {
        this.dispatchEvent(new Event('abort'));
      }
    }

    beforeEach(() => vi.stubGlobal('XMLHttpRequest', FakeXhr));
    afterEach(() => vi.unstubAllGlobals());

    it('settles an in-flight upload as aborted when uploads are cancelled', async () => {
      const request = uploadRequest({ url: '/api/assets', data: new FormData() });
      cancelUploadRequests();
      await expect(request).rejects.toBeInstanceOf(AbortError);
    });
  });

  describe('FL-115 playback cache key', () => {
    afterEach(() => {
      resetPlaybackRevisions();
      authManager.reset();
    });

    const photo = () =>
      assetFactory.build({
        originalPath: 'image.heic',
        originalMimeType: 'image/heic',
        type: AssetTypeEnum.Image,
        thumbhash: 'hash',
      });

    it('focused Auto/SDR uses derivatives without changing grids or original downloads', () => {
      const asset = photo();
      const original = getAssetUrls(asset);
      const auto = getAssetUrls(asset, undefined, 'auto');
      const sdr = getAssetUrls(asset, undefined, 'sdr');
      expect(auto.thumbnail).toBe(original.thumbnail);
      expect(new URL(auto.preview, 'http://x').searchParams.get('dynamicRange')).toBe('auto');
      const full = new URL(auto.original, 'http://x');
      expect(full.pathname).toContain('/thumbnail');
      expect(full.searchParams.get('size')).toBe('fullsize');
      expect(full.searchParams.get('edited')).toBe('true');
      expect(new URL(sdr.original, 'http://x').searchParams.get('dynamicRange')).toBe('sdr');
      expect(getAssetUrls(asset)).toEqual(original);
      const animated = { ...asset, originalMimeType: 'image/gif', duration: 1 };
      expect(getAssetUrls(animated, undefined, 'auto')).toEqual(getAssetUrls(animated));
    });

    it('keys photo preview and full-size URLs on the thumbhash until the playback choice changes', () => {
      const asset = photo();
      const urls = getAssetUrls(asset);
      expect(new URL(urls.preview, 'http://x').searchParams.get('c')).toBe('hash');
      expect(new URL(urls.original, 'http://x').searchParams.get('c')).toBe('hash');
    });

    it('gives the photo preview and full-size URLs a fresh cache key after the playback choice changes', () => {
      const asset = photo();
      const before = getAssetUrls(asset);

      bumpPlaybackRevision(asset.id);
      const after = getAssetUrls(asset);

      expect(after.preview).not.toBe(before.preview);
      expect(after.original).not.toBe(before.original);
      expect(new URL(after.preview, 'http://x').searchParams.get('c')).toBe('hash-1');
      expect(new URL(after.original, 'http://x').searchParams.get('c')).toBe('hash-1');
      // Thumbnails are never replaced by a playback choice.
      expect(after.thumbnail).toBe(before.thumbnail);
    });

    it('only changes the cache key of the asset whose choice changed', () => {
      const chosen = photo();
      const other = photo();
      const otherBefore = getAssetUrls(other).preview;

      bumpPlaybackRevision(chosen.id);

      expect(getAssetUrls(other).preview).toBe(otherBefore);
    });

    it('uses the current develop revision in owner photo preview URLs across a fresh viewer load', () => {
      const asset = photo();
      const original = getAssetUrls(asset);
      authManager.setUser(userAdminFactory.build({ id: asset.ownerId }));
      authManager.setPreferences(preferencesFactory.build());
      setDevelopPlaybackRevision(asset.id, 'rendered-revision');
      const developed = getAssetUrls(asset);

      expect(new URL(developed.preview, 'http://x').searchParams.get('c')).toBe('hash-develop-rendered-revision');
      expect(developed.original).not.toBe(original.original);
      expect(developed.thumbnail).toBe(original.thumbnail);
      authManager.reset();
      expect(new URL(getAssetUrls(asset).preview, 'http://x').searchParams.get('c')).toBe('hash');
    });

    it('loads a developed JPEG master through full-size media instead of the original endpoint', () => {
      const asset = assetFactory.build({
        originalPath: 'image.jpg',
        originalMimeType: 'image/jpeg',
        type: AssetTypeEnum.Image,
        thumbhash: 'jpeg-hash',
      });
      authManager.setUser(userAdminFactory.build({ id: asset.ownerId }));
      authManager.setPreferences(preferencesFactory.build());
      expect(getAssetUrls(asset).original).toContain(`/${asset.id}/original`);

      setDevelopPlaybackRevision(asset.id, 'rendered-jpeg');

      const original = new URL(getAssetUrls(asset).original, 'http://x');
      expect(original.pathname).toContain(`/${asset.id}/thumbnail`);
      expect(original.searchParams.get('size')).toBe('fullsize');
      expect(original.searchParams.get('c')).toBe('jpeg-hash-develop-rendered-jpeg');
    });

    it('keeps preview and zoom on the media route when the current develop lookup fails', () => {
      const asset = assetFactory.build({
        originalPath: 'image.jpg',
        originalMimeType: 'image/jpeg',
        type: AssetTypeEnum.Image,
      });
      authManager.setUser(userAdminFactory.build({ id: asset.ownerId }));
      authManager.setPreferences(preferencesFactory.build());
      markDevelopPlaybackUnresolved(asset.id);
      bumpPlaybackRevision(asset.id);

      const urls = getAssetUrls(asset);
      expect(new URL(urls.preview, 'http://x').searchParams.get('size')).toBe('preview');
      expect(new URL(urls.original, 'http://x').searchParams.get('size')).toBe('fullsize');
      expect(new URL(urls.original, 'http://x').pathname).toContain(`/${asset.id}/thumbnail`);
    });
  });

  describe(getAssetUrl.name, () => {
    it('should return thumbnail URL for static images', () => {
      const asset = assetFactory.build({
        originalPath: 'image.jpg',
        originalMimeType: 'image/jpeg',
        type: AssetTypeEnum.Image,
      });

      const url = getAssetUrl({ asset });

      // Should return a thumbnail URL (contains /thumbnail)
      expect(url).toContain('/thumbnail');
      expect(url).toContain(asset.id);
    });

    it('should return thumbnail URL for static gifs', () => {
      const asset = assetFactory.build({
        originalPath: 'image.gif',
        originalMimeType: 'image/gif',
        type: AssetTypeEnum.Image,
      });

      const url = getAssetUrl({ asset });

      expect(url).toContain('/thumbnail');
      expect(url).toContain(asset.id);
    });

    it('should return thumbnail URL for static webp images', () => {
      const asset = assetFactory.build({
        originalPath: 'image.webp',
        originalMimeType: 'image/webp',
        type: AssetTypeEnum.Image,
      });

      const url = getAssetUrl({ asset });

      expect(url).toContain('/thumbnail');
      expect(url).toContain(asset.id);
    });

    it('should return original URL for animated gifs', () => {
      const asset = assetFactory.build({
        originalPath: 'image.gif',
        originalMimeType: 'image/gif',
        type: AssetTypeEnum.Image,
        duration: 2000,
      });

      const url = getAssetUrl({ asset });

      // Should return original URL (contains /original)
      expect(url).toContain('/original');
      expect(url).toContain(asset.id);
    });

    it('should return original URL for animated webp images', () => {
      const asset = assetFactory.build({
        originalPath: 'image.webp',
        originalMimeType: 'image/webp',
        type: AssetTypeEnum.Image,
        duration: 2000,
      });

      const url = getAssetUrl({ asset });

      expect(url).toContain('/original');
      expect(url).toContain(asset.id);
    });

    it('should return original URL for video assets with forceOriginal', () => {
      const asset = assetFactory.build({
        originalPath: 'video.mp4',
        originalMimeType: 'video/mp4',
        type: AssetTypeEnum.Video,
      });

      const url = getAssetUrl({ asset, forceOriginal: true });

      expect(url).toContain('/original');
      expect(url).toContain(asset.id);
    });

    it('should return thumbnail URL for video assets without forceOriginal', () => {
      const asset = assetFactory.build({
        originalPath: 'video.mp4',
        originalMimeType: 'video/mp4',
        type: AssetTypeEnum.Video,
      });

      const url = getAssetUrl({ asset });

      expect(url).toContain('/thumbnail');
      expect(url).toContain(asset.id);
    });

    it('should return thumbnail URL for static images in shared link even with download and showMetadata permissions', () => {
      const asset = assetFactory.build({
        originalPath: 'image.gif',
        originalMimeType: 'image/gif',
        type: AssetTypeEnum.Image,
      });
      const sharedLink = sharedLinkFactory.build({ allowDownload: true, showMetadata: true, assets: [asset] });

      const url = getAssetUrl({ asset, sharedLink });

      expect(url).toContain('/thumbnail');
      expect(url).toContain(asset.id);
    });

    it('should return original URL for animated images in shared link with download and showMetadata permissions', () => {
      const asset = assetFactory.build({
        originalPath: 'image.gif',
        originalMimeType: 'image/gif',
        type: AssetTypeEnum.Image,
        duration: 2000,
      });
      const sharedLink = sharedLinkFactory.build({ allowDownload: true, showMetadata: true, assets: [asset] });

      const url = getAssetUrl({ asset, sharedLink });

      expect(url).toContain('/original');
      expect(url).toContain(asset.id);
    });

    it('should return thumbnail URL (not original) for animated images when shared link download permission is false', () => {
      const asset = assetFactory.build({
        originalPath: 'image.gif',
        originalMimeType: 'image/gif',
        type: AssetTypeEnum.Image,
        duration: 2000,
      });
      const sharedLink = sharedLinkFactory.build({ allowDownload: false, assets: [asset] });

      const url = getAssetUrl({ asset, sharedLink });

      expect(url).toContain('/thumbnail');
      expect(url).not.toContain('/original');
      expect(url).toContain(asset.id);
    });

    it('should return thumbnail URL (not original) for animated images when shared link showMetadata permission is false', () => {
      const asset = assetFactory.build({
        originalPath: 'image.gif',
        originalMimeType: 'image/gif',
        type: AssetTypeEnum.Image,
        duration: 2000,
      });
      const sharedLink = sharedLinkFactory.build({ showMetadata: false, assets: [asset] });

      const url = getAssetUrl({ asset, sharedLink });

      expect(url).toContain('/thumbnail');
      expect(url).not.toContain('/original');
      expect(url).toContain(asset.id);
    });
  });
  describe('semverToName', () => {
    it('should not append release candidate tag if prelease is not set', () => {
      expect(semverToName({ major: 3, minor: 0, patch: 0, prerelease: null })).toEqual('v3.0.0');
    });

    it('uses the full pre-release identifier when the server sends it (FL-80)', () => {
      expect(semverToName({ major: 3, minor: 3, patch: 0, prerelease: 2, prereleaseName: 'beta.2' })).toEqual(
        'v3.3.0-beta.2',
      );
      expect(semverToName({ major: 3, minor: 3, patch: 0, prerelease: null, prereleaseName: 'alpha' })).toEqual(
        'v3.3.0-alpha',
      );
    });

    it('should append release candidate if set', () => {
      expect(semverToName({ major: 3, minor: 0, patch: 0, prerelease: 0 })).toEqual('v3.0.0-rc.0');
    });
  });
});
