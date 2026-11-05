import { AssetTypeEnum, type MapMarkerResponseDto } from '@frameleaf/sdk';
import {
  clusterPoint,
  markerCardLine,
  markerDetail,
  markerPoint,
  markerRowLine,
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
    });
    expect(cell).toEqual({ id: 'c', lat: 3, lon: 4, count: 40, videos: 5, place: 'Ontario, Canada' });
    expect(pointCounts([cell, markerPoint(marker({ type: AssetTypeEnum.Video }))])).toEqual({
      items: 41,
      photos: 35,
      videos: 6,
    });
  });
});
