import { clearPrivateBrowserState, getPrivateBrowserStateGeneration } from '$lib/frameleaf/private-browser-state';
import { geolocationManager } from './geolocation.manager.svelte';

it('forgets the previous session point when private browser state is cleared', () => {
  const previous = { lat: 48.2, lng: 16.4 };
  geolocationManager.onSelected(previous, getPrivateBrowserStateGeneration());
  expect(geolocationManager.lastPoint).toEqual(previous);
  clearPrivateBrowserState();
  expect(geolocationManager.lastPoint).toBeUndefined();
  const current = { lat: -33.9, lng: 151.2 };
  geolocationManager.onSelected(current, getPrivateBrowserStateGeneration());
  expect(geolocationManager.lastPoint).toEqual(current);
});
