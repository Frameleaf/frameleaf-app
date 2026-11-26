import { createReadStream } from 'node:fs';
import { open } from 'node:fs/promises';
import { createInflateRaw } from 'node:zlib';
import { SaxesParser } from 'saxes';
import { TakeoutZipError, readTakeoutZipDirectory, takeoutZipDataOffset } from 'src/utils/takeout-zip.js';

/**
 * FL-925: readers for the location history files people already have: Google Timeline (the phone's `Timeline.json`,
 * Takeout's `Records.json` and its older monthly files), GPX, OwnTracks Recorder (`.rec` lines and its JSON) and
 * GeoJSON as Dawarich writes it. A ZIP of any of these is read file by file.
 *
 * Every reader takes the file as a stream and gives its places back one at a time, so a file of any size is read in
 * the memory of one entry. The format is told from the file's content, never from its name.
 */

export type HistoryPoint = { recordedAt: Date; latitude: number; longitude: number; accuracyM: number | null };

/** What a file turned out to be. A plain string in the API: new formats add values. */
export type HistoryKind = 'google-timeline' | 'google-records' | 'gpx' | 'owntracks' | 'geojson';

/** Filled in while a file is read: what it is, and how many places were left out as too vague. */
export type HistoryReport = { kind: HistoryKind | null; skipped: number };

/** The file is not a location history this server can read. The message is shown to the person. */
export class HistoryFormatError extends Error {}

/** A place less sure than this is no use for placing a photo. */
export const HISTORY_MAX_ACCURACY_M = 500;
/** One entry of a JSON history is a few kilobytes; one this large is not a history. */
const MAX_ELEMENT_CHARS = 16 * 1024 * 1024;
/** A ZIP entry that unpacks to more than this is not read. */
const MAX_ZIP_ENTRY_BYTES = 8 * 1024 * 1024 * 1024;
const MAX_LAT_LNG_CHARS = 128;
const HISTORY_FILE = /\.(json|gpx|rec|geojson)$/i;
const EARLIEST = Date.UTC(1990, 0, 1);

type Raw = { kind: HistoryKind; time: unknown; latitude: unknown; longitude: unknown; accuracy?: unknown };

const toDate = (value: unknown): Date | null => {
  if (typeof value === 'number') {
    // seconds, or milliseconds when too large to be seconds
    return new Date(value < 1e11 ? value * 1000 : value);
  }
  if (typeof value === 'string' && value) {
    return /^\d+$/.test(value) ? toDate(Number(value)) : new Date(value);
  }
  return null;
};

/** `geo:51.05,-114.07` (iPhone export) or `51.05°, -114.07°` (Android export). */
const latLng = (value: unknown): [number, number] | null => {
  // Bounded first: on a long run of digits this pattern backtracks in quadratic time.
  const match =
    typeof value === 'string' &&
    value.length <= MAX_LAT_LNG_CHARS &&
    /(-?\d+(?:\.\d+)?)[^\d-]+(-?\d+(?:\.\d+)?)/.exec(value);
  return match ? [Number(match[1]), Number(match[2])] : null;
};

/** The objects of a list in a file; anything else there is not a place. */
const objects = (value: unknown): Json[] =>
  Array.isArray(value) ? value.filter((item): item is Json => typeof item === 'object' && item !== null) : [];

/** Old Takeout files wrote some coordinates as unsigned 32-bit numbers. */
const e7 = (value: unknown) => {
  const number = Number(value);
  return (number > 1_800_000_000 ? number - 4_294_967_296 : number) / 1e7;
};

/** A coordinate as a number; some exports write them as strings. */
const coordinate = (value: unknown) =>
  typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;

