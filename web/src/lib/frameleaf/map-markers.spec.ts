import { AssetTypeEnum, type MapMarkerResponseDto } from '@frameleaf/sdk';
import {
  clusterPoint,
  markerCardLine,
  markerDetail,
  markerPoint,
  markerRowLine,
  openingOrder,
  pointCounts,
} from '$lib/frameleaf/map-markers';

const marker = (overrides: Partial<MapMarkerResponseDto> = {}): MapMarkerResponseDto => ({
  id: 'a',
  lat: 1,
  lon: 2,
  city: 'Lisbon',
  state: 'Lisboa',
  country: 'Portugal',
  originalFileName: 'tram.jpg',
  localDateTime: '2026-08-02T23:30:00.000Z',
  type: AssetTypeEnum.Image,
  ...overrides,
});

describe('map markers (FL-51)', () => {
  it('describes an item by its file name, recorded day and place', () => {
    const detail = markerDetail(marker());
    expect(detail).toEqual({
      name: 'tram.jpg',
      day: '2026-08-02',
      place: 'Lisbon, Portugal',
      city: 'Lisbon',
      video: false,
    });
    expect(markerCardLine(detail)).toBe('2026-08-02 · Lisbon, Portugal');
    expect(markerRowLine(detail, 'Video')).toBe('2026-08-02 · Lisbon');
  });

  it('keeps the recorded local day whatever the browser zone', () => {
    expect(markerDetail(marker({ localDateTime: '2026-12-31T23:59:00.000Z' })).day).toBe('2026-12-31');
  });

  it('says nothing it does not know: no name, day or place', () => {
    const detail = markerDetail(
      marker({ originalFileName: undefined, localDateTime: undefined, city: null, state: null, country: null }),
    );
    expect(detail.name).toBeNull();
    expect(markerCardLine(detail)).toBe('');
  });

  it('labels a video row and counts photos and videos', () => {
    const video = marker({ type: AssetTypeEnum.Video, city: null });
    expect(markerRowLine(markerDetail(video), 'Video')).toBe('2026-08-02 · Video');
    expect(pointCounts([marker(), video, marker()].map((item) => markerPoint(item)))).toEqual({
      items: 3,
      photos: 2,
      videos: 1,
    });
  });

  it('adds up the items and videos of grouped cells with single items (FL-1214)', () => {
    const cell = clusterPoint({
      id: 'c',
      lat: 3,
      lon: 4,
      count: 40,
      videos: 5,
      city: null,
      state: 'Ontario',
      country: 'Canada',
      west: 2,
      south: 1,
      east: 6,
      north: 5,
    });
    expect(cell).toEqual({
      id: 'c',
      lat: 3,
      lon: 4,
      count: 40,
      videos: 5,
      place: 'Ontario, Canada',
      extent: { west: 2, south: 1, east: 6, north: 5 },
    });
    expect(pointCounts([cell, markerPoint(marker({ type: AssetTypeEnum.Video }))])).toEqual({
      items: 41,
      photos: 35,
      videos: 6,
    });
  });

  it('steps through the In view rows, or the single items in view when the rows do not hold it (FL-1214)', () => {
    const first = markerPoint(marker({ id: 'a' }));
    const second = markerPoint(marker({ id: 'b' }));
    const cell = clusterPoint({
      id: 'c',
      lat: 3,
      lon: 4,
      count: 40,
      videos: 0,
      city: null,
      state: null,
      country: null,
      west: 3,
      south: 3,
      east: 4,
      north: 4,
    });
    expect(openingOrder('b', [{ id: 'x' }, { id: 'b' }], [first, cell, second])).toEqual(['x', 'b']);
    // the list is closed, or its first page has not come yet
    expect(openingOrder('b', [], [first, cell, second])).toEqual(['a', 'b']);
  });
});
