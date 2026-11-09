import { describe, expect, it } from 'vitest';
import {
  albumNameKey,
  countCleanupSuggestions,
  detectHomeAreas,
  distanceKm,
  isDateOnlyName,
} from 'src/utils/album-cleanup.js';

describe('isDateOnlyName', () => {
  it.each(['May 24, 2020', '2020-05-24', '24 May 2020', '5/24/2020', 'May 2020'])('accepts %s', (name) => {
    expect(isDateOnlyName(name)).toBe(true);
  });

  it.each(['Coquitlam, May 24, 2020', 'Trips - 2016', 'Hello, World'])('refuses %s', (name) => {
    expect(isDateOnlyName(name)).toBe(false);
  });
});

describe('albumNameKey', () => {
  it('ignores case and repeated spaces', () => {
    expect(albumNameKey('  Friends  -  Patrick ')).toBe('friends - patrick');
  });
});

describe('countCleanupSuggestions', () => {
  const none = { albums: [], sameName: [], samePhotos: [], sameTrip: [], lostDates: [] };

  it('counts each album once, whatever it was found for', () => {
    const albums = [
      { id: 'a', name: 'Friends - Patrick' },
      { id: 'b', name: 'Friends - Sarah' },
      { id: 'c', name: 'May 24, 2020' },
      { id: 'd', name: 'Lonely - One' },
    ];
    expect(
      countCleanupSuggestions({
        ...none,
        albums,
        sameName: [{ albumIds: ['a', 'b'] }],
        lostDates: [{ albumId: 'a' }],
      }),
    ).toBe(3);
  });

  it('finds nothing to mention in a clean library', () => {
    expect(countCleanupSuggestions({ ...none, albums: [{ id: 'a', name: 'Holiday' }] })).toBe(0);
  });

  it('does not count albums the review leaves where they are', () => {
    expect(
      countCleanupSuggestions({
        ...none,
        albums: [
          { id: 'a', name: 'May 24, 2020', parentId: 'collection' },
          { id: 'b', name: 'May 25, 2020', readOnly: true },
        ],
      }),
    ).toBe(0);
  });

  it('reads a date as one piece', () => {
    expect(
      countCleanupSuggestions({
        ...none,
        albums: [
          { id: 'a', name: 'Coquitlam, May 24, 2020' },
          { id: 'b', name: 'Coquitlam, May 25, 2020' },
        ],
      }),
    ).toBe(2);
  });
});

describe('detectHomeAreas', () => {
  const coquitlam = { lat: 49.3, lon: -122.8 };
  const vancouver = { lat: 49.25, lon: -123.1 };
  const maui = { lat: 20.8, lon: -156.3 };

  it('labels the densest cluster by its most common city, and groups what is within 100 km', () => {
    const areas = detectHomeAreas([
      { ...coquitlam, count: 500, city: 'Coquitlam' },
      { ...vancouver, count: 100, city: 'Vancouver' },
      { ...maui, count: 40, city: 'Lahaina' },
    ]);
    expect(areas.map(({ city, photoCount }) => ({ city, photoCount }))).toEqual([
      { city: 'Coquitlam', photoCount: 600 },
      { city: 'Lahaina', photoCount: 40 },
    ]);
    expect(distanceKm(areas[0], coquitlam)).toBeLessThan(100);
  });

  it('offers at most the five largest clusters', () => {
    const bins = Array.from({ length: 8 }, (_, index) => ({
      lat: index * 10,
      lon: 0,
      count: 100 - index,
      city: `City ${index}`,
    }));
    expect(detectHomeAreas(bins).map(({ city }) => city)).toEqual(['City 0', 'City 1', 'City 2', 'City 3', 'City 4']);
  });

  it('has no home when no photo has a location', () => {
    expect(detectHomeAreas([])).toEqual([]);
  });

  it('still answers when the cluster has no city name', () => {
    expect(detectHomeAreas([{ ...maui, count: 5, city: null }])[0].city).toBeNull();
  });
});
