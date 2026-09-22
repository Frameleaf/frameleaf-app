// Pure helpers for the discovery screens: Map, Places, Tags, Folders, Memories.
// Everything here derives from the caller's assets; nothing touches the network.
import { captureDate, chronologicalAssets, videoAsset } from "./explore-timeline.mjs";

// ---------------------------------------------------------------------------
// Geometry: a Web Mercator projection in unit space plus pixel helpers.
// ---------------------------------------------------------------------------
const MAX_LAT = 85.05112878;
const TILE = 256;
const clampLat = (lat) => Math.max(-MAX_LAT, Math.min(MAX_LAT, lat));
const wrapLng = (lng) => ((((lng + 180) % 360) + 360) % 360) - 180;
export const located = (asset) =>
  !!asset &&
  Number.isFinite(asset.latitude) &&
  Number.isFinite(asset.longitude) &&
  Math.abs(asset.latitude) <= 90 &&
  Math.abs(asset.longitude) <= 180;

/** Unit-square Mercator coordinates (0..1) for a latitude/longitude pair. */
export function mercator(lat, lng) {
  const phi = (clampLat(lat) * Math.PI) / 180;
  return {
    x: (wrapLng(lng) + 180) / 360,
    y: (1 - Math.log(Math.tan(phi) + 1 / Math.cos(phi)) / Math.PI) / 2,
  };
}
export function inverseMercator(x, y) {
  const n = Math.PI - 2 * Math.PI * y;
  return {
    lat: (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n))),
    lng: x * 360 - 180,
  };
}
const validBounds = (bounds) =>
  !!bounds &&
  ["north", "south", "east", "west"].every((key) =>
    Number.isFinite(bounds[key]),
  ) &&
  bounds.north > bounds.south &&
  bounds.east > bounds.west;
const validSize = (size) =>
  !!size && size.width > 0 && size.height > 0 && Number.isFinite(size.width);

/** Project a coordinate into pixel space for a viewport described by bounds and size. */
export function project(lat, lng, bounds, size) {
  if (!validBounds(bounds) || !validSize(size)) return null;
  const nw = mercator(bounds.north, bounds.west);
  const se = mercator(bounds.south, bounds.east);
  const point = mercator(lat, lng);
  return {
    x: ((point.x - nw.x) / (se.x - nw.x)) * size.width,
    y: ((point.y - nw.y) / (se.y - nw.y)) * size.height,
  };
}
/** Inverse of project(): a pixel position back to a coordinate. */
export function unproject(x, y, bounds, size) {
  if (!validBounds(bounds) || !validSize(size)) return null;
  const nw = mercator(bounds.north, bounds.west);
  const se = mercator(bounds.south, bounds.east);
  return inverseMercator(
    nw.x + (x / size.width) * (se.x - nw.x),
    nw.y + (y / size.height) * (se.y - nw.y),
  );
}
/** Bounds of a viewport centred on a coordinate at a slippy-map style zoom level. */
export function viewportBounds(center, zoom, size) {
  const world = TILE * 2 ** zoom;
  const c = mercator(center.lat, center.lng);
  const halfW = size.width / world / 2;
  const halfH = size.height / world / 2;
  const nw = inverseMercator(c.x - halfW, Math.max(0, c.y - halfH));
  const se = inverseMercator(c.x + halfW, Math.min(1, c.y + halfH));
  return { north: nw.lat, west: nw.lng, south: se.lat, east: se.lng };
}
/** The largest half-step zoom that fits the bounds inside the size with padding. */
export function zoomToFit(bounds, size, padding = 48, { min = 2, max = 16 } = {}) {
  if (!validBounds(bounds) || !validSize(size)) return min;
  const nw = mercator(bounds.north, bounds.west);
  const se = mercator(bounds.south, bounds.east);
  const dx = Math.max(se.x - nw.x, 1e-9);
  const dy = Math.max(se.y - nw.y, 1e-9);
  const width = Math.max(size.width - padding * 2, 16);
  const height = Math.max(size.height - padding * 2, 16);
  const zoom = Math.log2(Math.min(width / (dx * TILE), height / (dy * TILE)));
  return Math.max(min, Math.min(max, Math.floor(zoom * 2) / 2));
}
export const boundsCenter = (bounds) => {
  const nw = mercator(bounds.north, bounds.west);
  const se = mercator(bounds.south, bounds.east);
  return inverseMercator((nw.x + se.x) / 2, (nw.y + se.y) / 2);
};
export const defaultBounds = {
  north: 53.15,
  south: 50.9,
  west: -118.6,
  east: -115.1,
};
/** Geographic extent of located assets, padded a little; the Rockies when nothing is located. */
export function boundsFor(assets, padding = 0.08) {
  const points = (assets || []).filter(located);
  if (!points.length) return { ...defaultBounds };
  let north = -90,
    south = 90,
    east = -180,
    west = 180;
  for (const asset of points) {
    north = Math.max(north, asset.latitude);
    south = Math.min(south, asset.latitude);
    east = Math.max(east, asset.longitude);
    west = Math.min(west, asset.longitude);
  }
  const padLat = Math.max((north - south) * padding, 0.01);
  const padLng = Math.max((east - west) * padding, 0.01);
  return {
    north: Math.min(MAX_LAT, north + padLat),
    south: Math.max(-MAX_LAT, south - padLat),
    east: Math.min(180, east + padLng),
    west: Math.max(-180, west - padLng),
  };
}
export const inBounds = (asset, bounds) =>
  located(asset) &&
  asset.latitude <= bounds.north &&
  asset.latitude >= bounds.south &&
  asset.longitude <= bounds.east &&
  asset.longitude >= bounds.west;

/**
 * Grid clustering in pixel space: assets whose projected positions share a cell
 * (or whose merged centres fall within `radius`) become one cluster.
 */
