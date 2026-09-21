import type { ServerFeaturesDto, UserPreferencesResponseDto } from '@immich/sdk';
import type { Translations } from 'svelte-i18n';
import { Route } from '$lib/route';
import registry from './route-registry.json';

export const navigationSections = ['library', 'collections', 'settings'] as const;
type NavigationRoute = keyof Pick<
  typeof Route,
  | 'photos'
  | 'favorites'
  | 'recentlyAdded'
  | 'bestPhotos'
  | 'explore'
  | 'map'
  | 'memories'
  | 'people'
  | 'archive'
  | 'locked'
  | 'suppressed'
  | 'albums'
  | 'tags'
  | 'folders'
  | 'sharing'
  | 'sharedLinks'
  | 'userSettings'
  | 'utilities'
  | 'trash'
>;

// Navigation visibility is not authorization. Existing route loaders and APIs remain authoritative.
export function getNavigation(features: ServerFeaturesDto, preferences: UserPreferencesResponseDto) {
  return registry.navigation
    .filter(({ gate }) => {
      switch (gate) {
        case 'search':
        case 'map':
        case 'trash': {
          return features[gate];
        }
        case 'memories':
        case 'people':
        case 'sharedLinks':
        case 'tags':
        case 'folders': {
          return preferences[gate].enabled && preferences[gate].sidebarWeb;
        }
        case 'recentlyAdded': {
          return preferences.recentlyAdded.sidebarWeb;
        }
        default: {
          return gate === undefined;
        }
      }
    })
    .map((entry) => ({ ...entry, label: entry.label as Translations, href: Route[entry.route as NavigationRoute]() }));
}
