import { resortMembers, type Resortable } from '$lib/frameleaf/landmarks';
import { clusterRadius } from '$lib/frameleaf/map-clusters';

/**
 * Landmark pins on the map (FL-355), as the prototype draws them (`landmarkPins` in `MapView.jsx`). A pin
 * is the icon for its kind when the map is zoomed out, gains its name closer in, and from `BRAND_ZOOM`
 * shows the place's own brand art when it has any. A pin that would cover a more photographed pin or a
 * photo bubble moves its name to the side, then drops the name, then gives way altogether.
 */

/** Below this a pin is its icon alone. */
export const NAME_ZOOM = 8.5;
/** From this a place with brand art shows it. */
export const BRAND_ZOOM = 10;
/** A resort gives way to the places inside it (`resortMembers`) once the map is close enough to tell them apart. */
export const SPLIT_ZOOM = 13;

export const PIN_ICON_PX = 24;
export const PIN_BRAND_PX = 38;

/** A landmark as the API lists it; `icon` is present when it has brand art. */
export type PinPlace = Resortable & { name: string; icon?: object };

/**
 * The landmarks with one of the map's own items within their reach, so pins follow the map's filters: a
 * map of last month shows no pin for a place last visited years ago.
 */
export const landmarksWithItems = <T extends Resortable>(places: T[], markers: { lat: number; lon: number }[]): T[] =>
  // ponytail: one pass over the markers per landmark, and a square for the landmark's reach. Index the
  // markers by cell if a map of millions of items makes this slow.
  places.filter((place) => {
    const latitudeReach = place.radiusM / 111_320;
    const longitudeReach = latitudeReach / Math.max(0.01, Math.cos((place.latitude * Math.PI) / 180));
    return markers.some(
      ({ lat, lon }) =>
        Math.abs(lat - place.latitude) <= latitudeReach && Math.abs(lon - place.longitude) <= longitudeReach,
    );
  });
export type LandmarkPin<T extends PinPlace = PinPlace> = {
  place: T;
  branded: boolean;
  compact: boolean;
  side: boolean;
};

const nameWidths = new Map<string, number>();
let ruler: HTMLSpanElement | undefined;

/** The width of a pin's name in the page's own font and the pins' weight, measured once per name. */
export const pinNameWidth = (text: string, fontSize: number) => {
  const key = `${fontSize}:${text}`;
  let width = nameWidths.get(key);
  if (width === undefined) {
    if (!ruler) {
      ruler = document.createElement('span');
      ruler.style.cssText = 'position:absolute;left:-9999px;top:0;visibility:hidden;white-space:nowrap;font-weight:650';
      document.body.append(ruler);
    }
    ruler.style.fontSize = `${fontSize}px`;
    ruler.textContent = text;
    width = ruler.getBoundingClientRect().width;
    nameWidths.set(key, width);
  }
  return width;
};

type Box = { left: number; right: number; top: number; bottom: number };

/**
 * Which pins to draw, and how. `places` are the visited landmarks, most photographed first, so a busier
 * place keeps its name where two would collide. `project` gives a place's position in the map's pixels;
 * `bubbles` are the photo bubbles on screen, which a name must not cover either (apart from the bubble a
 * pin sits above).
 */
export const layoutLandmarkPins = <T extends PinPlace>({
  places,
  zoom,
  size,
  project,
  bubbles,
  textWidth,
}: {
  places: T[];
  zoom: number;
  size: { width: number; height: number };
  project: (place: T) => { x: number; y: number };
  bubbles: { x: number; y: number; count: number }[];
  textWidth: (text: string, fontSize: number) => number;
}): LandmarkPin<T>[] => {
  const members = resortMembers(places);
  const split = new Set(members.values());
  const obstacles = bubbles.map(({ x, y, count }) => {
    const radius = clusterRadius(count);
    return { x, y, left: x - radius, right: x + radius, top: y - radius, bottom: y + radius };
  });
  const taken: Box[] = [];
  const pins: LandmarkPin<T>[] = [];
  for (const place of places) {
    if (zoom < SPLIT_ZOOM ? members.has(place.id) : split.has(place.id)) {
      continue;
    }
    const { x, y } = project(place);
    if (x <= 40 || y <= 60 || x >= size.width - 40 || y >= size.height - 20) {
      continue;
    }
    const branded = !!place.icon && zoom >= BRAND_ZOOM;
    const icon = branded ? PIN_BRAND_PX : PIN_ICON_PX;
    const named = zoom >= NAME_ZOOM;
    // The pill is its icon, its name and the padding and gap either side of them (the `.lm-pin` styles).
    const width = named ? icon + (branded ? 25 : 22) + textWidth(place.name, branded ? 13 : 12) : icon + 8;
    // A box centred on the pin, or one that starts at the pin and runs to the right.
    const box = (w: number, toSide = false): Box => ({
      left: toSide ? x - icon / 2 - 4 : x - w / 2,
      right: toSide ? x - icon / 2 - 4 + w : x + w / 2,
      top: y - 36 - icon,
      bottom: y - 26,
    });
    const others = obstacles.filter((bubble) => Math.hypot(bubble.x - x, bubble.y - y) > 34);
    const clear = (b: Box) =>
      [...taken, ...others].every((t) => b.right < t.left || b.left > t.right || b.bottom < t.top || b.top > t.bottom);
    const side = named && !clear(box(width)) && clear(box(width, true));
    const compact = !named || (!side && !clear(box(width)));
    const placed = compact ? box(icon + 8) : box(width, side);
    // No room even for the icon: the photo bubble beside it stands in for the place.
    if (compact && !clear(placed)) {
      continue;
    }
    taken.push(placed);
    pins.push({ place, branded, compact, side });
  }
  return pins;
};
