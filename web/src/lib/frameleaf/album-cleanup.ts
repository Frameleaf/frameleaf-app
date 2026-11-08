import {
  AlbumCleanupOperationType,
  type AlbumCleanupFactsDto,
  type AlbumCleanupHomeAreaDto,
  type AlbumCleanupOperationDto,
  type AlbumLostDateSuggestionDto,
} from '@frameleaf/sdk';

/**
 * Magic Albums cleanup planner (FL-1300), ported from the prototype's `album-cleanup.mjs`. Reads what the scan found
 * and proposes merges and nesting. Pure, so the review re-runs it on every change.
 *
 * Unlike the mock it takes merge winners from the snapshot (they come from true counts, which a session without the
 * PIN never sees), reuses existing collections level by level, and measures home and trips from GPS centres.
 */

export const OFFERED_DELIMITERS = [
  { token: '-', example: 'Trips - Disney' },
  { token: ',', example: 'City, date' },
  { token: ':', example: 'Trips: Disney' },
  { token: '/', example: 'Trips / Disney' },
];
export const DEFAULT_DELIMITERS = ['-', ',', ':'];

/** Shown only when the scan finds at least this many suggested changes, so a clean library is never nagged. */
export const CLEANUP_BANNER_MIN_SUGGESTIONS = 20;
/** Rule 3: a level exists only where at least this many albums share it. */
export const DEFAULT_MIN_GROUP = 2;
/** Rule 8: a run of back-to-back days stops here, so a home city's every day does not become one album. */
export const MAX_DAY_RUN = 7;
/** Rule 11: most days between one trip album and the next. */
export const TRIP_GAP_DAYS = 2;
/** Rule 11: the longest a trip can run. */
export const TRIP_MAX_DAYS = 21;
/** Rule 11: the furthest one trip album can be from the last. */
export const TRIP_HOP_KM = 1000;
/** Rule 12: home is everything this far from the centre of the chosen cluster. */
export const HOME_RADIUS_KM = 100;
/** Rule 13: a name whose date is further than this from its photos is filed by the photos and flagged. */
export const NAME_MISMATCH_DAYS = 30;

const MONTHS =
  'jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?';
const DATE_SOURCE = [
  String.raw`(?:${MONTHS})\.?\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4}`,
  String.raw`\d{1,2}\s+(?:${MONTHS})\.?,?\s+\d{4}`,
  String.raw`\d{4}[-/]\d{1,2}[-/]\d{1,2}`,
  String.raw`\d{1,2}/\d{1,2}/\d{4}`,
  String.raw`(?:${MONTHS})\.?\s+\d{4}`,
].join('|');
const DATE_ANYWHERE = new RegExp(String.raw`\b(?:${DATE_SOURCE})\b`, 'gi');
const DATE_ONLY = new RegExp(`^(?:${DATE_SOURCE})$`, 'i');
const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/** Private-use characters that can't be in a name, so a masked date can't collide with what is around it. */
const MASK_OPEN = String.fromCodePoint(0xe0_00);
const MASK_CLOSE = String.fromCodePoint(0xe0_01);
const MASKED_DATE = new RegExp(`${MASK_OPEN}(\\d+)${MASK_CLOSE}`, 'g');

const cleanName = (name: string) => name.trim().replaceAll(/\s+/g, ' ');
export const albumNameKey = (name: string) => cleanName(name).toLowerCase();
const byName = (a: { name: string }, b: { name: string }) =>
  a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
const escapeRegExp = (text: string) => text.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);

/** A hyphen needs spaces around it (Mary-Anne stays whole); a comma or colon needs a space after it. */
const delimiterSource = (token: string) => {
  if (token === '-') {
    return String.raw`\s+[-–—]\s+`;
  }
  if (token === ',' || token === ':') {
    return String.raw`\s*${token}\s+`;
  }
  return String.raw`\s*${escapeRegExp(token)}\s*`;
};

/** Dates are masked first, so the comma inside "May 24, 2020" never splits. */
export const splitName = (name: string, delimiters = DEFAULT_DELIMITERS): string[] => {
  const dates: string[] = [];
  const masked = cleanName(name).replaceAll(DATE_ANYWHERE, (match) => {
    dates.push(match);
    return `${MASK_OPEN}${dates.length - 1}${MASK_CLOSE}`;
  });
  const active = delimiters.map((token) => token.trim()).filter(Boolean);
  const parts =
    active.length > 0 ? masked.split(new RegExp(active.map((token) => delimiterSource(token)).join('|'))) : [masked];
  return parts
    .map((part) => part.replaceAll(MASKED_DATE, (_, index: string) => dates[Number(index)]).trim())
    .filter(Boolean);
};

