import {
  BRAND_ZOOM,
  landmarksWithItems,
  layoutLandmarkPins,
  NAME_ZOOM,
  SPLIT_ZOOM,
  type PinPlace,
} from '$lib/frameleaf/landmark-pins';
import { resortMembers, withoutResortMembers } from '$lib/frameleaf/landmarks';

/** FL-355: the map's landmark pins, as the prototype lays them out. */

const place = (id: string, kind: string, latitude: number, longitude: number, extra: Partial<PinPlace> = {}) => ({
  id,
  name: id,
  kind,
  latitude,
  longitude,
  radiusM: 400,
  icon: { background: '#ffffff', tile: true },
  ...extra,
});
const resort = place('resort', 'resort', 33.8092, -117.9195, { radiusM: 1500 });
const park = place('park', 'theme_park', 33.8121, -117.919);
const studios = place('studios', 'theme_park', 34.1381, -118.3534);
const pier = place('pier', 'landmark', 34.0086, -118.4986, { icon: undefined });

// One pixel per thousandth of a degree keeps the fixtures readable: the studios sit far from the resort.
const project = ({ latitude, longitude }: PinPlace) => ({
  x: (longitude + 119) * 1000,
  y: (34.5 - latitude) * 1000,
});
const layout = (zoom: number, places: PinPlace[], bubbles: { x: number; y: number; count: number }[] = []) =>
  layoutLandmarkPins({
    places,
    zoom,
    size: { width: 1200, height: 800 },
    project,
    bubbles,
    textWidth: (text) => text.length * 7,
  }).map(({ place: { id }, ...pin }) => ({ id, ...pin }));

describe('landmark pins', () => {
  it('files the places inside a visited resort under it', () => {
    expect(resortMembers([resort, park, studios])).toEqual(new Map([['park', 'resort']]));
    expect(withoutResortMembers([park, resort, studios]).map(({ id }) => id)).toEqual(['resort', 'studios']);
    expect(withoutResortMembers([park, studios])).toEqual([park, studios]);
  });

  it('shows the icon alone, then the name, then brand art as the map zooms in', () => {
    expect(layout(NAME_ZOOM - 1, [studios])).toEqual([{ id: 'studios', branded: false, compact: true, side: false }]);
    expect(layout(NAME_ZOOM, [studios])).toEqual([{ id: 'studios', branded: false, compact: false, side: false }]);
    expect(layout(BRAND_ZOOM, [studios, pier])).toEqual([
      { id: 'studios', branded: true, compact: false, side: false },
      { id: 'pier', branded: false, compact: false, side: false },
    ]);
  });

  it('lets a resort stand for its parks until the map is close enough to tell them apart', () => {
    expect(layout(SPLIT_ZOOM - 1, [park, resort]).map(({ id }) => id)).toEqual(['resort']);
    expect(layout(SPLIT_ZOOM, [park, resort]).map(({ id }) => id)).toEqual(['park']);
  });

  it('moves a name aside, then drops it, then gives way, rather than cover a busier pin or a bubble', () => {
    const at = (id: string, dx: number) => place(id, 'landmark', 34, -118.5 + dx / 1000, { name: 'Somewhere' });
    const second = (dx: number) => layout(9, [at('a', 0), at('b', dx)])[1];
    // just right of the first: the name does not fit centred, but does running right from the pin
    expect(second(80)).toEqual({ id: 'b', branded: false, compact: false, side: true });
    // just left of it there is room for the icon only
    expect(second(-90)).toEqual({ id: 'b', branded: false, compact: true, side: false });
    // and on top of it, for nothing
    expect(second(2)).toBeUndefined();

    // the bubble a pin sits above is not in its way; a bubble under where the name would go is
    const above = project(at('a', 0));
    expect(layout(9, [at('a', 0)], [{ ...above, count: 5 }])[0]).toMatchObject({ compact: false, side: false });
    expect(layout(9, [at('a', 0)], [{ x: above.x + 40, y: above.y - 45, count: 5 }])[0]).toMatchObject({
      compact: true,
    });
  });

  it("keeps the landmarks that have one of the map's items within reach", () => {
    const markers = [{ lat: 33.8125, lon: -117.9185 }];
    expect(landmarksWithItems([resort, park, studios], markers).map(({ id }) => id)).toEqual(['resort', 'park']);
    expect(landmarksWithItems([resort], [])).toEqual([]);
  });

  it('leaves out a place outside the view', () => {
    expect(layout(9, [place('far', 'landmark', 10, 10)])).toEqual([]);
  });
});