const check = (raw: Raw, report: HistoryReport): HistoryPoint | null => {
  const recordedAt = toDate(raw.time);
  const latitude = coordinate(raw.latitude);
  const longitude = coordinate(raw.longitude);
  const accuracy = raw.accuracy === undefined || raw.accuracy === null ? null : Number(raw.accuracy);
  const time = recordedAt?.getTime() ?? NaN;
  const valid =
    time >= EARLIEST &&
    time <= Date.now() + 86_400_000 &&
    Math.abs(latitude) <= 90 &&
    Math.abs(longitude) <= 180 &&
    // 0,0 is what a device writes when it has no fix
    !(latitude === 0 && longitude === 0) &&
    (accuracy === null || accuracy <= HISTORY_MAX_ACCURACY_M);
  report.kind ??= raw.kind;
  if (!valid) {
    report.skipped++;
    return null;
  }
  return {
    recordedAt: recordedAt!,
    latitude,
    longitude,
    accuracyM: accuracy !== null && accuracy >= 0 ? accuracy : null,
  };
};

type Json = Record<string, any>;

const at = (kind: HistoryKind, time: unknown, place: [number, number] | null, accuracy?: unknown): Raw[] =>
  place ? [{ kind, time, latitude: place[0], longitude: place[1], accuracy }] : [];

const e7Place = (kind: HistoryKind, time: unknown, place: Json | undefined, accuracy?: unknown): Raw[] =>
  place && place.latitudeE7 !== undefined && place.longitudeE7 !== undefined
    ? at(kind, time, [e7(place.latitudeE7), e7(place.longitudeE7)], accuracy)
    : [];

/** The places in one entry of a JSON history. `key` is the top-level list it came from; null for a bare list. */
export const pointsOfJson = (key: string | null, entry: Json): Raw[] => {
  if (key === 'locations') {
    // Takeout Records.json
    return e7Place('google-records', entry.timestamp ?? entry.timestampMs, entry, entry.accuracy);
  }
  if (key === 'rawSignals') {
    const position = entry.position;
    return position ? at('google-timeline', position.timestamp, latLng(position.LatLng), position.accuracyMeters) : [];
  }
  if (key === 'timelineObjects') {
    // Takeout's monthly "Semantic Location History" files
    const kind = 'google-timeline';
    const visit = entry.placeVisit;
    const move = entry.activitySegment;
    const path = objects(move?.simplifiedRawPath?.points);
    return [
      ...e7Place(kind, visit?.duration?.startTimestamp, visit?.location),
      ...e7Place(kind, visit?.duration?.endTimestamp, visit?.location),
      ...e7Place(kind, move?.duration?.startTimestamp, move?.startLocation),
      ...path.flatMap((point) =>
        at(kind, point.timestamp ?? point.timestampMs, [e7(point.latE7), e7(point.lngE7)], point.accuracyMeters),
      ),
      ...e7Place(kind, move?.duration?.endTimestamp, move?.endLocation),
    ];
  }
  if (entry.startTime !== undefined && (key === 'semanticSegments' || key === null)) {
    // the phone's Timeline.json: Android nests each place in `latLng`, iPhone writes `geo:` strings
    const kind = 'google-timeline';
    const start = toDate(entry.startTime);
    const visit = entry.visit?.topCandidate?.placeLocation;
    const path = objects(entry.timelinePath);
    return [
      ...at(kind, entry.startTime, latLng(visit?.latLng ?? visit)),
      ...at(kind, entry.startTime, latLng(entry.activity?.start?.latLng ?? entry.activity?.start)),
      ...path.flatMap((point) =>
        at(
          kind,
          point.time ??
            (start && point.durationMinutesOffsetFromStartTime !== undefined
              ? start.getTime() + Number(point.durationMinutesOffsetFromStartTime) * 60_000
              : null),
          latLng(point.point),
        ),
      ),
      ...at(kind, entry.endTime, latLng(entry.activity?.end?.latLng ?? entry.activity?.end)),
      ...at(kind, entry.endTime, latLng(visit?.latLng ?? visit)),
    ];
  }
  if (entry.type === 'Feature') {
    // GeoJSON points, as Dawarich exports them
    const { geometry } = entry;
    // GeoJSON allows `"properties": null`.
    const properties: Json = entry.properties ?? {};
    return geometry?.type === 'Point' && Array.isArray(geometry.coordinates)
      ? [
          {
            kind: 'geojson',
            time: properties.timestamp ?? properties.time ?? properties.tst,
            latitude: geometry.coordinates[1],
            longitude: geometry.coordinates[0],
            accuracy: properties.accuracy ?? properties.acc,
          },
        ]
      : [];
  }
  if (entry._type === 'location') {
    // OwnTracks Recorder's JSON
    return [{ kind: 'owntracks', time: entry.tst, latitude: entry.lat, longitude: entry.lon, accuracy: entry.acc }];
  }
  return [];
};

