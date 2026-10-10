#!/usr/bin/env node
// Builds landmarks.ndjson.gz, the place pack matched against asset GPS (FL-351).
//   node build.mjs [output-dir]
// Identity, names and rank come from Wikidata (CC0); boundaries come from OpenStreetMap (ODbL), joined
// on the `wikidata` tag. Both are read from the public QLever endpoints, so no planet download is needed.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const here = dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(readFileSync(join(here, 'classes.json'), 'utf8'));
const outDir = process.argv[2] ?? here;

const WIKIDATA = 'https://qlever.dev/api/wikidata';
const OSM = 'https://qlever.dev/api/osm-planet';
const MAX_VERTICES = 256;
const MAX_RINGS = 8;
// ponytail: places wider than this are dropped, because every match probe searches this far. Raise it
// (and LANDMARK_MAX_RADIUS_M on the server) if the very largest parks are wanted.
const MAX_RADIUS_M = 200_000;
// A boundary smaller than this is matched as a circle, so a photo beside a tower still counts.
const MIN_AREA_RADIUS_M = 150;
const GPS_BUFFER_M = 75;
const MAX_RUIN_RADIUS_M = 10_000;

const sparql = async (endpoint, query) => {
  for (let attempt = 1; ; attempt++) {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/sparql-query', accept: 'text/tab-separated-values' },
      body: query,
    });
    if (response.ok) {
      const [, ...rows] = (await response.text()).split('\n');
      return rows.filter(Boolean).map((row) => row.split('\t'));
    }
    if (attempt === 4) {
      throw new Error(`${endpoint} answered ${response.status}: ${(await response.text()).slice(0, 300)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, attempt * 5000));
  }
};

const qidOf = (iri) => iri.slice(iri.lastIndexOf('/') + 1).replace('>', '');
// TSV literals arrive quoted ("x"@en, "x"^^<type>) or, for some datatypes, bare. Inner quotes are not escaped.
const unquote = (literal) => (literal.startsWith('"') ? literal.slice(1, literal.lastIndexOf('"')) : literal);
const chunks = (items, size) =>
  Array.from({ length: Math.ceil(items.length / size) }, (_, index) => items.slice(index * size, (index + 1) * size));

const toRadians = (degrees) => (degrees * Math.PI) / 180;
const metres = ([lon1, lat1], [lon2, lat2]) => {
  const a =
    Math.sin(toRadians(lat2 - lat1) / 2) ** 2 +
    Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(toRadians(lon2 - lon1) / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.sqrt(a));
};

const bbox = (points) => {
  let [minX, minY, maxX, maxY] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [x, y] of points) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  return { minX, minY, maxX, maxY, area: (maxX - minX) * (maxY - minY) };
};

// Douglas-Peucker, iterative.
const simplify = (points, tolerance) => {
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length > 0) {
    const [first, last] = stack.pop();
    const [ax, ay] = points[first];
    const [bx, by] = points[last];
    const length = Math.hypot(bx - ax, by - ay);
    let worst = 0;
    let index = -1;
    for (let i = first + 1; i < last; i++) {
      // A closed ring starts and ends on the same point, so its first split measures from that point.
      const distance =
        length === 0
          ? Math.hypot(points[i][0] - ax, points[i][1] - ay)
          : Math.abs((bx - ax) * (ay - points[i][1]) - (ax - points[i][0]) * (by - ay)) / length;
      if (distance > worst) {
        worst = distance;
        index = i;
      }
    }
    if (worst > tolerance) {
      keep[index] = 1;
      stack.push([first, index], [index, last]);
    }
  }
  return points.filter((_, i) => keep[i]);
};

// Outer ring of every polygon in a WKT POLYGON / MULTIPOLYGON; holes are ignored.
const outerRings = (wkt) => {
  if (!/^(MULTI)?POLYGON/.test(wkt)) {
    return [];
  }
  return wkt
    .slice(wkt.indexOf('(') + 1, -1)
    .split(/\)\s*\)\s*,\s*\(\s*\(/)
    .map((polygon) =>
      polygon
        .replaceAll(/^\(+|\)+$/g, '')
        .split(/\)\s*,\s*\(/)[0]
        .split(',')
        .map((pair) => pair.trim().split(/\s+/).map(Number)),
    )
    .filter((ring) => ring.length >= 4);
};

const allPoints = (wkt) => [...wkt.matchAll(/(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)/g)].map((m) => [+m[1], +m[2]]);
const round = (value) => Math.round(value * 1e5) / 1e5;

// 1. Places per class, most specific class first.
const places = new Map();
// A living town reaches these classes too ("ancient city" is a kind of archaeological site, "seaside
// resort" a kind of resort), and would match every photo taken there. So a place counts through a class
// that is not itself a kind of settlement (Pompeii is also an archaeological site), or, failing that, only
// when it has no population (Troy stays, Athens goes). A class marked `settlements` (monastery) is a
// settlement in Wikidata's own tree and is taken as it is.
const settlementOnly = [];
for (const { qid, kind, radius, min, minWithArea = min, settlements = false } of config.classes) {
  const prefixes = `PREFIX wd: <http://www.wikidata.org/entity/> PREFIX wdt: <http://www.wikidata.org/prop/direct/>
     PREFIX wikibase: <http://wikiba.se/ontology#>`;
  const item = `?item wdt:P31 ?c . ?item wikibase:sitelinks ?sl . ?item wdt:P625 ?coord`;
  const town = `?c wdt:P279* wd:${config.settlement}`;
  // FILTER on the sitelink count returns nothing on this endpoint, so it is applied here.
  const rows = await sparql(
    WIKIDATA,
    `${prefixes} SELECT ?item ?sl ?coord WHERE { ?c wdt:P279* wd:${qid} . ${item} . ${settlements ? '' : `MINUS { ${town} }`} }`,
  );
  const candidate = ([iri, sitelinks, coord], least) => {
    const id = qidOf(iri);
    const point = /POINT\((-?[\d.]+) (-?[\d.]+)\)/.exec(coord);
    const rank = Number(sitelinks);
    return point && rank >= least && !places.has(id) && !config.deny.includes(id)
      ? { id, kind, rank, min, radius, lon: +point[1], lat: +point[2] }
      : null;
  };
  let added = 0;
  for (const row of rows) {
    const place = candidate(row, minWithArea);
    if (place) {
      places.set(place.id, place);
      added++;
    }
  }
  if (!settlements) {
    const towns = await sparql(
      WIKIDATA,
      `${prefixes} SELECT ?item ?sl ?coord WHERE { ?c wdt:P279* wd:${qid} . ${town} . ${item} }`,
    );
    settlementOnly.push(...towns.map((row) => candidate(row, min)).filter(Boolean));
  }
  console.error(`${qid} ${kind}: ${rows.length} rows, ${added} candidates`);
}
const unpopulated = settlementOnly.filter((place) => !places.has(place.id));
const populated = new Set();
for (const batch of chunks([...new Set(unpopulated.map(({ id }) => id))], 600)) {
  const rows = await sparql(
    WIKIDATA,
    `PREFIX wd: <http://www.wikidata.org/entity/> PREFIX wdt: <http://www.wikidata.org/prop/direct/>
     SELECT DISTINCT ?item WHERE { VALUES ?item { ${batch.map((id) => `wd:${id}`).join(' ')} } ?item wdt:P1082 ?population }`,
  );
  for (const [iri] of rows) {
    populated.add(qidOf(iri));
  }
}
let ruins = 0;
for (const place of unpopulated) {
  if (!populated.has(place.id) && !places.has(place.id)) {
    places.set(place.id, { ...place, ruin: true });
    ruins++;
  }
}
console.error(`settlements: ${populated.size} living towns left out, ${ruins} without a population considered`);

// 2. Boundaries from OpenStreetMap, the widest tagged object per place.
const ids = [...places.keys()];
for (const [index, batch] of chunks(ids, 300).entries()) {
  const rows = await sparql(
    OSM,
    `PREFIX osmkey: <https://www.openstreetmap.org/wiki/Key:> PREFIX geo: <http://www.opengis.net/ont/geosparql#>
     SELECT ?qid ?wkt WHERE { VALUES ?qid { ${batch.map((id) => `"${id}"`).join(' ')} }
       ?osm osmkey:wikidata ?qid ; geo:hasGeometry/geo:asWKT ?wkt }`,
  );
  for (const [qid, literal] of rows) {
    const place = places.get(unquote(qid));
    const wkt = unquote(literal);
    const points = allPoints(wkt);
    if (points.length < 2) {
      continue;
    }
    const box = bbox(points);
    const centre = [(box.minX + box.maxX) / 2, (box.minY + box.maxY) / 2];
    // A tag on the wrong object (a brand, an operator) sits far from the place itself.
    const extent = points.reduce((far, point) => Math.max(far, metres(centre, point)), 0);
    if (box.maxX - box.minX > 180 || metres(centre, [place.lon, place.lat]) > Math.max(5000, extent)) {
      continue;
    }
    if (!place.shape || box.area > place.shape.box.area) {
      place.shape = { box, centre, extent, rings: outerRings(wkt) };
    }
  }
  if (index % 20 === 0) {
    console.error(`boundaries: ${Math.min((index + 1) * 300, ids.length)}/${ids.length}`);
  }
}

// 3. Apply the notability bar, then reduce each boundary.
const kept = [];
for (const place of places.values()) {
  const { shape } = place;
  // An ancient city kept for having no population must also be a mapped site of modest size: that leaves
  // out names for the old centre of a living city (Londinium) and whole islands that were once city-states.
  if (place.ruin && (!shape || shape.extent > MAX_RUIN_RADIUS_M)) {
    continue;
  }
  const isArea = shape && shape.rings.length > 0 && shape.extent >= MIN_AREA_RADIUS_M;
  if (place.rank < (isArea ? 0 : place.min)) {
    continue;
  }
  const record = { id: place.id, kind: place.kind, rank: place.rank, lat: round(place.lat), lon: round(place.lon) };
  record.radiusM = Math.max(place.radius, Math.ceil((shape?.extent ?? 0) + GPS_BUFFER_M));
  if (isArea) {
    [record.lon, record.lat] = shape.centre.map(round);
    const largest = Math.max(...shape.rings.map((ring) => bbox(ring).area));
    record.areas = shape.rings
      .map((ring) => ({ ring, area: bbox(ring).area }))
      .filter(({ area }) => area >= largest * 0.005)
      .sort((a, b) => b.area - a.area)
      .slice(0, MAX_RINGS)
      .map(({ ring }) => {
        let tolerance = shape.extent / 111_000 / 400;
        let reduced = simplify(ring, tolerance);
        while (reduced.length > MAX_VERTICES) {
          tolerance *= 1.5;
          reduced = simplify(ring, tolerance);
        }
        return reduced.map(([lon, lat]) => [round(lon), round(lat)]);
      })
      .filter((ring) => ring.length >= 4);
  }
  if (record.radiusM > MAX_RADIUS_M) {
    console.error(`dropped ${place.id}: radius ${record.radiusM} m`);
    continue;
  }
  kept.push(record);
}

// 4. Names.
const names = new Map();
const languages = config.locales.map((locale) => `'${locale}'`).join(',');
for (const batch of chunks(
  kept.map(({ id }) => id),
  400,
)) {
  const rows = await sparql(
    WIKIDATA,
    `PREFIX wd: <http://www.wikidata.org/entity/> PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
     SELECT ?item ?label WHERE { VALUES ?item { ${batch.map((id) => `wd:${id}`).join(' ')} }
       ?item rdfs:label ?label . FILTER(LANG(?label) IN (${languages})) }`,
  );
  for (const [item, literal] of rows) {
    const id = qidOf(item);
    names.set(id, { ...names.get(id), [literal.slice(literal.lastIndexOf('@') + 1)]: unquote(literal) });
  }
}

const lines = kept
  .map(({ id, kind, rank, lat, lon, radiusM, areas }) => {
    const { en, ...others } = names.get(id) ?? {};
    const name = en ?? Object.values(others)[0];
    const localised = Object.fromEntries(Object.entries(others).filter(([, value]) => value !== name));
    return name && { id, name, names: localised, kind, lat, lon, radiusM, rank, ...(areas?.length ? { areas } : {}) };
  })
  .filter(Boolean)
  .sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)));

const missing = config.mustHave.filter((id) => !lines.some((line) => line.id === id));
if (missing.length > 0) {
  throw new Error(`well-known places are missing from the pack: ${missing.join(', ')}`);
}
const towns = config.mustNotHave.filter((id) => lines.some((line) => line.id === id));
if (towns.length > 0) {
  throw new Error(`towns are in the pack: ${towns.join(', ')}`);
}

mkdirSync(outDir, { recursive: true });
const gz = gzipSync(lines.map((line) => JSON.stringify(line)).join('\n') + '\n', { level: 9 });
writeFileSync(join(outDir, 'landmarks.ndjson.gz'), gz);
const withAreas = lines.filter((line) => line.areas).length;
console.error(
  `${lines.length} places (${withAreas} with boundaries), ${(gz.length / 1e6).toFixed(1)} MB, sha256 ${createHash('sha256').update(gz).digest('hex')}`,
);
