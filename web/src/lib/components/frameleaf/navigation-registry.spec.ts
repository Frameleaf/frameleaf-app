import type { ServerFeaturesDto } from '@immich/sdk';
import { preferencesFactory } from '$lib/../test-data/factories/preferences-factory';
import { Route } from '$lib/route';
import inventory from '../../../../../docs/docs/developer/frameleaf-route-inventory.json';
import { getNavigation } from './navigation-registry';
import registry from './route-registry.json';

const features = { search: true, map: true, trash: true } as ServerFeaturesDto;
const preferences = preferencesFactory.build({
  folders: { enabled: true, sidebarWeb: true },
  people: { enabled: true, sidebarWeb: true },
  memories: { enabled: true, sidebarWeb: true, duration: 5 },
  sharedLinks: { enabled: true, sidebarWeb: true },
  tags: { enabled: true, sidebarWeb: true },
  recentlyAdded: { sidebarWeb: true },
});

describe('production navigation registry', () => {
  it('keeps only real destinations, with Timeline first and utilities under Settings', () => {
    const entries = getNavigation(features, preferences);
    expect(entries).toHaveLength(registry.navigation.length);
    expect(entries[0]).toMatchObject({ id: 'timeline', href: Route.photos() });
    expect(new Set(entries.map(({ href }) => href)).size).toBe(entries.length);
    for (const { href } of entries) {
      expect(inventory.productionRoutes.some((route) => route === href || route.startsWith(`${href}/[[`))).toBe(true);
    }
    expect(entries.find(({ id }) => id === 'utilities')).toMatchObject({
      section: 'settings',
      href: Route.utilities(),
    });
    expect(entries.find(({ id }) => id === 'trash')).toMatchObject({ section: 'settings', href: Route.trash() });
    expect(entries.map(({ href }) => href)).not.toContain('/studio');
    expect(entries.map(({ href }) => href)).not.toContain('/utilities/duplicates');
  });

  it.each(['search', 'map', 'trash'] as const)('preserves the disabled %s server capability', (gate) => {
    expect(getNavigation({ ...features, [gate]: false }, preferences).some((entry) => entry.gate === gate)).toBe(false);
  });

  it.each(['folders', 'people', 'memories', 'sharedLinks', 'tags'] as const)(
    'preserves independent enabled and sidebar preferences for %s',
    (gate) => {
      for (const overrides of [{ enabled: false }, { sidebarWeb: false }]) {
        const changed = { ...preferences, [gate]: { ...preferences[gate], ...overrides } };
        expect(getNavigation(features, changed).some((entry) => entry.gate === gate)).toBe(false);
      }
    },
  );

  it('honors Recently added visibility without a duplicate shortcut', () => {
    const changed = { ...preferences, recentlyAdded: { sidebarWeb: false } };
    expect(getNavigation(features, changed).some((entry) => entry.id === 'recentlyAdded')).toBe(false);
  });
});