const QUOTE = 34;
const BACKSLASH = 92;
const OPEN_BRACE = 123;
const CLOSE_BRACE = 125;
const OPEN_BRACKET = 91;
const CLOSE_BRACKET = 93;

/**
 * The entries of a JSON file's lists, one at a time: each object in a top-level list, or in a list that is a value
 * of the top-level object (with that value's key). Only the entry being read is held in memory.
 */
export async function* jsonEntries(text: AsyncIterable<string>): AsyncGenerator<{ key: string | null; entry: Json }> {
  let depth = 0;
  let inString = false;
  let escaped = false;
  let rootIsList = false;
  // in a top-level object: whether the value being read is a list, and the last string seen beside it (its key)
  let valueIsList = false;
  let key = '';
  let keyParts: string[] | null = null;
  let parts: string[] | null = null;
  let size = 0;

  for await (const chunk of text) {
    let from = 0;
    for (let index = 0; index < chunk.length; index++) {
      const code = chunk.codePointAt(index);
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (code === BACKSLASH) {
          escaped = true;
        } else if (code === QUOTE) {
          inString = false;
          if (keyParts) {
            key = keyParts.join('') + chunk.slice(from, index);
            keyParts = null;
          }
        }
        continue;
      }
      if (code === QUOTE) {
        inString = true;
        if (depth === 1 && !rootIsList) {
          keyParts = [];
          from = index + 1;
        }
        continue;
      }
      if (code === OPEN_BRACE || code === OPEN_BRACKET) {
        if (depth === 0) {
          rootIsList = code === OPEN_BRACKET;
        } else if (depth === 1 && !rootIsList) {
          valueIsList = code === OPEN_BRACKET;
        }
        const entryDepth = rootIsList ? 1 : 2;
        if (code === OPEN_BRACE && depth === entryDepth && (rootIsList || valueIsList)) {
          parts = [];
          size = 0;
          from = index;
        }
        depth++;
      } else if (code === CLOSE_BRACE || code === CLOSE_BRACKET) {
        depth--;
        if (parts && depth === (rootIsList ? 1 : 2)) {
          parts.push(chunk.slice(from, index + 1));
          const json = parts.join('');
          parts = null;
          yield { key: rootIsList ? null : key, entry: JSON.parse(json) as Json };
        }
      }
    }
    // carry what is still open into the next chunk
    const open = parts ?? keyParts;
    if (open) {
      open.push(chunk.slice(from));
      size += chunk.length - from;
      if (size > MAX_ELEMENT_CHARS) {
        throw new HistoryFormatError('This file is not a location history');
      }
    }
  }
}

async function* jsonPoints(text: AsyncIterable<string>, report: HistoryReport): AsyncGenerator<HistoryPoint> {
  try {
    for await (const { key, entry } of jsonEntries(text)) {
      for (const raw of pointsOfJson(key, entry)) {
        const point = check(raw, report);
        if (point) {
          yield point;
        }
      }
    }
  } catch (error) {
    throw error instanceof SyntaxError ? new HistoryFormatError('This file is damaged and could not be read') : error;
  }
}