export function clusterAssets(
  assets,
  { bounds, size, radius = 44, margin = 60 } = {},
) {
  if (!validBounds(bounds) || !validSize(size)) return [];
  const cells = new Map();
  for (const asset of assets || []) {
    if (!located(asset)) continue;
    const point = project(asset.latitude, asset.longitude, bounds, size);
    if (
      point.x < -margin ||
      point.y < -margin ||
      point.x > size.width + margin ||
      point.y > size.height + margin
    )
      continue;
    const key = `${Math.floor(point.x / radius)}:${Math.floor(point.y / radius)}`;
    if (!cells.has(key))
      cells.set(key, { x: 0, y: 0, lat: 0, lng: 0, members: [] });
    const cell = cells.get(key);
    cell.members.push({ asset, point });
  }
  const clusters = [...cells.values()].map((cell) => {
    const n = cell.members.length;
    return {
      x: cell.members.reduce((sum, m) => sum + m.point.x, 0) / n,
      y: cell.members.reduce((sum, m) => sum + m.point.y, 0) / n,
      members: cell.members,
    };
  });
  // Merge neighbouring cells whose centres are closer than the radius so grid
  // lines never split one visual group into two overlapping markers.
  let merged = true;
  while (merged) {
    merged = false;
    outer: for (let i = 0; i < clusters.length; i++)
      for (let j = i + 1; j < clusters.length; j++) {
        const a = clusters[i],
          b = clusters[j];
        if (Math.hypot(a.x - b.x, a.y - b.y) < radius) {
          const members = [...a.members, ...b.members];
          const n = members.length;
          clusters[i] = {
            x: members.reduce((sum, m) => sum + m.point.x, 0) / n,
            y: members.reduce((sum, m) => sum + m.point.y, 0) / n,
            members,
          };
          clusters.splice(j, 1);
          merged = true;
          break outer;
        }
      }
  }
  return clusters
    .map((cluster) => {
      const assetsIn = chronologicalAssets(cluster.members.map((m) => m.asset));
      const n = assetsIn.length;
      const lat = assetsIn.reduce((sum, a) => sum + a.latitude, 0) / n;
      const lng = assetsIn.reduce((sum, a) => sum + a.longitude, 0) / n;
      const cover =
        assetsIn.find((asset) => !videoAsset(asset) && asset.image) ||
        assetsIn[0];
      return {
        id:
          n === 1
            ? `asset:${assetsIn[0].id}`
            : `cluster:${assetsIn.map((a) => a.id).join(",")}`,
        x: cluster.x,
        y: cluster.y,
        lat,
        lng,
        count: n,
        assetIds: assetsIn.map((a) => a.id),
        cover,
        place: placeLabel(assetsIn),
      };
    })
    .sort((a, b) => a.y - b.y || a.x - b.x);
}
function placeLabel(assets) {
  const counts = new Map();
  for (const asset of assets)
    if (typeof asset.city === "string" && asset.city.trim())
      counts.set(asset.city, (counts.get(asset.city) || 0) + 1);
  const cities = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  if (!cities.length) return null;
  return cities.length === 1
    ? cities[0][0]
    : `${cities[0][0]} and ${cities.length - 1} more`;
}
/** Offline base-map reference points for the sample region (Canadian Rockies). */
export const mapPlaces = [
  { id: "banff", name: "Banff", lat: 51.1784, lng: -115.5708, rank: 1 },
  { id: "lake-louise", name: "Lake Louise", lat: 51.4254, lng: -116.1773, rank: 1 },
  { id: "jasper", name: "Jasper", lat: 52.8737, lng: -118.0814, rank: 1 },
  { id: "canmore", name: "Canmore", lat: 51.089, lng: -115.359, rank: 2 },
  { id: "field", name: "Field", lat: 51.3969, lng: -116.4893, rank: 3 },
  { id: "golden", name: "Golden", lat: 51.2963, lng: -116.9631, rank: 3 },
  { id: "icefield", name: "Columbia Icefield", lat: 52.22, lng: -117.224, rank: 3 },
];
export const mapLakes = [
  { name: "Lake Louise", lat: 51.4166, lng: -116.2262, rx: 0.022, ry: 0.009 },
  { name: "Moraine Lake", lat: 51.3217, lng: -116.186, rx: 0.014, ry: 0.007 },
  { name: "Bow Lake", lat: 51.67, lng: -116.46, rx: 0.02, ry: 0.014 },
  { name: "Peyto Lake", lat: 51.72, lng: -116.52, rx: 0.011, ry: 0.02 },
  { name: "Maligne Lake", lat: 52.68, lng: -117.64, rx: 0.02, ry: 0.07 },
  { name: "Lake Minnewanka", lat: 51.26, lng: -115.4, rx: 0.09, ry: 0.016 },
  { name: "Emerald Lake", lat: 51.44, lng: -116.53, rx: 0.012, ry: 0.012 },
  { name: "Pyramid Lake", lat: 52.92, lng: -118.09, rx: 0.008, ry: 0.008 },
];
export const mapRoads = [
  // Icefields Parkway, Jasper to Lake Louise.
  [
    [52.8737, -118.0814],
    [52.7, -117.9],
    [52.45, -117.5],
    [52.22, -117.224],
    [52.0, -116.9],
    [51.8, -116.6],
    [51.67, -116.46],
    [51.5, -116.25],
    [51.4254, -116.1773],
  ],
  // Trans-Canada, Golden to Canmore.
  [
    [51.2963, -116.9631],
    [51.3969, -116.4893],
    [51.4254, -116.1773],
    [51.32, -115.95],
    [51.22, -115.7],
    [51.1784, -115.5708],
    [51.089, -115.359],
  ],
];
/** Deterministic terrain blobs along the NW–SE axis of the range. */
export function terrainFeatures(seed = 7) {
  let state = seed >>> 0;
  const random = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const features = [];
  for (let i = 0; i < 18; i++) {
    const t = i / 17;
    const lat = 53.25 - t * 2.45 + (random() - 0.5) * 0.45;
    const lng = -118.75 + t * 3.55 + (random() - 0.5) * 0.7;
    features.push({
      kind: i % 5 === 2 ? "valley" : "ridge",
      lat,
      lng,
      rx: 0.28 + random() * 0.22,
      ry: 0.09 + random() * 0.07,
      rotate: -32 + (random() - 0.5) * 18,
      contours: 2 + Math.floor(random() * 2),
      wobble: Array.from({ length: 12 }, () => 0.8 + random() * 0.4),
    });
  }
  for (let i = 0; i < 9; i++)
    features.push({
      kind: "snow",
      lat: 53.1 - i * 0.27 + (random() - 0.5) * 0.2,
      lng: -118.4 + i * 0.37 + (random() - 0.5) * 0.3,
      rx: 0.05 + random() * 0.05,
      ry: 0.025 + random() * 0.02,
      rotate: -30,
      contours: 0,
      wobble: [],
    });
  return features;
}
/** Graticule spacing in degrees for a zoom level. */
export const graticuleStep = (zoom) =>
  zoom >= 12 ? 0.05 : zoom >= 10.5 ? 0.1 : zoom >= 9 ? 0.25 : zoom >= 7.5 ? 0.5 : zoom >= 6 ? 1 : 2;
