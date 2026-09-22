import type { AssetResponseDto } from '@immich/sdk';
import { describe, expect, it } from 'vitest';
import { buildCountryStateGroups } from '$lib/frameleaf/places';

const place = (
  id: string,
  exif: Partial<{ country: string | null; state: string | null; latitude: number | null; longitude: number | null }>,
): AssetResponseDto =>
  ({
    id,
    exifInfo: {
      city: null,
      country: null,
      state: null,
      latitude: null,
      longitude: null,
      ...exif,
    },
  }) as unknown as AssetResponseDto;

describe('Frameleaf places country/state grouping', () => {
  it('nests states under their country and counts every place once', () => {
    const groups = buildCountryStateGroups(
      [
        place('a', { country: 'Canada', state: 'Alberta', latitude: 51, longitude: -114 }),
        place('b', { country: 'Canada', state: 'Alberta', latitude: 53, longitude: -116 }),
        place('c', { country: 'Canada', state: 'British Columbia', latitude: 49, longitude: -123 }),
        place('d', { country: 'Japan', state: 'Tokyo', latitude: 35.7, longitude: 139.7 }),
      ],
      'Unknown country',
      'Unknown state',
    );

    expect(groups.map((group) => group.name)).toEqual(['Canada', 'Japan']);
    const canada = groups[0];
    expect(canada.count).toBe(3);
    expect(canada.states.map((state) => state.name)).toEqual(['Alberta', 'British Columbia']);
    expect(canada.states[0].places.map((p) => p.id)).toEqual(['a', 'b']);
  });

  it('averages located coordinates for the "show on map" link and leaves unlocated states null', () => {
    const groups = buildCountryStateGroups(
      [
        place('a', { country: 'Canada', state: 'Alberta', latitude: 50, longitude: -110 }),
        place('b', { country: 'Canada', state: 'Alberta', latitude: 52, longitude: -112 }),
        place('c', { country: 'Canada', state: 'Nunavut', latitude: null, longitude: null }),
      ],
      'Unknown country',
      'Unknown state',
    );

    const [alberta, nunavut] = groups[0].states;
    expect(alberta.latitude).toBeCloseTo(51);
    expect(alberta.longitude).toBeCloseTo(-111);
    expect(nunavut.latitude).toBeNull();
    expect(nunavut.longitude).toBeNull();
  });

  it('groups assets with no country or state under the unknown placeholders, sorted last', () => {
    const groups = buildCountryStateGroups(
      [place('a', { country: null, state: null }), place('b', { country: 'Canada', state: null })],
      'Unknown country',
      'Unknown state',
    );

    expect(groups.map((group) => group.name)).toEqual(['Canada', 'Unknown country']);
    expect(groups[0].states.map((state) => state.name)).toEqual(['Unknown state']);
  });
});