const GPX_POINTS = new Set(['trkpt', 'wpt', 'rtept']);

/** GPX 1.0 and 1.1: track, route and way points that carry a time. */
async function* gpxPoints(text: AsyncIterable<string>, report: HistoryReport): AsyncGenerator<HistoryPoint> {
  const parser = new SaxesParser();
  let found: HistoryPoint[] = [];
  let current: { latitude: number; longitude: number; time: string } | null = null;
  let inTime = false;
  let failure: Error | null = null;
  // saxes holds text, comments and tags whole until they end, so how far it has read past the last one is capped.
  let emittedAt = 0;
  let tooLong = false;
  const emitted = () => {
    emittedAt = parser.position;
  };
  parser.on('error', (error) => (failure ??= error));
  parser.on('comment', emitted);
  parser.on('cdata', emitted);
  parser.on('processinginstruction', emitted);
  parser.on('doctype', emitted);
  parser.on('opentag', ({ name, attributes }) => {
    emitted();
    if (GPX_POINTS.has(name)) {
      current = { latitude: Number(attributes.lat), longitude: Number(attributes.lon), time: '' };
    } else if (name === 'time' && current) {
      inTime = true;
    }
  });
  parser.on('text', (value) => {
    emitted();
    if (inTime && current) {
      current.time += value;
      tooLong ||= current.time.length > MAX_ELEMENT_CHARS;
    }
  });
  parser.on('closetag', ({ name }) => {
    emitted();
    if (name === 'time') {
      inTime = false;
    } else if (GPX_POINTS.has(name) && current) {
      const point = check({ kind: 'gpx', ...current, time: current.time.trim() }, report);
      current = null;
      if (point) {
        found.push(point);
      }
    }
  });
  for await (const chunk of text) {
    parser.write(chunk);
    if (failure) {
      throw new HistoryFormatError('This file is damaged and could not be read');
    }
    if (tooLong || parser.position - emittedAt > MAX_ELEMENT_CHARS) {
      throw new HistoryFormatError('This file is not a location history');
    }
    const points = found;
    found = [];
    yield* points;
  }
  parser.close();
  yield* found;
}

/** OwnTracks Recorder `.rec` files: a time, a tab, `*`, a tab and one JSON message a line. */
async function* recPoints(text: AsyncIterable<string>, report: HistoryReport): AsyncGenerator<HistoryPoint> {
  let rest = '';
  const read = function* (line: string) {
    const json = line.slice(line.lastIndexOf('\t') + 1);
    if (!json.startsWith('{')) {
      return;
    }
    let entry: Json;
    try {
      entry = JSON.parse(json) as Json;
    } catch {
      // a line cut short when the recorder stopped
      report.skipped++;
      return;
    }
    for (const raw of entry._type === 'location' ? pointsOfJson(null, entry) : []) {
      const point = check(raw, report);
      if (point) {
        yield point;
      }
    }
  };
  for await (const chunk of text) {
    const lines = (rest + chunk).split('\n');
    rest = lines.pop()!;
    if (rest.length > MAX_ELEMENT_CHARS) {
      throw new HistoryFormatError('This file is not a location history');
    }
    for (const line of lines) {
      yield* read(line);
    }
  }
  yield* read(rest);
}

async function* decode(bytes: AsyncIterable<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder('utf-8');
  for await (const chunk of bytes) {
    const text = decoder.decode(chunk, { stream: true });
    if (text) {
      yield text;
    }
  }
}

