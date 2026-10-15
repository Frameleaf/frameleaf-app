import { eventManager } from '$lib/managers/event-manager.svelte';
import { userInteraction } from '$lib/stores/user.svelte';
import { albumFactory } from '@test-data/factories/album-factory';

it('clears cached albums on logout even after the reactive cache has been populated', () => {
  userInteraction.recentAlbums = [albumFactory.build()];
  eventManager.emit('AuthLogout');
  expect(userInteraction.recentAlbums).toBeUndefined();
});
