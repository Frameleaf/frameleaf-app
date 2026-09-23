import { describe, expect, it } from 'vitest';
import {
  buildRailSections,
  defaultRailCapabilities,
  isDestinationCurrent,
  type RailCapabilities,
  type RailDestination,
} from '$lib/frameleaf/navigation';
import { Route } from '$lib/route';

const allCapabilities = (): RailCapabilities => ({
  search: true,
  map: true,
  trash: true,
  people: true,
  memories: true,
  tags: true,
  folders: true,
  sharedLinks: true,
});

const flatten = (capabilities: RailCapabilities) =>
  buildRailSections(capabilities).flatMap((section) => section.destinations);

const find = (capabilities: RailCapabilities, id: RailDestination['id']) =>
  flatten(capabilities).find((destination) => destination.id === id);

describe('Frameleaf rail destinations', () => {
  it('keeps the approved section order', () => {
    expect(buildRailSections(allCapabilities()).map((section) => section.id)).toEqual([
      'library',
      'albums',
      'spaces',
      'explore',
      'tools',
      'footer',
    ]);
  });

  it('opens with Library, Favorites, Recently added, Best Photos, Archive and Locked', () => {
    const [library] = buildRailSections(allCapabilities());

    expect(library.destinations.map((destination) => destination.id)).toEqual([
      'library',
      'favorites',
      'recentlyAdded',
      'bestPhotos',
      'archive',
      'locked',
    ]);
  });

  it('points Locked at the sensitive timeline, not the upstream locked folder', () => {
    const locked = find(allCapabilities(), 'locked');

    expect(locked?.href).toBe(Route.suppressed());
    expect(locked?.href).not.toBe(Route.locked());
  });

  it('hides destinations the account has turned off, without touching the rest', () => {
    const capabilities = { ...allCapabilities(), map: false, tags: false, sharedLinks: false };
    const ids = new Set(flatten(capabilities).map((destination) => destination.id));

    expect(ids.has('map')).toBe(false);
    expect(ids.has('tags')).toBe(false);
    expect(ids.has('sharedLinks')).toBe(false);
    expect(ids.has('people')).toBe(true);
    expect(ids.has('allAlbums')).toBe(true);
  });

  it('keeps Pets next to People and never hides it behind an account preference', () => {
    const explore = buildRailSections(allCapabilities()).find((section) => section.id === 'explore');
    const ids = explore?.destinations.map((destination) => destination.id) ?? [];

    expect(ids.indexOf('pets')).toBe(ids.indexOf('people') + 1);
    // Pets is a Frameleaf feature with no upstream feature preference behind it, so no
    // capability can remove it.
    expect(flatten(defaultRailCapabilities()).some((destination) => destination.id === 'pets')).toBe(true);
    expect(find(allCapabilities(), 'pets')?.href).toBe(Route.pets());
  });

  it('always keeps the destinations that do not depend on a capability', () => {
    const ids = new Set(flatten(defaultRailCapabilities()).map((destination) => destination.id));

    expect([...ids]).toEqual([
      'library',
      'favorites',
      'recentlyAdded',
      'bestPhotos',
      'archive',
      'locked',
      'allAlbums',
      'sharing',
      'pets',
      'places',
      'studio',
      'workflows',
      'libraryCare',
      'settings',
      'support',
    ]);
  });

  it('offers one utilities entry and no repeated utility shortcuts', () => {
    const hrefs = flatten(allCapabilities()).map((destination) => destination.href);

    expect(hrefs.filter((href) => href === Route.utilities())).toHaveLength(1);
    expect(hrefs).not.toContain(Route.duplicatesUtility());
    expect(hrefs).not.toContain(Route.largeFileUtility());
    expect(hrefs).not.toContain(Route.livePhotosUtility());
  });

  it('never lists the same destination twice', () => {
    const ids = flatten(allCapabilities()).map((destination) => destination.id);

    expect(new Set(ids).size).toBe(ids.length);
  });

  it('marks a destination current for its own page and its child routes', () => {
    const library = find(allCapabilities(), 'library')!;

    expect(isDestinationCurrent(Route.photos(), library)).toBe(true);
    expect(isDestinationCurrent('/photos/asset-id', library)).toBe(true);
    expect(isDestinationCurrent('/photos-of-something', library)).toBe(false);
    expect(isDestinationCurrent(Route.favorites(), library)).toBe(false);
  });

  it('leaves an album page to its tree item instead of All albums', () => {
    const allAlbums = find(allCapabilities(), 'allAlbums')!;

    expect(isDestinationCurrent(Route.albums(), allAlbums)).toBe(true);
    expect(isDestinationCurrent(Route.viewAlbum({ id: 'album-id' }), allAlbums)).toBe(false);
  });
});