/** Read one history file given as a stream of bytes. `report.kind` is set once the first place is read. */
export async function* parseHistoryStream(
  bytes: AsyncIterable<Uint8Array>,
  report: HistoryReport,
): AsyncGenerator<HistoryPoint> {
  const text = decode(bytes)[Symbol.asyncIterator]();
  try {
    let head = '';
    // the first character that is not white space says what the file is; the white space before it is not kept
    while (head === '') {
      const next = await text.next();
      if (next.done) {
        throw new HistoryFormatError('This file is empty');
      }
      head = next.value.trimStart();
    }
    const rest = (async function* () {
      yield head;
      for (let next = await text.next(); !next.done; next = await text.next()) {
        yield next.value;
      }
    })();
    const first = head[0];
    if (first === '<') {
      yield* gpxPoints(rest, report);
    } else if (first === '{' || first === '[') {
      yield* jsonPoints(rest, report);
    } else if (/\d/.test(first)) {
      yield* recPoints(rest, report);
    } else {
      throw new HistoryFormatError('This file is not a location history');
    }
  } finally {
    // Closes the file or inflate stream underneath, however reading ended.
    await text.return?.(undefined);
  }
}

/** Refuses a ZIP entry that unpacks to more than its directory declared. */
async function* withinDeclared(bytes: AsyncIterable<Uint8Array>, declared: number): AsyncGenerator<Uint8Array> {
  let size = 0;
  for await (const chunk of bytes) {
    size += chunk.length;
    if (size > declared) {
      throw new HistoryFormatError('This ZIP file is damaged and could not be read');
    }
    yield chunk;
  }
}

/** The entry itself is damaged: a bad header or bad compressed data, not trouble on the server. */
const isDamagedEntry = (error: unknown) =>
  error instanceof HistoryFormatError ||
  error instanceof TakeoutZipError ||
  !!(error as NodeJS.ErrnoException)?.code?.startsWith('Z_');

/**
 * Read a staged history file, or every history file inside a staged ZIP (a Takeout export). Throws
 * `HistoryFormatError` when the file is not one this server reads.
 */
export async function* parseHistoryFile(filePath: string, report: HistoryReport): AsyncGenerator<HistoryPoint> {
  const handle = await open(filePath, 'r');
  try {
    const { size } = await handle.stat();
    const read = async (position: number, length: number) => {
      const buffer = Buffer.alloc(Math.min(length, Math.max(0, size - position)));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      return buffer.subarray(0, bytesRead);
    };
    const magic = await read(0, 4);
    if (magic.length < 4 || magic.readUInt32LE(0) !== 0x04_03_4b_50) {
      yield* parseHistoryStream(createReadStream(filePath), report);
      return;
    }
    const source = { size, read };
    let entries;
    try {
      entries = await readTakeoutZipDirectory(source);
    } catch {
      throw new HistoryFormatError('This ZIP file is damaged and could not be read');
    }
    for (const entry of entries) {
      if (entry.refused || !HISTORY_FILE.test(entry.name) || entry.uncompressedSize > MAX_ZIP_ENTRY_BYTES) {
        continue;
      }
      if (entry.compressedSize === 0) {
        continue;
      }
      const inner: HistoryReport = { kind: null, skipped: 0 };
      let stored: ReturnType<typeof createReadStream> | undefined;
      let inflate: ReturnType<typeof createInflateRaw> | undefined;
      try {
        const start = await takeoutZipDataOffset(source, entry);
        stored = createReadStream(filePath, { start, end: start + entry.compressedSize - 1 });
        if (entry.compression === 'deflate') {
          const output = createInflateRaw();
          inflate = output;
          // `pipe` does not pass a read failure on, which would leave the reader waiting for ever.
          stored.on('error', (error) => output.destroy(error));
          stored.pipe(output);
        }
        yield* parseHistoryStream(withinDeclared(inflate ?? stored, entry.uncompressedSize), inner);
      } catch (error) {
        // a ZIP holds other things too (settings, notes); a file that is not a history is passed over
        if (!isDamagedEntry(error)) {
          throw error;
        }
      } finally {
        inflate?.destroy();
        stored?.destroy();
      }
      report.kind ??= inner.kind;
      report.skipped += inner.skipped;
    }
  } finally {
    await handle.close();
  }
}