export const isDateOnly = (name: string) => DATE_ONLY.test(cleanName(name));

/** A few of the person's own messiest names for the banner's pile: duplicates, dates and long nested names. */
export const messyAlbumNames = ({ albums, sameName }: AlbumCleanupFactsDto, limit = 5): string[] => {
  const nameOf = (id: string) => albums.find((album) => album.id === id)?.name;
  const picks = [
    ...sameName.slice(0, 2).map((group) => nameOf(group.winnerId)),
    albums.find(({ name }) => /, /.test(name) && !isDateOnly(name))?.name,
    albums.find(({ name }) => isDateOnly(name))?.name,
    albums.find(({ name }) => name.split(' - ').length > 2)?.name,
    ...albums.map(({ name }) => name),
  ];
  return [...new Set(picks.filter((name): name is string => !!name))].slice(0, limit);
};

const monthIndex = (word: string) =>
  MONTH_NAMES.findIndex((month) => month.toLowerCase().startsWith(word.slice(0, 3).toLowerCase()));

/** The year and month in a date-only name, for grouping one that names no day. */
export const dateParts = (name: string): { year: number; month: number } => {
  const text = cleanName(name);
  const year = Number(/\b(\d{4})\b/.exec(text)?.[1]);
  const word = new RegExp(String.raw`\b(${MONTHS})\b`, 'i').exec(text)?.[1];
  if (word) {
    return { year, month: monthIndex(word) };
  }
  const numeric = /^\d{4}[-/](\d{1,2})/.exec(text) || /^(\d{1,2})\//.exec(text);
  return { year, month: numeric ? Number(numeric[1]) - 1 : 0 };
};

export type CleanupDay = { year: number; month: number; day: number; serial: number };