export function graticuleLines(bounds, zoom) {
  const step = graticuleStep(zoom);
  const lines = { lat: [], lng: [] };
  for (
    let lat = Math.ceil(bounds.south / step) * step;
    lat <= bounds.north && lines.lat.length < 80;
    lat = Number((lat + step).toFixed(6))
  )
    lines.lat.push(Number(lat.toFixed(6)));
  for (
    let lng = Math.ceil(bounds.west / step) * step;
    lng <= bounds.east && lines.lng.length < 80;
    lng = Number((lng + step).toFixed(6))
  )
    lines.lng.push(Number(lng.toFixed(6)));
  return { step, ...lines };
}
export const formatDegrees = (value, axis) => {
  const abs = Math.abs(value);
  const digits = Number.isInteger(abs * 10) ? 1 : 2;
  return `${abs.toFixed(digits)}° ${value >= 0 ? (axis === "lat" ? "N" : "E") : axis === "lat" ? "S" : "W"}`;
};

// ---------------------------------------------------------------------------
// Map settings and date presets.
// ---------------------------------------------------------------------------
export const mapDatePresets = [
  { id: "all", label: "All time" },
  { id: "30d", label: "Last 30 days" },
  { id: "year", label: "This year" },
  { id: "custom", label: "Custom" },
];
export const defaultMapSettings = {
  datePreset: "all",
  from: "",
  to: "",
  includeArchived: false,
  includeShared: true,
  includePartner: true,
  onlyFavorites: false,
  assetPanel: false,
};
const isoDay = (date) => date.toISOString().slice(0, 10);
const addDays = (day, delta) => {
  const date = new Date(`${day}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + delta);
  return isoDay(date);
};
/** Apply the map settings sheet to a list of assets. */
export function filterMapAssets(assets, settings = {}, today = isoDay(new Date()), viewerId = "taylor") {
  const config = { ...defaultMapSettings, ...settings };
  let from = null,
    to = null;
  if (config.datePreset === "30d") from = addDays(today, -30);
  else if (config.datePreset === "year") from = `${today.slice(0, 4)}-01-01`;
  else if (config.datePreset === "custom") {
    from = /^\d{4}-\d{2}-\d{2}$/.test(config.from) ? config.from : null;
    to = /^\d{4}-\d{2}-\d{2}$/.test(config.to) ? config.to : null;
  }
  return (assets || []).filter((asset) => {
    if (!located(asset)) return false;
    if (asset.status === "Trashed" || asset.status === "Deleted") return false;
    if (!config.includeArchived && asset.visibility === "archive") return false;
    if (config.onlyFavorites && !(asset.isFavorite ?? asset.favorite)) return false;
    const partner = asset.ownerId && asset.ownerId !== viewerId;
    const sharedOnly =
      !partner &&
      Array.isArray(asset.spaceIds) &&
      asset.spaceIds.length > 0 &&
      asset.sharedSpaceOnly === true;
    if (partner && !config.includePartner) return false;
    if (sharedOnly && !config.includeShared) return false;
    const day = captureDate(asset)?.day;
    if ((from || to) && !day) return false;
    if (from && day < from) return false;
    if (to && day > to) return false;
    return true;
  });
}

// ---------------------------------------------------------------------------
// Places: country → state → city.
// ---------------------------------------------------------------------------
const text = (value) => (typeof value === "string" && value.trim() ? value.trim() : null);
const coverOf = (assets) =>
  assets.find((asset) => !videoAsset(asset) && asset.image) || assets[0] || null;
const slug = (value) =>
  String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
export function placesTree(assets) {
  const ordered = chronologicalAssets(assets || []);
  const countries = new Map();
  let unplaced = 0;
  for (const asset of ordered) {
    const city = text(asset.city);
    const country = text(asset.country) || (city ? "Unknown country" : null);
    if (!city && !country) {
      unplaced++;
      continue;
    }
    const state = text(asset.state) || "Other";
    if (!countries.has(country))
      countries.set(country, { name: country, states: new Map() });
    const states = countries.get(country).states;
    if (!states.has(state)) states.set(state, { name: state, cities: new Map() });
    const cities = states.get(state).cities;
    const cityName = city || "Unknown place";
    if (!cities.has(cityName)) cities.set(cityName, { name: cityName, assets: [] });
    cities.get(cityName).assets.push(asset);
  }
  const byCount = (a, b) => b.count - a.count || a.name.localeCompare(b.name);
  const tree = [...countries.values()].map((country) => {
    const states = [...country.states.values()].map((state) => {
      const cities = [...state.cities.values()]
        .map((city) => {
          const points = city.assets.filter(located);
          return {
            id: `city:${slug(country.name)}:${slug(state.name)}:${slug(city.name)}`,
            kind: "city",
            name: city.name,
            count: city.assets.length,
            cover: coverOf(city.assets),
            assetIds: city.assets.map((a) => a.id),
            latitude: points.length
              ? points.reduce((sum, a) => sum + a.latitude, 0) / points.length
              : null,
            longitude: points.length
              ? points.reduce((sum, a) => sum + a.longitude, 0) / points.length
              : null,
            query: { filter: { city: { eq: city.name } } },
          };
        })
        .sort(byCount);
      const stateAssets = [...state.cities.values()].flatMap((c) => c.assets);
      return {
        id: `state:${slug(country.name)}:${slug(state.name)}`,
        kind: "state",
        name: state.name,
        count: stateAssets.length,
        cover: coverOf(stateAssets),
        assetIds: stateAssets.map((a) => a.id),
        children: cities,
        query: { filter: { state: { eq: state.name } } },
      };
    });
    const countryAssets = states.flatMap((s) => s.assetIds);
    return {
      id: `country:${slug(country.name)}`,
      kind: "country",
      name: country.name,
      count: countryAssets.length,
      cover: states.sort(byCount)[0]?.cover || null,
      assetIds: countryAssets,
      children: states,
      query: { filter: { country: { eq: country.name } } },
    };
  });
  return {
    countries: tree.sort(byCount),
    cities: tree
      .flatMap((c) => c.children.flatMap((s) => s.children))
      .sort(byCount),
    unplaced,
    total: ordered.length - unplaced,
  };
}

// ---------------------------------------------------------------------------
// Tags: hierarchical names with "/", sample hierarchy, persisted overrides.
// ---------------------------------------------------------------------------
export const tagsKey = "frameleaf:tags:v1";
export const tagColors = [
  { id: "grey", label: "Grey" },
  { id: "green", label: "Green" },
  { id: "teal", label: "Teal" },
  { id: "blue", label: "Blue" },
  { id: "purple", label: "Purple" },
  { id: "pink", label: "Pink" },
  { id: "amber", label: "Amber" },
  { id: "red", label: "Red" },
];
const colorIds = new Set(tagColors.map((c) => c.id));
/** Sample hierarchical tags derived from the flat sample tags (any-of membership). */
export const sampleTagHierarchy = [
  { path: "trips", derivedFrom: [], color: "blue" },
  {
    path: "trips/rockies-2026",
    derivedFrom: ["mountains", "lake", "hiking", "summit", "trail"],
    color: "blue",
  },
  { path: "trips/rockies-2026/lakes", derivedFrom: ["lake"], color: "teal" },
  { path: "family", derivedFrom: ["family"], color: "pink" },
  { path: "family/kids", derivedFrom: ["portrait"], requireAll: ["family"], color: "pink" },
  { path: "family/pets", derivedFrom: ["pet", "dog"], color: "amber" },
];
const tagName = (value, limit = 60) =>
  typeof value === "string" &&
  value.trim().length > 0 &&
  value.trim().length <= limit &&
  !/[\u0000-\u001f/]/.test(value.trim())
    ? value.trim()
    : null;
const tagId = (value) =>
  typeof value === "string" && value.length > 0 && value.length <= 160 && !/[\u0000-\u001f]/.test(value)
    ? value
    : null;
export const emptyTagOverrides = () => ({
  version: 1,
  colors: {},
  names: {},
  parents: {},
  created: [],
  deleted: [],
});
export function parseTagOverrides(raw) {
  const base = emptyTagOverrides();
  if (typeof raw === "string" && raw.length > 200_000) return base;
  let data;
  try {
    data = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    return base;
  }
  if (!data || typeof data !== "object" || Array.isArray(data) || data.version !== 1)
    return base;
  const record = (value) =>
    value && typeof value === "object" && !Array.isArray(value) ? value : {};
  for (const [id, color] of Object.entries(record(data.colors)).slice(0, 500))
    if (tagId(id) && colorIds.has(color)) base.colors[id] = color;
  for (const [id, name] of Object.entries(record(data.names)).slice(0, 500))
    if (tagId(id) && tagName(name)) base.names[id] = tagName(name);
  for (const [id, parent] of Object.entries(record(data.parents)).slice(0, 500))
    if (tagId(id) && (parent === null || (tagId(parent) && parent !== id)))
      base.parents[id] = parent;
  if (Array.isArray(data.created))
    base.created = data.created.slice(0, 500).flatMap((entry) =>
      entry &&
      typeof entry === "object" &&
      tagId(entry.id) &&
      tagName(entry.name) &&
      (entry.parent === null || entry.parent === undefined || tagId(entry.parent))
        ? [{ id: entry.id, name: tagName(entry.name), parent: entry.parent ?? null }]
        : [],
    );
  if (Array.isArray(data.deleted))
    base.deleted = [...new Set(data.deleted.slice(0, 500).filter(tagId))];
  return base;
}
export function readTagOverrides(storage = globalThis.localStorage) {
  try {
    return parseTagOverrides(storage?.getItem(tagsKey));
  } catch {
    return emptyTagOverrides();
  }
}
export function writeTagOverrides(overrides, storage = globalThis.localStorage) {
  try {
    storage?.setItem(tagsKey, JSON.stringify(parseTagOverrides(overrides)));
  } catch {
    // Storage may be unavailable (private mode); the in-memory state still applies.
  }
  return overrides;
}
const idsOf = (asset) => {
  const list = asset.tagIds || asset.tags || [];
  return Array.isArray(list) ? list.filter((id) => typeof id === "string") : [];
};
/**
 * Build the tag tree. Base tags come from `tags` ([{id,label}]) plus the sample
 * hierarchy; overrides rename, recolour, re-parent, create and delete tags.
 */
export function tagTree(tags, assets, overrides) {
  const config = parseTagOverrides(overrides || emptyTagOverrides());
  const list = (assets || []).filter((asset) => asset && typeof asset.id === "string");
  const nodes = new Map();
  const add = (id, name, parent, color, assetIds, derived = false) => {
    if (!nodes.has(id))
      nodes.set(id, { id, name, parent, color, assetIds, derived, children: [] });
  };
  for (const tag of tags || []) {
    if (!tag || typeof tag.id !== "string") continue;
    const parts = tag.id.split("/").filter(Boolean);
    const name = parts.at(-1) || tag.id;
    const parent = parts.length > 1 ? parts.slice(0, -1).join("/") : null;
    add(
      tag.id,
      typeof tag.label === "string" && tag.label ? tag.label : name,
      parent,
      "grey",
      list.filter((asset) => idsOf(asset).includes(tag.id)).map((a) => a.id),
    );
  }
  for (const sample of sampleTagHierarchy) {
    const parts = sample.path.split("/");
    const parent = parts.length > 1 ? parts.slice(0, -1).join("/") : null;
    const members = list
      .filter((asset) => {
        const ids = idsOf(asset);
        return (
          sample.derivedFrom.some((tag) => ids.includes(tag)) &&
          (sample.requireAll || []).every((tag) => ids.includes(tag))
        );
      })
      .map((a) => a.id);
    if (nodes.has(sample.path)) {
      const node = nodes.get(sample.path);
      node.assetIds = [...new Set([...node.assetIds, ...members])];
      node.color = sample.color;
    } else add(sample.path, parts.at(-1), parent, sample.color, members, true);
  }
  for (const created of config.created)
    add(created.id, created.name, created.parent, "grey", [], false);
  for (const node of nodes.values()) {
    if (config.names[node.id]) node.name = config.names[node.id];
    if (config.colors[node.id]) node.color = config.colors[node.id];
    if (node.id in config.parents) node.parent = config.parents[node.id];
    if (node.parent && !nodes.has(node.parent)) node.parent = null;
  }
  // Drop deleted tags and their descendants; guard against parent cycles.
  const deleted = new Set(config.deleted);
  const snapshot = new Map(nodes);
  const isDeleted = (node, seen = new Set()) => {
    if (deleted.has(node.id)) return true;
    if (!node.parent || seen.has(node.id)) return false;
    seen.add(node.id);
    const parent = snapshot.get(node.parent);
    return parent ? isDeleted(parent, seen) : false;
  };
  for (const node of snapshot.values()) if (isDeleted(node)) nodes.delete(node.id);
  for (const node of nodes.values()) {
    if (node.parent && !nodes.has(node.parent)) node.parent = null;
    node.count = node.assetIds.length;
  }
  const sortNodes = (items) =>
    items.sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
  const roots = [];
  for (const node of nodes.values())
    (node.parent ? nodes.get(node.parent).children : roots).push(node);
  const finish = (node, ancestors) => {
    node.path = [...ancestors.map((a) => a.name), node.name];
    node.depth = ancestors.length;
    node.breadcrumbs = [...ancestors.map((a) => ({ id: a.id, name: a.name })), { id: node.id, name: node.name }];
    const all = new Set(node.assetIds);
    for (const child of node.children) {
      finish(child, [...ancestors, node]);
      for (const id of child.allAssetIds) all.add(id);
    }
    node.allAssetIds = [...all];
    node.total = all.size;
    node.cover = coverOf(
      node.allAssetIds.map((id) => list.find((a) => a.id === id)).filter(Boolean),
    );
    node.query = {
      filter: {
        tagIds: {
          any: node.derived
            ? [
                ...new Set(
                  sampleTagHierarchy
                    .filter((s) => s.path === node.id || s.path.startsWith(`${node.id}/`))
                    .flatMap((s) => s.derivedFrom),
                ),
              ]
            : [node.id, ...descendants(node).map((c) => c.id)],
        },
      },
    };
    sortNodes(node.children);
  };
  const descendants = (node) => node.children.flatMap((c) => [c, ...descendants(c)]);
  // Guard: a re-parent that creates a cycle detaches the node to the root.
  const visited = new Set();
  for (const root of roots) finish(root, []);
  for (const node of nodes.values())
    if (!node.path) {
      node.parent = null;
      roots.push(node);
      finish(node, []);
    }
  visited.clear();
  return {
    roots: sortNodes(roots),
    byId: Object.fromEntries([...nodes.values()].map((n) => [n.id, n])),
    total: nodes.size,
  };
}
export function findTag(tree, id) {
  return tree?.byId?.[id] || null;
}
/** Apply one tag change and return the next overrides object. */
export function applyTagChange(overrides, change, tree) {
  const next = structuredClone(parseTagOverrides(overrides || emptyTagOverrides()));
  const type = change?.type;
  if (type === "create") {
    const name = tagName(change.name);
    if (!name) throw Error("Give the tag a name without slashes.");
    const parent = change.parent && tree?.byId?.[change.parent] ? change.parent : null;
    const siblings = parent ? tree.byId[parent].children : tree?.roots || [];
    if (siblings.some((node) => node.name.toLowerCase() === name.toLowerCase()))
      throw Error(`A tag named ${name} already exists here.`);
    const id = `tag:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`;
    next.created.push({ id, name, parent });
    if (colorIds.has(change.color)) next.colors[id] = change.color;
    return { overrides: next, id };
  }
  if (type === "rename") {
    const name = tagName(change.name);
    if (!name) throw Error("Give the tag a name without slashes.");
    if (!tagId(change.id)) throw Error("Choose a tag to rename.");
    next.names[change.id] = name;
    return { overrides: next, id: change.id };
  }
  if (type === "color") {
    if (!tagId(change.id) || !colorIds.has(change.color))
      throw Error("Choose one of the available colours.");
    next.colors[change.id] = change.color;
    return { overrides: next, id: change.id };
  }
  if (type === "move") {
    if (!tagId(change.id)) throw Error("Choose a tag to move.");
    const parent = change.parent && tree?.byId?.[change.parent] ? change.parent : null;
    if (parent) {
      let cursor = tree.byId[parent];
      while (cursor) {
        if (cursor.id === change.id) throw Error("A tag cannot be moved inside itself.");
        cursor = cursor.parent ? tree.byId[cursor.parent] : null;
      }
    }
    next.parents[change.id] = parent;
    return { overrides: next, id: change.id };
  }
  if (type === "delete") {
    if (!tagId(change.id)) throw Error("Choose a tag to delete.");
    next.deleted = [...new Set([...next.deleted, change.id])];
    return { overrides: next, id: null };
  }
  throw Error("Choose a supported tag change.");
}

// ---------------------------------------------------------------------------
// Folders from originalPath.
// ---------------------------------------------------------------------------
export function folderBreadcrumbs(path) {
  const parts = (path || "/").split("/").filter(Boolean);
  return [
    { name: "All folders", path: "/" },
    ...parts.map((name, index) => ({
      name,
      path: `/${parts.slice(0, index + 1).join("/")}`,
    })),
  ];
}
export function folderTree(assets) {
  const root = {
    path: "/",
    name: "All folders",
    children: [],
    assetIds: [],
    assets: [],
    count: 0,
    size: 0,
    directCount: 0,
  };
  const byPath = new Map([["/", root]]);
  for (const asset of chronologicalAssets(assets || [])) {
    const original = typeof asset.originalPath === "string" ? asset.originalPath : "";
    const parts = original.split("/").filter(Boolean);
    if (!parts.length) parts.push(asset.originalFileName || asset.name || asset.id);
    const folders = parts.slice(0, -1);
    let cursor = root;
    let path = "";
    for (const name of folders) {
      path += `/${name}`;
      if (!byPath.has(path)) {
        const node = {
          path,
          name,
          children: [],
          assetIds: [],
          assets: [],
          count: 0,
          size: 0,
          directCount: 0,
        };
        byPath.set(path, node);
        cursor.children.push(node);
      }
      cursor = byPath.get(path);
    }
    cursor.assetIds.push(asset.id);
    cursor.assets.push(asset);
    cursor.directCount++;
    const bytes = Number.isFinite(asset.fileSizeInBytes) ? asset.fileSizeInBytes : 0;
    let up = cursor;
    while (up) {
      up.count++;
      up.size += bytes;
      up = up.path === "/" ? null : byPath.get(up.path.slice(0, up.path.lastIndexOf("/")) || "/");
    }
  }
  const finish = (node) => {
    node.breadcrumbs = folderBreadcrumbs(node.path);
    node.cover = coverOf(node.assets.length ? node.assets : node.children.flatMap((c) => c.assets));
    node.children.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    node.children.forEach(finish);
    if (!node.cover) node.cover = node.children.find((c) => c.cover)?.cover || null;
  };
  finish(root);
  return { root, byPath: Object.fromEntries(byPath) };
}
export const folderAt = (tree, path) => tree?.byPath?.[path || "/"] || null;
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes,
    unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value < 10 && unit > 0 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

// ---------------------------------------------------------------------------
// Memories.
// ---------------------------------------------------------------------------
export const memoriesKey = "frameleaf:memories:v1";
const dayFormat = (day, options) =>
  new Intl.DateTimeFormat("en", { timeZone: "UTC", ...options }).format(
    new Date(`${day}T12:00:00Z`),
  );
export const longDay = (day) =>
  dayFormat(day, { month: "long", day: "numeric", year: "numeric" });
const shortDay = (day) => dayFormat(day, { month: "long", day: "numeric" });
const weekday = (day) => new Date(`${day}T12:00:00Z`).getUTCDay();
const dayDiff = (a, b) =>
  Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86_400_000);
export function dateRangeLabel(from, to) {
  if (!from) return "";
  if (!to || from === to) return longDay(from);
  const sameMonth = from.slice(0, 7) === to.slice(0, 7);
  const sameYear = from.slice(0, 4) === to.slice(0, 4);
  if (sameMonth) return `${shortDay(from)}–${to.slice(8).replace(/^0/, "")}, ${from.slice(0, 4)}`;
  if (sameYear) return `${shortDay(from)} – ${shortDay(to)}, ${from.slice(0, 4)}`;
  return `${longDay(from)} – ${longDay(to)}`;
}
export const yearsAgoLabel = (years) =>
  years === 1 ? "One year ago" : `${years} years ago`;
const memoryTitles = {
  event: ({ place, days, from }) => {
    if (days.length === 1) return `A day in ${place}`;
    const weekend = days.some((day) => [0, 6].includes(weekday(day)));
    return weekend ? `Weekend in ${place}` : `A few days in ${place}`;
  },
};
export const emptyMemoryOverrides = () => ({
  version: 1,
  hidden: [],
  favorites: [],
  removed: {},
  settings: { showUpcoming: true, onlyFavorites: false },
});
const memoryId = (value) =>
  typeof value === "string" && value.length > 0 && value.length <= 200 && !/[\u0000-\u001f]/.test(value);
export function parseMemoryOverrides(raw) {
  const base = emptyMemoryOverrides();
  if (typeof raw === "string" && raw.length > 200_000) return base;
  let data;
  try {
    data = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    return base;
  }
  if (!data || typeof data !== "object" || Array.isArray(data) || data.version !== 1)
    return base;
  if (Array.isArray(data.hidden))
    base.hidden = [...new Set(data.hidden.slice(0, 500).filter(memoryId))];
  if (Array.isArray(data.favorites))
    base.favorites = [...new Set(data.favorites.slice(0, 500).filter(memoryId))];
  if (data.removed && typeof data.removed === "object" && !Array.isArray(data.removed))
    for (const [id, ids] of Object.entries(data.removed).slice(0, 500))
      if (memoryId(id) && Array.isArray(ids)) {
        const clean = [...new Set(ids.slice(0, 500).filter((x) => typeof x === "string" && x.length <= 64))];
        if (clean.length) base.removed[id] = clean;
      }
  if (data.settings && typeof data.settings === "object" && !Array.isArray(data.settings))
    for (const key of ["showUpcoming", "onlyFavorites"])
      if (typeof data.settings[key] === "boolean") base.settings[key] = data.settings[key];
  return base;
}
export function readMemoryOverrides(storage = globalThis.localStorage) {
  try {
    return parseMemoryOverrides(storage?.getItem(memoriesKey));
  } catch {
    return emptyMemoryOverrides();
  }
}
export function writeMemoryOverrides(overrides, storage = globalThis.localStorage) {
  try {
    storage?.setItem(memoriesKey, JSON.stringify(parseMemoryOverrides(overrides)));
  } catch {
    // Storage unavailable; keep the in-memory state.
  }
  return overrides;
}
export const memoryOverrides = {
  hide: (overrides, id) => {
    const next = parseMemoryOverrides(overrides || emptyMemoryOverrides());
    if (memoryId(id)) next.hidden = [...new Set([...next.hidden, id])];
    return next;
  },
  unhide: (overrides, id) => {
    const next = parseMemoryOverrides(overrides || emptyMemoryOverrides());
    next.hidden = next.hidden.filter((x) => x !== id);
    return next;
  },
  toggleFavorite: (overrides, id) => {
    const next = parseMemoryOverrides(overrides || emptyMemoryOverrides());
    next.favorites = next.favorites.includes(id)
      ? next.favorites.filter((x) => x !== id)
      : memoryId(id)
        ? [...next.favorites, id]
        : next.favorites;
    return next;
  },
  removeAsset: (overrides, id, assetId) => {
    const next = parseMemoryOverrides(overrides || emptyMemoryOverrides());
    if (memoryId(id) && typeof assetId === "string")
      next.removed[id] = [...new Set([...(next.removed[id] || []), assetId])];
    return next;
  },
  restoreAsset: (overrides, id, assetId) => {
    const next = parseMemoryOverrides(overrides || emptyMemoryOverrides());
    if (next.removed[id]) {
      next.removed[id] = next.removed[id].filter((x) => x !== assetId);
      if (!next.removed[id].length) delete next.removed[id];
    }
    return next;
  },
  settings: (overrides, patch) => {
    const next = parseMemoryOverrides(overrides || emptyMemoryOverrides());
    for (const key of ["showUpcoming", "onlyFavorites"])
      if (typeof patch?.[key] === "boolean") next.settings[key] = patch[key];
    return next;
  },
};
const validDay = (value) => (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null);
function makeMemory(kind, id, title, subtitle, date, assets, extra = {}) {
  return {
    id,
    kind,
    title,
    subtitle,
    date,
    assetIds: assets.map((a) => a.id),
    cover: coverOf(assets),
    count: assets.length,
    ...extra,
  };
}
/**
 * Memories for a day. Returns {today, upcoming, earlier, all, hidden} where each
 * memory is {id, kind, title, subtitle, date, assetIds, cover, count, favorite, upcomingOn?}.
 */
export function memoriesFor(
  assets,
  { today = isoDay(new Date()), showUpcoming = true, onlyFavorites = false, overrides = null, upcomingDays = 14 } = {},
) {
  const day = validDay(today) || isoDay(new Date());
  const config = parseMemoryOverrides(overrides || emptyMemoryOverrides());
  const dated = chronologicalAssets(assets || [])
    .map((asset) => ({ asset, day: captureDate(asset)?.day }))
    .filter((entry) => entry.day && entry.asset.status !== "Trashed" && entry.asset.status !== "Deleted");
  const year = Number(day.slice(0, 4));
  const monthDay = day.slice(5);
  const raw = { today: [], upcoming: [], earlier: [] };

  // On this day: same month and day in an earlier year.
  const byYear = new Map();
  for (const entry of dated)
    if (entry.day.slice(5) === monthDay && Number(entry.day.slice(0, 4)) < year) {
      const y = entry.day.slice(0, 4);
      if (!byYear.has(y)) byYear.set(y, []);
      byYear.get(y).push(entry.asset);
    }
  for (const [y, list] of [...byYear.entries()].sort((a, b) => b[0].localeCompare(a[0]))) {
    const years = year - Number(y);
    raw.today.push(
      makeMemory(
        "on-this-day",
        `on-this-day:${y}-${monthDay}`,
        "On this day",
        `${yearsAgoLabel(years)} · ${longDay(`${y}-${monthDay}`)}${placeSuffix(list)}`,
        `${y}-${monthDay}`,
        list,
        { years },
      ),
    );
  }
  // Years ago: the same week (±3 days) in an earlier year, excluding the exact day.
  const weekByYear = new Map();
  for (const entry of dated) {
    const y = Number(entry.day.slice(0, 4));
    if (y >= year) continue;
    const anchor = `${y}-${monthDay}`;
    if (!validDay(anchor) || Number.isNaN(Date.parse(`${anchor}T12:00:00Z`))) continue;
    const diff = dayDiff(anchor, entry.day);
    if (diff === 0 || Math.abs(diff) > 3) continue;
    if (!weekByYear.has(y)) weekByYear.set(y, []);
    weekByYear.get(y).push(entry);
  }
  for (const [y, entries] of [...weekByYear.entries()].sort((a, b) => b[0] - a[0])) {
    if (entries.length < 2) continue;
    const days = entries.map((e) => e.day).sort();
    const years = year - y;
    raw.today.push(
      makeMemory(
        "years-ago",
        `years-ago:${y}-${monthDay}`,
        yearsAgoLabel(years),
        `${dateRangeLabel(days[0], days.at(-1))}${placeSuffix(entries.map((e) => e.asset))}`,
        days.at(-1),
        entries.map((e) => e.asset),
        { years },
      ),
    );
  }
  // Upcoming: on-this-day memories that will appear in the next N days.
  const upcomingByDate = new Map();
  for (const entry of dated) {
    const y = Number(entry.day.slice(0, 4));
    if (y >= year) continue;
    const thisYear = `${year}-${entry.day.slice(5)}`;
    if (Number.isNaN(Date.parse(`${thisYear}T12:00:00Z`))) continue;
    const diff = dayDiff(day, thisYear);
    if (diff <= 0 || diff > upcomingDays) continue;
    const key = entry.day;
    if (!upcomingByDate.has(key)) upcomingByDate.set(key, { on: thisYear, diff, assets: [] });
    upcomingByDate.get(key).assets.push(entry.asset);
  }
  for (const [sourceDay, group] of [...upcomingByDate.entries()].sort((a, b) => a[1].diff - b[1].diff)) {
    const years = year - Number(sourceDay.slice(0, 4));
    raw.upcoming.push(
      makeMemory(
        "on-this-day",
        `on-this-day:${sourceDay}`,
        "On this day",
        `${yearsAgoLabel(years)} · ${longDay(sourceDay)}${placeSuffix(group.assets)}`,
        sourceDay,
        group.assets,
        { years, upcomingOn: group.on, inDays: group.diff },
      ),
    );
  }
  // Events: 2+ assets within a three-day window at the same city.
  const byCity = new Map();
  for (const entry of dated) {
    const city = text(entry.asset.city);
    if (!city) continue;
    if (!byCity.has(city)) byCity.set(city, []);
    byCity.get(city).push(entry);
  }
  // Windows are anchored on the most recent day of a visit, so a weekend stays
  // whole and any earlier days form their own memory.
  for (const [city, entries] of byCity) {
    const ordered = [...entries].sort((a, b) => b.day.localeCompare(a.day));
    let group = [];
    const flush = () => {
      if (group.length >= 2) {
        const days = [...new Set(group.map((e) => e.day))].sort();
        const list = chronologicalAssets(group.map((e) => e.asset));
        raw.earlier.push(
          makeMemory(
            "event",
            `event:${slug(city)}:${days[0]}`,
            memoryTitles.event({ place: city, days, from: days[0] }),
            dateRangeLabel(days[0], days.at(-1)),
            days.at(-1),
            list,
            { place: city },
          ),
        );
      }
      group = [];
    };
    for (const entry of ordered) {
      if (group.length && dayDiff(entry.day, group[0].day) > 2) flush();
      group.push(entry);
    }
    flush();
  }
  // Best of <month>: top quality scores per month, at least three items.
  const byMonth = new Map();
  for (const entry of dated)
    if (Number.isFinite(entry.asset.bestPhotosScore)) {
      const month = entry.day.slice(0, 7);
      if (!byMonth.has(month)) byMonth.set(month, []);
      byMonth.get(month).push(entry.asset);
    }
  for (const [month, list] of byMonth) {
    const best = [...list]
      .filter((asset) => asset.bestPhotosScore >= 80)
      .sort((a, b) => b.bestPhotosScore - a.bestPhotosScore)
      .slice(0, 8);
    if (best.length < 3) continue;
    const label = dayFormat(`${month}-01`, { month: "long", year: "numeric" });
    raw.earlier.push(
      makeMemory(
        "best-of",
        `best-of:${month}`,
        `Best of ${label}`,
        `${best.length} standout ${best.length === 1 ? "photo" : "photos and videos"}`,
        `${month}-01`,
        best,
      ),
    );
  }
  // Recently passed on-this-day memories stay reachable in Earlier for two weeks.
  for (const entry of dated) {
    const y = Number(entry.day.slice(0, 4));
    if (y >= year) continue;
    const thisYear = `${year}-${entry.day.slice(5)}`;
    if (Number.isNaN(Date.parse(`${thisYear}T12:00:00Z`))) continue;
    const diff = dayDiff(thisYear, day);
    if (diff <= 0 || diff > upcomingDays) continue;
    const id = `on-this-day:${entry.day}`;
    const existing = raw.earlier.find((m) => m.id === id);
    if (existing) {
      existing.assetIds.push(entry.asset.id);
      existing.count++;
      continue;
    }
    raw.earlier.push(
      makeMemory(
        "on-this-day",
        id,
        "On this day",
        `${yearsAgoLabel(year - y)} · ${longDay(entry.day)}`,
        entry.day,
        [entry.asset],
        { years: year - y, passedDays: diff },
      ),
    );
  }
  raw.earlier.sort((a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id));

  const hidden = [];
  const decorate = (memory) => {
    const removed = new Set(config.removed[memory.id] || []);
    const assetIds = memory.assetIds.filter((id) => !removed.has(id));
    const kept = assetIds.map((id) => dated.find((e) => e.asset.id === id)?.asset).filter(Boolean);
    return {
      ...memory,
      assetIds,
      count: assetIds.length,
      cover: coverOf(kept) || memory.cover,
      favorite: config.favorites.includes(memory.id),
      hidden: config.hidden.includes(memory.id),
      removedCount: memory.assetIds.length - assetIds.length,
    };
  };
  const keep = (memory) => {
    if (memory.count === 0) return false;
    if (memory.hidden) {
      hidden.push(memory);
      return false;
    }
    if (onlyFavorites && !memory.favorite) return false;
    return true;
  };
  const result = {
    today: raw.today.map(decorate).filter(keep),
    upcoming: showUpcoming ? raw.upcoming.map(decorate).filter(keep) : [],
    earlier: raw.earlier.map(decorate).filter(keep),
    hidden,
  };
  result.all = [...result.today, ...result.upcoming, ...result.earlier];
  return result;
}
function placeSuffix(assets) {
  const label = placeLabel(assets);
  return label ? ` · ${label}` : "";
}
export function findMemory(assets, id, options = {}) {
  const index = memoriesFor(assets, options);
  return [...index.all, ...index.hidden].find((memory) => memory.id === id) || null;
}
