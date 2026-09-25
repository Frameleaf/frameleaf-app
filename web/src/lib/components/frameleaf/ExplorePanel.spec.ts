import { AssetTypeEnum } from '@immich/sdk';
import { fireEvent, render, screen, within } from '@testing-library/svelte';
import { init, register, waitLocale } from 'svelte-i18n';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { buildExplorePeople, buildExplorePlaces, buildExploreThings } from '$lib/frameleaf/explore';
import { albumFactory } from '@test-data/factories/album-factory';
import { assetFactory } from '@test-data/factories/asset-factory';
import { personFactory } from '@test-data/factories/person-factory';
import ExplorePanel from './ExplorePanel.svelte';

const jamie = personFactory.build({ id: 'jamie', name: 'Jamie', isHidden: false });
const clip = assetFactory.build({
  id: 'clip',
  type: AssetTypeEnum.Video,
  originalFileName: 'IMG_0042.MOV',
  localDateTime: '2026-08-02T21:15:00.000Z',
});
const still = assetFactory.build({ id: 'still', type: AssetTypeEnum.Image, originalFileName: 'IMG_0041.HEIC' });

const props = (overrides: Record<string, unknown> = {}) => ({
  people: buildExplorePeople([{ value: 'jamie', count: 12 }], [jamie]),
  places: buildExplorePlaces([{ value: 'Paris', count: 4 }]),
  things: buildExploreThings([{ value: 'tag-1', label: 'beach', count: 1, coverAssetId: 'beach-cover' }]),
  recents: [clip, still],
  memories: [{ id: 'm1', title: '1 year ago', href: '/memory', alt: '', src: '/m.jpg', count: 3 }],
  albums: [albumFactory.build({ id: 'a1', albumName: 'Summer', assetCount: 5 })],
  bestPhotos: { total: 2, cover: null },
  shortcutCounts: { favorites: 1, photos: 2, videos: 3, withoutPeople: 4 },
  libraryTotal: 40,
  onViewAsset: vi.fn(),
  ...overrides,
});

/** T-12 (ExploreLibrary.jsx:60-274): counted cards, "Things in your photos" and Recent captures details. */
describe('ExplorePanel', () => {
  beforeAll(async () => {
    await init({ fallbackLocale: 'en-US' });
    register('en-US', () => import('$i18n/en.json'));
    await waitLocale('en-US');
  });

  it('counts every person, place, memory and thing card', () => {
    render(ExplorePanel, props());

    const people = within(screen.getByRole('region', { name: 'People' }));
    expect(people.getByRole('link', { name: /Jamie/ })).toHaveTextContent('12 items');
    const places = within(screen.getByRole('region', { name: 'Places' }));
    expect(places.getByRole('link', { name: /Paris/ })).toHaveTextContent('4 items');
    const memories = within(screen.getByRole('region', { name: 'Days to revisit' }));
    expect(memories.getByRole('link', { name: /1 year ago/ })).toHaveTextContent('3 items');
    const things = within(screen.getByRole('region', { name: 'Things in your photos' }));
    const thing = things.getByRole('link', { name: /beach/ });
    expect(thing).toHaveTextContent('1 item');
    expect(thing.getAttribute('href')).toContain('tagIds');
  });

  it('opens the same search the person and place counts came from', () => {
    render(ExplorePanel, props());
    expect(screen.getByRole('link', { name: /Jamie/ }).getAttribute('href')).toContain('personIds');
    expect(screen.getByRole('link', { name: /Paris/ }).getAttribute('href')).toContain('city');
  });

  it('shows each recent capture with its name, a Video label and its capture day', async () => {
    const onViewAsset = vi.fn();
    render(ExplorePanel, props({ onViewAsset }));

    const recent = within(screen.getByRole('region', { name: 'Recent captures' }));
    const video = recent.getByRole('button', { name: 'Open IMG_0042.MOV' });
    expect(video).toHaveTextContent('IMG_0042.MOV');
    expect(video).toHaveTextContent('Video');
    expect(video).toHaveTextContent('2026-08-02');
    expect(recent.getByRole('button', { name: 'Open IMG_0041.HEIC' })).not.toHaveTextContent('Video');

    await fireEvent.click(video);
    expect(onViewAsset).toHaveBeenCalledWith('clip');
  });

  it('leaves out a section with nothing in it', () => {
    render(ExplorePanel, props({ things: [], people: [] }));
    expect(screen.queryByRole('region', { name: 'Things in your photos' })).toBeNull();
    expect(screen.queryByRole('region', { name: 'People' })).toBeNull();
  });

  it('covers a thing with the newest match its facet returned', () => {
    render(ExplorePanel, props());
    const thing = within(screen.getByRole('region', { name: 'Things in your photos' })).getByRole('link');
    expect(thing.querySelector('img')?.getAttribute('src')).toContain('beach-cover');
  });

  it('points an empty library at uploading, in the prototype empty-state pattern', () => {
    render(ExplorePanel, props({ libraryTotal: 0 }));
    expect(screen.getByRole('status')).toHaveTextContent('Nothing to explore yet');
    expect(screen.getByRole('status')).toHaveTextContent('Upload photos and videos');
    expect(screen.queryByRole('region', { name: 'People' })).toBeNull();
  });
});
