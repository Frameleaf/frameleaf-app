import { type NamedPlaceArea, distanceMeters, dominantNamedPlace, namedPlaceAt } from 'src/utils/named-place.js';

const place = (
  id: string,
  name: string,
  latitude: number,
  longitude: number,
  radiusMeters: number,
): NamedPlaceArea => ({
  id,
  name,
  latitude,
  longitude,
  radiusMeters,
});

// about 111 m a thousandth of a degree of latitude
const home = place('a', 'Home', 51.05, -114.07, 200);
const garden = place('b', 'Garden', 51.051, -114.07, 60);
const cabin = place('c', 'Cabin', 51.4254, -116.1773, 500);

describe('named places', () => {
  it('measures as the database does', () => {
    // Calgary Tower to the Banff townsite: about 111 km on the earthdistance sphere
    const metres = distanceMeters(
      { latitude: 51.0443, longitude: -114.0631 },
      { latitude: 51.1784, longitude: -115.5708 },
    );
    expect(metres).toBeGreaterThan(105_000);
    expect(metres).toBeLessThan(107_000);
    expect(distanceMeters(home, home)).toBe(0);
  });

  it('names a point by the place that holds it, and nothing outside every place', () => {
    expect(namedPlaceAt([home, cabin], { latitude: 51.0505, longitude: -114.07 })?.name).toBe('Home');
    expect(namedPlaceAt([home, cabin], { latitude: 51.4254, longitude: -116.1773 })?.name).toBe('Cabin');
    expect(namedPlaceAt([home, cabin], { latitude: 51.06, longitude: -114.07 })).toBeNull();
    expect(namedPlaceAt([home], { latitude: null, longitude: null })).toBeNull();
    expect(namedPlaceAt([], { latitude: 51.05, longitude: -114.07 })).toBeNull();
  });

  it('takes the nearest centre where places overlap', () => {
    // inside both circles: 22 m from the garden's centre, 89 m from home's
    expect(namedPlaceAt([home, garden], { latitude: 51.0508, longitude: -114.07 })?.name).toBe('Garden');
    expect(namedPlaceAt([garden, home], { latitude: 51.0508, longitude: -114.07 })?.name).toBe('Garden');
    // inside both, nearer home's centre
    expect(namedPlaceAt([home, garden], { latitude: 51.0504, longitude: -114.07 })?.name).toBe('Home');
    // same centre: the smaller place, whatever the order
    const porch = place('d', 'Porch', 51.05, -114.07, 30);
    expect(namedPlaceAt([home, porch], home)?.name).toBe('Porch');
    expect(namedPlaceAt([porch, home], home)?.name).toBe('Porch');
  });

  it('names a memory only when one place holds at least 60% of its photos', () => {
    const atHome = { latitude: 51.05, longitude: -114.07 };
    const away = { latitude: 49.28, longitude: -123.12 };
    const unplaced = { latitude: null, longitude: null };
    expect(dominantNamedPlace([home, cabin], [atHome, atHome, atHome, away, away])?.name).toBe('Home');
    expect(dominantNamedPlace([home, cabin], [atHome, atHome, away, away, unplaced])).toBeNull();
    expect(dominantNamedPlace([home, cabin], [])).toBeNull();
    expect(dominantNamedPlace([], [atHome])).toBeNull();
  });
});
