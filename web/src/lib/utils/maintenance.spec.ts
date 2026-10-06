import { getMaintenanceStatus, MaintenanceAction } from '@frameleaf/sdk';
import { get } from 'svelte/store';
import { maintenanceStore } from '$lib/stores/maintenance.store';
import { websocketStore } from '$lib/stores/websocket';
import { loadMaintenanceStatus, maintenanceCreateUrl, maintenanceReturnUrl } from '$lib/utils/maintenance';

vi.mock('@frameleaf/sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@frameleaf/sdk')>()),
  getMaintenanceStatus: vi.fn(),
}));

describe('maintenance', () => {
  describe(loadMaintenanceStatus.name, () => {
    afterEach(() => vi.restoreAllMocks());

    it.each([true, false])('only updates restart readiness for inactive End (active=%s)', async (active) => {
      const status = { active, action: MaintenanceAction.End };
      vi.mocked(getMaintenanceStatus).mockResolvedValue(status);
      const restart = vi.spyOn(websocketStore.serverRestarting, 'set');
      await loadMaintenanceStatus();
      expect(get(maintenanceStore.status)).toEqual(status);
      if (active) {
        expect(restart).not.toHaveBeenCalled();
      } else {
        expect(restart).toHaveBeenCalledExactlyOnceWith({ isMaintenanceMode: false });
      }
    });
  });

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
      const settings = new URL('https://photos.example.com/maintenance');
      settings.searchParams.set('continue', '/user-settings?area=maintenance&section=mode');
      expect(maintenanceReturnUrl(settings.searchParams)).property(
        'href',
        'https://photos.example.com/user-settings?area=maintenance&section=mode',
      );
    });

    it('should fall back to the root route when continue is missing', () => {
      expect(maintenanceReturnUrl(new URLSearchParams())).property('href', 'https://photos.example.com/');
    });

    it('should reject a cross-origin continue url', () => {
      expect(maintenanceReturnUrl(new URLSearchParams({ continue: 'https://malicious.site/evil' }))).toBe('/');
    });
  });

  describe(maintenanceCreateUrl.name, () => {
    it('keeps an ordinary address to continue to', () => {
      expect(maintenanceCreateUrl(new URL('https://photos.example.com/albums?x=1'))).toContain(
        encodeURIComponent('/albums?x=1'),
      );
    });

    it('never carries a licence link code or key on into the maintenance address (CLD-004)', () => {
      for (const address of [
        'https://photos.example.com/link?target=frameleaf_license&linkCode=flc_jf23qnbc4wvmpnuogenclb2hyo',
        'https://photos.example.com/link?target=activate_license&licenseKey=FL-S8NL-49G8-J583',
      ]) {
        const url = maintenanceCreateUrl(new URL(address));
        expect(url).not.toContain('flc_');
        expect(url).not.toContain('FL-S8NL');
        expect(decodeURIComponent(url)).toMatch(/continue=\/link$/);
      }
    });
  });
});
