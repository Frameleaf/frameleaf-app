import { isLocationRemoval, locationDraft, locationPatch } from '$lib/frameleaf/viewer-location';

describe('viewer location dialog (V-24)', () => {
  const located = locationDraft({
    latitude: 51.4,
    longitude: -116.2,
    city: 'Banff',
    state: 'Alberta',
    country: 'Canada',
  });
  const unplaced = locationDraft({ latitude: null, longitude: null, city: null, state: null, country: null });

  it('starts from the stored place and coordinates', () => {
    expect(located).toEqual({
      city: 'Banff',
      state: 'Alberta',
      country: 'Canada',
      latitude: '51.4',
      longitude: '-116.2',
    });
    expect(unplaced).toEqual({ city: '', state: '', country: '', latitude: '', longitude: '' });
  });

  it('sends nothing when nothing changed', () => {
    expect(locationPatch(located, { ...located, city: ' Banff ' })).toBeNull();
  });

  it('sends moved coordinates alone, so geocoding names the new spot', () => {
    expect(locationPatch(located, { ...located, latitude: '51.42', longitude: '-116.18' })).toEqual({
      latitude: 51.42,
      longitude: -116.18,
    });
  });

  it('sends a changed place name, and clears an emptied one', () => {
    expect(locationPatch(located, { ...located, city: 'Lake Louise', country: '' })).toEqual({
      city: 'Lake Louise',
      country: null,
    });
  });

  it('refuses a lone, out-of-range or unreadable coordinate', () => {
    expect(locationPatch(unplaced, { ...unplaced, latitude: '10' })).toBe('invalid');
    expect(locationPatch(unplaced, { ...unplaced, latitude: '95', longitude: '10' })).toBe('invalid');
    expect(locationPatch(unplaced, { ...unplaced, latitude: 'north', longitude: '10' })).toBe('invalid');
  });

  it('removes the location of an item when both coordinates are emptied (FL-51)', () => {
    const patch = locationPatch(located, { ...located, latitude: '', longitude: '', city: 'Elsewhere' });
    // the place names go with the location, so none is sent
    expect(patch).toEqual({ latitude: null, longitude: null });
    expect(isLocationRemoval(patch)).toBe(true);
    expect(isLocationRemoval(locationPatch(located, { ...located, latitude: '51.42', longitude: '-116.18' }))).toBe(
      false,
    );
    expect(isLocationRemoval(locationPatch(unplaced, { ...unplaced, latitude: '', longitude: '' }))).toBe(false);
  });

  it('lets an unplaced item take a place name without coordinates', () => {
    expect(locationPatch(unplaced, { ...unplaced, city: 'Jasper' })).toEqual({ city: 'Jasper' });
  });

  it('reads a decimal comma', () => {
    expect(locationPatch(unplaced, { ...unplaced, latitude: '10,5', longitude: '20' })).toEqual({
      latitude: 10.5,
      longitude: 20,
    });
  });
});
