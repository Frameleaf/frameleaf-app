import { maintenanceReturnUrl } from '$lib/utils/maintenance';

describe('maintenance', () => {
  describe(maintenanceReturnUrl.name, () => {
    beforeEach(() => {
      // @ts-expect-error - override location for testing
      // eslint-disable-next-line unicorn/no-global-object-property-assignment
      globalThis.location = new URL('https://photos.example.com');
      vi.spyOn(document, 'baseURI', 'get').mockReturnValue('https://photos.example.com/');
    });

    it('should resolve a same-origin continue url', () => {
      expect(maintenanceReturnUrl(new URLSearchParams({ continue: '/photos' }))).property(
        'href',
        'https://photos.example.com/photos',
      );
    });

    it('should fall back to the root route when continue is missing', () => {
      expect(maintenanceReturnUrl(new URLSearchParams())).property('href', 'https://photos.example.com/');
    });

    it('should reject a cross-origin continue url', () => {
      expect(maintenanceReturnUrl(new URLSearchParams({ continue: 'https://malicious.site/evil' }))).toBe('/');
    });
  });
});
