import { AssetTypeEnum, type MapMarkerResponseDto } from '@immich/sdk';
import { markerCardLine, markerDetail, markerRowLine, markerTypeCounts } from '$lib/frameleaf/map-markers';

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
    expect(markerTypeCounts([marker(), video, marker()])).toEqual({ photos: 2, videos: 1 });
  });
});
