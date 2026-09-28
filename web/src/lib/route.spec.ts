import { OpenQueryParam } from '$lib/constants';
import { Route } from '$lib/route';

describe('Route', () => {
  describe(Route.login.name, () => {
    it('should encode continue', () => {
      expect(Route.login({ continue: '/some/path?with=query', autoLaunch: 1 })).toBe(
        '/auth/login?continue=%2Fsome%2Fpath%3Fwith%3Dquery&autoLaunch=1',
      );
    });
  });

  describe(Route.search.name, () => {
    it('should work', () => {
      expect(Route.search({})).toBe('/search');
    });

    it('should work', () => {
      expect(Route.search({ make: undefined, model: 'Immich' })).toBe('/search?query=%7B%22model%22%3A%22Immich%22%7D');
    });

    it('should support query parameters', () => {
      expect(Route.systemSettings({ isOpen: OpenQueryParam.OAUTH })).toBe(
        '/user-settings?area=security&section=authentication&isOpen=oauth',
      );
    });
  });

  describe(Route.physicalDeduplication.name, () => {
    it('should work', () => {
      expect(Route.physicalDeduplication()).toBe('/user-settings?area=storage&section=deduplication');
    });
  });

  describe(Route.viewSharedLink.name, () => {
    it('should work with key', () => {
      expect(Route.viewSharedLink({ key: 'uuid-key' })).toBe('/share/uuid-key');
    });

    it('should work with key and slug', () => {
      expect(Route.viewSharedLink({ key: 'uuid-key', slug: 'custom-slug' })).toBe('/s/custom-slug');
    });

    it('should URI encode slug', () => {
      expect(Route.viewSharedLink({ key: 'uuid-key', slug: 'albums/the-moon?' })).toBe('/s/albums%2Fthe-moon%3F');
    });
  });

  describe(Route.viewSharedSpaceAsset.name, () => {
    it('keeps the viewer inside the shared space', () => {
      expect(Route.viewSharedSpace({ id: 'space-1' })).toBe('/sharing/space-1');
      expect(Route.viewSharedSpaceAsset({ spaceId: 'space-1', assetId: 'asset-1' })).toBe(
        '/sharing/space-1/photos/asset-1',
      );
    });
  });

  describe(Route.tags.name, () => {
    it('should work', () => {
      expect(Route.tags()).toBe('/tags');
    });

    it('should support query parameters', () => {
      expect(Route.tags({ path: '/some/path' })).toBe('/tags?path=%2Fsome%2Fpath');
    });

    it('should ignore an empty path', () => {
      expect(Route.tags({ path: '' })).toBe('/tags');
    });
  });

  describe(Route.recentlyAdded.name, () => {
    it('returns the recently added route', () => {
      expect(Route.recentlyAdded()).toBe('/recently-added');
      expect(Route.recentlyAdded({ at: 'asset-1' })).toBe('/recently-added?at=asset-1');
    });

    it('returns the recently added asset route', () => {
      expect(Route.viewRecentlyAddedAsset({ id: 'asset-1' })).toBe('/recently-added/asset-1');
    });
  });

  describe(Route.bestPhotos.name, () => {
    it('returns the best photos route', () => {
      expect(Route.bestPhotos()).toBe('/best-photos');
      expect(Route.bestPhotos({ page: 2, limit: 50, minScore: 0.75 })).toBe(
        '/best-photos?page=2&limit=50&minScore=0.75',
      );
    });

    it('returns the best photos asset route', () => {
      expect(Route.viewBestPhotosAsset({ id: 'asset-1' })).toBe('/best-photos/photos/asset-1');
    });
  });

  describe(Route.systemSettings.name, () => {
    it('should work', () => {
      expect(Route.systemSettings()).toBe('/user-settings');
    });

    it('should support query parameters', () => {
      expect(Route.systemSettings({ isOpen: OpenQueryParam.OAUTH })).toBe(
        '/user-settings?area=security&section=authentication&isOpen=oauth',
      );
    });
  });

  describe(Route.continue.name, () => {
    beforeEach(() => {
      // @ts-expect-error - override location for testing
      // eslint-disable-next-line unicorn/no-global-object-property-assignment
      globalThis.location = new URL('https://photos.example.com');
      vi.spyOn(document, 'baseURI', 'get').mockReturnValue('https://photos.example.com/');
    });

    it('should resolve relative URLs', () => {
      expect(Route.continue('/some/path', '/fallback')).property('href', 'https://photos.example.com/some/path');
    });

    it('should resolve absolute URLs on the same origin', () => {
      expect(Route.continue('https://photos.example.com/some/path', '/fallback')).property(
        'href',
        'https://photos.example.com/some/path',
      );
    });

    it('should return fallback for absolute URLs on a different origin', () => {
      expect(Route.continue('https://malicious.site/evil', '/fallback')).toBe('/fallback');
    });

    it('should return fallback for null URLs', () => {
      expect(Route.continue(null, '/fallback')).property('href', 'https://photos.example.com/fallback');
    });

    it('should block javascript: URLs', () => {
      expect(Route.continue('javascript:alert(1)', '/fallback')).toBe('/fallback');
    });

    it(String.raw`should block \/ URLs`, () => {
      expect(Route.continue(String.raw`\/malicious.com`, '/fallback')).toBe('/fallback');
    });
  });
});