const dayFrom = (year: number, month: number, day: number): CleanupDay => ({
  year,
  month,
  day,
  serial: Date.UTC(year, month, day) / 86_400_000,
});
const fromSerial = (serial: number) => {
  const date = new Date(serial * 86_400_000);
  return dayFrom(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
};

/** A date that names one day, or null ("May 2020" names no day). */
export const dayOf = (text: string): CleanupDay | null => {
  const clean = cleanName(text);
  const named = new RegExp(String.raw`^(${MONTHS})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})$`, 'i').exec(clean);
  const dayFirst = new RegExp(String.raw`^(\d{1,2})\s+(${MONTHS})\.?,?\s+(\d{4})$`, 'i').exec(clean);
  const iso = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(clean);
  const slashed = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(clean);
  if (named) {
    return dayFrom(Number(named[3]), monthIndex(named[1]), Number(named[2]));
  }
  if (dayFirst) {
    return dayFrom(Number(dayFirst[3]), monthIndex(dayFirst[2]), Number(dayFirst[1]));
  }
  if (iso) {
    return dayFrom(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
  }
  if (slashed) {
    return dayFrom(Number(slashed[3]), Number(slashed[1]) - 1, Number(slashed[2]));
  }
  return null;
};

const rangeLabel = (first: CleanupDay, last: CleanupDay) => {
  const short = (when: CleanupDay) => MONTH_NAMES[when.month].slice(0, 3);
  if (first.serial === last.serial) {
    return `${short(first)} ${first.day}, ${first.year}`;
  }
  if (first.year !== last.year) {
    return `${short(first)} ${first.day}, ${first.year}–${short(last)} ${last.day}, ${last.year}`;
  }
  if (first.month !== last.month) {
    return `${short(first)} ${first.day}–${short(last)} ${last.day}, ${last.year}`;
  }
  return `${short(first)} ${first.day}–${last.day}, ${last.year}`;
};

export const dayLabel = (serial: number) => {
  const { year, month, day } = fromSerial(serial);
  return `${MONTH_NAMES[month].slice(0, 3)} ${day}, ${year}`;
};

type Point = { lat: number; lon: number };

const distanceKm = (a: Point, b: Point) => {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
};

type Gps = { city: string; share: number; lat: number; lon: number };

/** One album as the planner reads it; `name` and `segments` change as it is filed. */
export type PlanAlbum = {
  id: string;
  name: string;
  /** The album's name today, whatever it is filed as. */
  originalName: string;
  count: number;
  locked: boolean;
  shared: boolean;
  createdAt: string;
  gps: Gps | null;
  realDay: CleanupDay | null;
  coverAssetId: string | null;
  segments?: string[];
  copies?: number;
  days?: number;
  trip?: boolean;
};

export type PlanNode = {
  id: string;
  kind: 'album' | 'collection';
  name: string;
  sourceName?: string;
  /** What this album is called now, so a rename is only asked for when the name changes. */
  currentName?: string;
  autoName?: string;
  albumCount: number;
  photoCount: number;
  locked?: boolean;
  shared?: boolean;
  copies?: number;
  days?: number;
  trip?: boolean;
  children: PlanNode[];
  flattenable?: boolean;
  isDate?: boolean;
  existing?: boolean;
  existingId?: string;
  path?: string;
};

export type DuplicateGroup = {
  key: string;
  name: string;
  winner: PlanAlbum;
  others: PlanAlbum[];
  count: number;
  locked: boolean;
  shared: boolean;
  skipped: boolean;
};

export type PlanPair = {
  key: string;
  winner: PlanAlbum;
  loser: PlanAlbum;
  share: number;
  count: number;
  merged: boolean;
  shared: boolean;
};

export type PlanDayRun = { key: string; name: string; albums: PlanAlbum[]; count: number; skipped: boolean };
export type PlanTrip = PlanDayRun & { cities: string[]; year: number };
export type PlanPlaced = { key: string; album: PlanAlbum; city: string; share: number; kept: boolean };
export type PlanMismatch = { key: string; album: PlanAlbum; photoLabel: string; renamed: boolean };
export type PlanLostDates = {
  key: string;
  album: PlanAlbum;
  from: string;
  to: string;
  suggestions: AlbumLostDateSuggestionDto[];
  healed: boolean;
};

export type PlanOptions = {
  delimiters?: string[];
  mergeDuplicates?: boolean;
  minGroup?: number;
  dateOnly?: 'year' | 'year-month' | 'leave' | 'remove';
  skippedDuplicates?: Set<string>;
  forcedDuplicates?: Set<string>;
  mergedSimilar?: Set<string>;
  combineDays?: boolean;
  keptDays?: Set<string>;
  usePhotoData?: boolean;
  /** Which of the snapshot's home areas is home; the densest by default. */
  homeArea?: number;
  keptPlaces?: Set<string>;
  keptTrips?: Set<string>;
  renamedToPhotoDate?: Set<string>;
  healedAlbums?: Set<string>;
  leftOut?: Set<string>;
  flattened?: Set<string>;
  renamed?: Map<string, string>;
  moved?: Map<string, string>;
};

export type CleanupPlan = {
  structure: PlanNode[];
  untouched: PlanNode[];
  duplicates: DuplicateGroup[];
  similar: PlanPair[];
  sameTrip: PlanPair[];
  dayRuns: PlanDayRun[];
  trips: PlanTrip[];
  placed: PlanPlaced[];
  mismatches: PlanMismatch[];
  keptApart: number;
  lostDates: PlanLostDates[];
  healSkipped: number;
  removed: PlanAlbum[];
  home: AlbumCleanupHomeAreaDto | null;
  /** Everything left out of the changes by "Leave as it is", so nothing the person excluded is merged. */
  leftOutIds: Set<string>;
  summary: {
    albumsBefore: number;
    topLevelAfter: number;
    duplicateGroups: number;
    albumsMerged: number;
    similarMerged: number;
    daysCombined: number;
    albumsCombined: number;
    lostPhotos: number;
    datesHealed: number;
    collections: number;
    albumsMoved: number;
    untouched: number;
    removed: number;
  };
};

const leafFor = (album: PlanAlbum, name: string): PlanNode => ({
  id: album.id,
  kind: 'album',
  name,
  sourceName: album.originalName,
  currentName: album.originalName,
  albumCount: 1,
  photoCount: album.count,
  locked: album.locked,
  shared: album.shared,
  copies: album.copies || 1,
  days: album.days || 0,
  trip: Boolean(album.trip),
  children: [],
});

const leavesOf = (node: PlanNode): PlanNode[] =>
  node.kind === 'album' ? [node] : node.children.flatMap((child) => leavesOf(child));

const refresh = (node: PlanNode): PlanNode => {
  if (node.kind === 'album') {
    return node;
  }
  for (const child of node.children) {refresh(child);}
  node.children.sort((a, b) => (a.kind === b.kind ? byName(a, b) : a.kind === 'collection' ? -1 : 1));
  node.albumCount = node.children.reduce((sum, child) => sum + child.albumCount, 0);
  node.photoCount = node.children.reduce((sum, child) => sum + child.photoCount, 0);
  return node;
};

const findNode = (list: PlanNode[], id: string): PlanNode | null => {
  for (const node of list) {
    if (node.id === id) {
      return node;
    }
    const found = findNode(node.children, id);
    if (found) {
      return found;
    }
  }
  return null;
};

const detach = (list: PlanNode[], id: string): PlanNode | null => {
  const index = list.findIndex((node) => node.id === id);
  if (index !== -1) {
    return list.splice(index, 1)[0];
  }
  for (const node of list) {
    const found = detach(node.children, id);
    if (found) {
      return found;
    }
  }
  return null;
};

type Entry = { album: PlanAlbum; when: CleanupDay | null; prefix: string[] | null };

/** The largest album of a run gives the combined album its starting point; the server picks from true counts. */
const largestOf = (members: PlanAlbum[]) => [...members].sort((a, b) => b.count - a.count)[0];

/**
 * Merge exact-name duplicates, then nest on delimiters. A level exists only where at least `minGroup` albums share
 * it; otherwise the segment stays in the name.
 */
export const buildPlan = (facts: AlbumCleanupFactsDto, options: PlanOptions = {}): CleanupPlan => {
  const {
    delimiters = DEFAULT_DELIMITERS,
    mergeDuplicates = true,
    minGroup = DEFAULT_MIN_GROUP,
    dateOnly = 'year',
    skippedDuplicates = new Set<string>(),
    forcedDuplicates = new Set<string>(),
    mergedSimilar = new Set<string>(),
    combineDays = true,
    keptDays = new Set<string>(),
    usePhotoData = true,
    homeArea = 0,
    keptPlaces = new Set<string>(),
    keptTrips = new Set<string>(),
    renamedToPhotoDate = new Set<string>(),
    healedAlbums = new Set<string>(),
    leftOut = new Set<string>(),
    flattened = new Set<string>(),
    renamed = new Map<string, string>(),
    moved = new Map<string, string>(),
  } = options;

  const albums: PlanAlbum[] = facts.albums.map((album) => ({
    id: album.id,
    name: album.name,
    originalName: album.name,
    count: album.count,
    locked: album.locked,
    shared: album.shared,
    createdAt: album.createdAt,
    gps: album.gps ?? null,
    realDay: album.span ? fromSerial(album.span.middle) : null,
    coverAssetId: album.coverAssetId ?? null,
  }));

  const home = facts.homeAreas[homeArea] ?? facts.homeAreas[0] ?? null;
  const isHome = (gps: Gps) => !!home && distanceKm(gps, home) <= HOME_RADIUS_KM;
  const sameNameFact = new Map(facts.sameName.map((group) => [group.key, group]));

  const sameName = new Map<string, PlanAlbum[]>();
  for (const album of albums) {
    const key = albumNameKey(album.name);
    if (!sameName.has(key)) {
      sameName.set(key, []);
    }
    sameName.get(key)!.push(album);
  }
  const duplicates: DuplicateGroup[] = [];
  const working: PlanAlbum[] = [];
  for (const [key, copies] of sameName) {
    if (copies.length === 1) {
      working.push(copies[0]);
      continue;
    }
    const fact = sameNameFact.get(key);
    const winner = copies.find(({ id }) => id === fact?.winnerId) ?? largestOf(copies);
    const others = copies.filter(({ id }) => id !== winner.id).sort((a, b) => b.count - a.count);
    const count = fact?.union ?? winner.count + others.reduce((sum, album) => sum + album.count, 0);
    const locked = copies.every((album) => album.locked);
    // Merging a shared album changes who sees which photos, so it is never automatic.
    const shared = copies.some((album) => album.shared);
    const skipped = !mergeDuplicates || skippedDuplicates.has(key) || (shared && !forcedDuplicates.has(key));
    duplicates.push({ key, name: winner.name, winner, others, count, locked, shared, skipped });
    if (skipped) {
      working.push(...copies);
    } else {
      working.push({ ...winner, count, locked, copies: copies.length });
    }
  }

  // Same photos under different names: only a suggestion, because one of the names is lost.
  const present = new Map(working.map((album) => [album.id, album]));
  const absorbedBySimilar = new Set<string>();
  const mergedInto = new Map<string, { count: number; copies: number }>();
  const pairsFrom = (
    pairs: AlbumCleanupFactsDto['samePhotos'],
    build: (winner: PlanAlbum, loser: PlanAlbum, fact: AlbumCleanupFactsDto['samePhotos'][number]) => number,
  ) =>
    pairs.flatMap((fact): PlanPair[] => {
      const winner = present.get(fact.winnerId);
      const loser = present.get(fact.winnerId === fact.firstId ? fact.secondId : fact.firstId);
      if (!winner || !loser) {
        return [];
      }
      const key = `${winner.id}+${loser.id}`;
      const merged = mergedSimilar.has(key);
      const count = build(winner, loser, fact);
      if (merged) {
        absorbedBySimilar.add(loser.id);
        const current = mergedInto.get(winner.id);
        mergedInto.set(winner.id, {
          count: current ? current.count + loser.count : count,
          copies: (current?.copies ?? winner.copies ?? 1) + 1,
        });
      }
      return [{ key, winner, loser, share: fact.share, count, merged, shared: winner.shared || loser.shared }];
    });
  const similar = pairsFrom(facts.samePhotos, (_winner, _loser, fact) => fact.union);
  // Same dates in the same place, with no photos in common: also only a suggestion.
  const sameTrip = usePhotoData ? pairsFrom(facts.sameTrip, (_winner, _loser, fact) => fact.union) : [];
  const afterSimilar = working
    .filter((album) => !absorbedBySimilar.has(album.id))
    .map((album) => {
      const merged = mergedInto.get(album.id);
      return merged ? { ...album, count: merged.count, copies: merged.copies } : album;
    });

  // What the photos say: where they were taken and when. Names that disagree are flagged and never used as dates.
  const mismatches: PlanMismatch[] = [];
  const placed: PlanPlaced[] = [];
  const entries = afterSimilar.map((original): Entry => {
    let album = original;
    const nameIsDate = isDateOnly(album.name);
    const segments = album.segments || splitName(album.name, delimiters);
    const when = nameIsDate ? dayOf(album.name) : segments.length > 1 ? dayOf(segments.at(-1)!) : null;
    if (usePhotoData && when && album.realDay && Math.abs(album.realDay.serial - when.serial) > NAME_MISMATCH_DAYS) {
      const isRenamed = renamedToPhotoDate.has(album.id);
      const photoLabel = dayLabel(album.realDay.serial);
      mismatches.push({ key: album.id, album, photoLabel, renamed: isRenamed });
      if (isRenamed) {
        album = {
          ...album,
          name: nameIsDate ? photoLabel : [...segments.slice(0, -1), photoLabel].join(', '),
          segments: nameIsDate ? undefined : [...segments.slice(0, -1), photoLabel],
        };
      }
      return { album, when: null, prefix: null };
    }
    let prefix: string[] | null = nameIsDate ? null : segments.slice(0, -1);
    if (usePhotoData && nameIsDate && when && album.gps?.city) {
      const kept = keptPlaces.has(album.id);
      placed.push({ key: album.id, album, city: album.gps.city, share: album.gps.share, kept });
      if (!kept) {
        prefix = [album.gps.city];
        album = { ...album, segments: [album.gps.city, album.name] };
      }
    }
    return { album, when, prefix };
  });

  // Days in a row away from home are one trip, wherever in the trip each day was.
  const trips: PlanTrip[] = [];
  const inTrip = new Set<string>();
  const tripAlbums: PlanAlbum[] = [];
  const closeTrip = (run: Entry[]) => {
    if (run.length < 2) {
      return;
    }
    const members = run.map((item) => item.album);
    const tally = new Map<string, number>();
    for (const album of members) {
      tally.set(album.gps!.city, (tally.get(album.gps!.city) ?? 0) + 1);
    }
    const city = [...tally].sort((a, b) => b[1] - a[1])[0][0];
    const [first, last] = [run[0].when!, run.at(-1)!.when!];
    const key = `trip>${first.serial}>${city}`;
    const name = `${city}, ${rangeLabel(first, last)}`;
    const count = members.reduce((sum, album) => sum + album.count, 0);
    const skipped = keptTrips.has(key);
    trips.push({ key, name, cities: [...tally.keys()], albums: members, count, skipped, year: first.year });
    if (skipped) {
      return;
    }
    for (const album of members) {inTrip.add(album.id);}
    tripAlbums.push({
      ...largestOf(members),
      name,
      segments: ['Trips', String(first.year), name],
      count,
      copies: 1,
      days: last.serial - first.serial + 1,
      trip: true,
      locked: members.every((album) => album.locked),
    });
  };
  if (usePhotoData) {
    const away = entries
      .filter(({ album, when }) => when && !album.shared && album.gps?.city && !isHome(album.gps))
      .sort((a, b) => a.when!.serial - b.when!.serial);
    let run: Entry[] = [];
    for (const item of away) {
      const last = run.at(-1);
      if (
        last &&
        (item.when!.serial - last.when!.serial > TRIP_GAP_DAYS ||
          item.when!.serial - run[0].when!.serial >= TRIP_MAX_DAYS ||
          distanceKm(item.album.gps!, last.album.gps!) >= TRIP_HOP_KM)
      ) {
        closeTrip(run);
        run = [];
      }
      run.push(item);
    }
    closeTrip(run);
  }

  // Back-to-back days in one place become one album. A place has to tie them together, and a shared album stays out.
  const places = new Map<string, Entry[]>();
  for (const entry of entries) {
    if (inTrip.has(entry.album.id) || entry.album.shared || !entry.when || !entry.prefix?.length) {
      continue;
    }
    const key = entry.prefix.join('>').toLowerCase();
    if (!places.has(key)) {
      places.set(key, []);
    }
    places.get(key)!.push(entry);
  }
  let keptApart = 0;
  const dayRuns: PlanDayRun[] = [];
  const absorbedDays = new Set<string>();
  const combined: PlanAlbum[] = [];
  const closeRun = (key: string, run: Entry[]) => {
    if (run.length < 2) {
      return;
    }
    const [first, last] = [run[0], run.at(-1)!];
    const members = run.map((item) => item.album);
    const label = rangeLabel(first.when!, last.when!);
    const runKey = `days>${key}>${first.when!.serial}`;
    const name = `${first.prefix!.join(', ')}, ${label}`;
    const count = members.reduce((sum, album) => sum + album.count, 0);
    const skipped = !combineDays || keptDays.has(runKey);
    dayRuns.push({ key: runKey, name, albums: members, count, skipped });
    if (skipped) {
      return;
    }
    for (const album of members) {absorbedDays.add(album.id);}
    combined.push({
      ...largestOf(members),
      name,
      segments: [...first.prefix!, label],
      count,
      copies: 1,
      days: run.length,
      locked: members.every((album) => album.locked),
    });
  };
  for (const [key, items] of places) {
    items.sort((a, b) => a.when!.serial - b.when!.serial);
    let run = [items[0]];
    for (const item of items.slice(1)) {
      const last = run.at(-1)!;
      const nextDay = item.when!.serial === last.when!.serial + 1;
      const gpsDiffers =
        usePhotoData && item.album.gps?.city && last.album.gps?.city && item.album.gps.city !== last.album.gps.city;
      if (nextDay && gpsDiffers) {
        keptApart += 1;
      }
      if (nextDay && !gpsDiffers && run.length < MAX_DAY_RUN) {
        run.push(item);
      } else {
        closeRun(key, run);
        run = [item];
      }
    }
    closeRun(key, run);
  }
  const shaped = [
    ...entries.map((entry) => entry.album).filter((album) => !absorbedDays.has(album.id) && !inTrip.has(album.id)),
    ...combined,
    ...tripAlbums,
  ];

  type TrieNode = {
    path: string;
    name: string;
    children: Map<string, TrieNode>;
    albums: PlanAlbum[];
    total: number;
    pinned?: boolean;
  };
  const root: TrieNode = { path: '', name: '', children: new Map(), albums: [], total: 0 };
  const dates: PlanAlbum[] = [];
  for (const album of shaped) {
    if (!album.segments && isDateOnly(album.name)) {
      dates.push(album);
      continue;
    }
    let node = root;
    for (const segment of album.segments || splitName(album.name, delimiters)) {
      const key = segment.toLowerCase();
      if (!node.children.has(key)) {
        node.children.set(key, {
          path: `${node.path}>${key}`,
          name: segment,
          children: new Map(),
          albums: [],
          total: 0,
        });
      }
      node = node.children.get(key)!;
      // A found trip always goes under Trips, even when it's the only one.
      if (album.trip) {
        node.pinned = true;
      }
    }
    node.albums.push(album);
  }
  const total = (node: TrieNode): number => {
    node.total = node.albums.length;
    for (const child of node.children.values()) {
      node.total += total(child);
    }
    return node.total;
  };
  total(root);

  const shape = (node: TrieNode, prefix: string): PlanNode[] => {
    const name = prefix ? `${prefix} - ${node.name}` : node.name;
    const kids = [...node.children.values()];
    const isLevel = kids.length > 0 && (node.total >= minGroup || node.pinned) && !flattened.has(node.path);
    if (isLevel) {
      return [
        {
          id: node.path,
          kind: 'collection',
          name: renamed.get(node.path) || name,
          autoName: name,
          albumCount: 0,
          photoCount: 0,
          children: [...kids.flatMap((kid) => shape(kid, '')), ...node.albums.map((album) => leafFor(album, name))],
          flattenable: true,
        },
      ];
    }
    return [...node.albums.map((album) => leafFor(album, name)), ...kids.flatMap((kid) => shape(kid, name))];
  };

  let structure: PlanNode[] = [];
  let untouched: PlanNode[] = [];
  for (const child of root.children.values()) {
    for (const node of shape(child, '')) {
      if (node.kind === 'collection') {
        structure.push(node);
      } else {
        untouched.push({ ...node, name: node.sourceName! });
      }
    }
  }

  const removed: PlanAlbum[] = [];
  const dateGroups = new Map<string, PlanNode>();
  for (const album of dates) {
    if (dateOnly === 'leave') {
      untouched.push(leafFor(album, album.name));
    } else if (dateOnly === 'remove' && !album.shared) {
      removed.push(album);
    } else {
      // A shared date-only album is never removed; it groups by year instead.
      const { year, month } = (usePhotoData && album.realDay) || dateParts(album.name);
      const id = `date>${year}`;
      if (!dateGroups.has(id)) {
        dateGroups.set(id, {
          id,
          kind: 'collection',
          name: renamed.get(id) || String(year),
          autoName: String(year),
          albumCount: 0,
          photoCount: 0,
          children: [],
          isDate: true,
        });
      }
      const group = dateGroups.get(id)!;
      if (dateOnly === 'year-month') {
        const monthId = `${id}>${month}`;
        let monthGroup = group.children.find((item) => item.id === monthId);
        if (!monthGroup) {
          monthGroup = {
            id: monthId,
            kind: 'collection',
            name: MONTH_NAMES[month],
            autoName: MONTH_NAMES[month],
            albumCount: 0,
            photoCount: 0,
            children: [],
            isDate: true,
          };
          group.children.push(monthGroup);
        }
        monthGroup.children.push(leafFor(album, album.name));
      } else {
        group.children.push(leafFor(album, album.name));
      }
    }
  }
  for (const group of dateGroups.values()) {
    const twin = structure.find((item) => item.name.toLowerCase() === group.name.toLowerCase());
    if (twin) {
      twin.children.push(...group.children);
    } else {
      structure.push(group);
    }
  }

  const leftOutIds = new Set<string>();
  const applyLeftOut = (list: PlanNode[]): PlanNode[] =>
    list.filter((node) => {
      if (leftOut.has(node.id)) {
        for (const leaf of leavesOf(node)) {
          leftOutIds.add(leaf.id);
          untouched.push({ ...leaf, name: leaf.sourceName! });
        }
        return false;
      }
      node.children = applyLeftOut(node.children);
      return true;
    });
  structure = applyLeftOut(structure);

  for (const [id, target] of moved) {
    if (id === target) {
      continue;
    }
    const destination = findNode(structure, target);
    if (!destination || findNode([findNode(structure, id) || ({ children: [] } as unknown as PlanNode)], target)) {
      continue;
    }
    const node = detach(structure, id);
    if (node) {
      destination.children.push(node);
    }
  }

  // Rule 4: each level reuses a collection of that name under the same parent, and if two match, the older one.
  const existingUnder = new Map<string, AlbumCleanupFactsDto['collections']>();
  for (const collection of facts.collections) {
    const key = `${collection.parentId ?? ''}>${albumNameKey(collection.name)}`;
    existingUnder.set(key, [...(existingUnder.get(key) ?? []), collection]);
  }
  const markExisting = (node: PlanNode, parentId: string | null) => {
    if (node.kind !== 'collection') {
      return;
    }
    const match = existingUnder.get(`${parentId ?? ''}>${albumNameKey(node.name)}`)?.[0];
    node.existing = !!match;
    node.existingId = match?.id;
    for (const child of node.children) {markExisting(child, match?.id ?? `new:${node.id}`);}
  };
  structure = structure.map((node) => refresh(node));
  for (const node of structure) {markExisting(node, null);}
  structure = structure.sort((a, b) => b.albumCount - a.albumCount || byName(a, b));
  untouched = untouched.sort(byName);

  const lostDates = facts.lostDates.flatMap((item): PlanLostDates[] => {
    const album = albums.find(({ id }) => id === item.albumId);
    return album
      ? [
          {
            key: item.albumId,
            album,
            from: item.from,
            to: item.to,
            suggestions: item.suggestions,
            healed: healedAlbums.has(item.albumId),
          },
        ]
      : [];
  });

  const countGroups = (list: PlanNode[]): number =>
    list.reduce((sum, node) => sum + (node.kind === 'collection' ? 1 + countGroups(node.children) : 0), 0);
  const countExisting = (list: PlanNode[]): number =>
    list.reduce((sum, node) => sum + (node.existing ? 1 : 0) + countExisting(node.children), 0);
  const activeDuplicates = duplicates.filter((group) => !group.skipped && !leftOutIds.has(group.winner.id));
  const albumsMerged = activeDuplicates.reduce((sum, group) => sum + group.others.length, 0);
  const daysCombined = absorbedDays.size - combined.length;
  const similarMerged = absorbedBySimilar.size;
  return {
    structure,
    untouched,
    duplicates,
    similar,
    sameTrip,
    dayRuns,
    trips,
    placed,
    mismatches,
    keptApart,
    lostDates,
    healSkipped: facts.healSkipped,
    removed,
    home,
    leftOutIds,
    summary: {
      albumsBefore: albums.length,
      topLevelAfter: structure.length + untouched.length,
      duplicateGroups: activeDuplicates.length,
      albumsMerged,
      similarMerged,
      daysCombined,
      albumsCombined: albumsMerged + similarMerged + daysCombined + inTrip.size - tripAlbums.length,
      lostPhotos: lostDates.reduce((sum, item) => sum + item.suggestions.length, 0),
      datesHealed: lostDates.filter((item) => item.healed).reduce((sum, item) => sum + item.suggestions.length, 0),
      collections: countGroups(structure) - countExisting(structure),
      albumsMoved: structure.reduce((sum, node) => sum + node.albumCount, 0),
      untouched: untouched.length,
      removed: removed.length,
    },
  };
};

/**
 * What applying this plan sends: an explicit list of operations, never planner settings, because the server checks
 * each one on its own. Healing goes first, then structure, then merges, then where each album ends up.
 */
export const operationsFor = (plan: CleanupPlan): AlbumCleanupOperationDto[] => {
  const operations: AlbumCleanupOperationDto[] = [];
  const excluded = plan.leftOutIds;

  for (const item of plan.lostDates) {
    if (item.healed && item.suggestions.length > 0) {
      operations.push({
        type: AlbumCleanupOperationType.Heal,
        albumId: item.key,
        assetIds: item.suggestions.map(({ assetId }) => assetId),
      });
    }
  }

  // Each merged or combined album, keyed by the id of the album that carries it through the tree.
  const leafIdsByMember = new Map<string, string>();
  const walkAlbums = (list: PlanNode[], visit: (leaf: PlanNode) => void) => {
    for (const node of list) {
      if (node.kind === 'album') {
        visit(node);
      } else {
        walkAlbums(node.children, visit);
      }
    }
  };
  const namedLeaves = new Map<string, string>();
  walkAlbums(plan.structure, (leaf) => {
    leafIdsByMember.set(leaf.id, leaf.id);
    namedLeaves.set(leaf.id, leaf.name);
  });

  for (const group of plan.duplicates) {
    if (!group.skipped && !excluded.has(group.winner.id)) {
      operations.push({
        type: AlbumCleanupOperationType.Merge,
        albumIds: [group.winner.id, ...group.others.map(({ id }) => id)],
        allowShared: group.shared,
      });
    }
  }
  for (const pair of [...plan.similar, ...plan.sameTrip]) {
    if (pair.merged && !excluded.has(pair.winner.id)) {
      operations.push({
        type: AlbumCleanupOperationType.Merge,
        albumIds: [pair.winner.id, pair.loser.id],
        allowShared: pair.shared,
      });
    }
  }
  const combineOf = (run: PlanDayRun) => {
    if (run.skipped) {
      return;
    }
    const carrier = largestOf(run.albums);
    if (excluded.has(carrier.id)) {
      return;
    }
    operations.push({
      type: AlbumCleanupOperationType.Combine,
      albumIds: run.albums.map(({ id }) => id),
      name: namedLeaves.get(carrier.id) ?? run.name,
    });
  };
  for (const run of plan.dayRuns) {combineOf(run);}
  for (const trip of plan.trips) {combineOf(trip);}

  const place = (nodes: PlanNode[], parentTempId: string | undefined) => {
    for (const node of nodes) {
      if (node.kind === 'collection') {
        operations.push({
          type: AlbumCleanupOperationType.CreateCollection,
          tempId: node.id,
          name: node.name,
          ...(parentTempId ? { parentTempId } : { parentId: null }),
        });
        place(node.children, node.id);
      } else {
        const combined = (node.days ?? 0) > 1 || node.trip;
        if (!combined && node.name !== node.currentName) {
          operations.push({ type: AlbumCleanupOperationType.Rename, albumId: node.id, name: node.name });
        }
        operations.push({
          type: AlbumCleanupOperationType.Move,
          albumId: node.id,
          ...(parentTempId ? { parentTempId } : { parentId: null }),
        });
      }
    }
  };
  place(plan.structure, undefined);
  for (const node of plan.untouched) {
    // Stays at the top level; only a date rename the person asked for can reach here.
    if (node.name !== node.currentName && node.currentName) {
      operations.push({ type: AlbumCleanupOperationType.Rename, albumId: node.id, name: node.name });
    }
  }

  for (const album of plan.removed) {
    operations.push({ type: AlbumCleanupOperationType.Remove, albumId: album.id });
  }
  return operations;
};
