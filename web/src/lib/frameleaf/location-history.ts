import {
  createLocationHistorySource,
  createLocationHistoryUpload,
  isHttpError,
  uploadLocationHistoryPart,
  type LocationFillDayDto,
  type LocationFillProposalDto,
  type LocationHistorySourceResponseDto,
  type MapReverseGeocodeResponseDto,
} from '@frameleaf/sdk';
import { sendFileChunks } from '$lib/frameleaf/takeout';

/**
 * FL-999: the rules behind Fix locations › Use your location history, kept apart from the page so
 * they can be read and tested on their own.
 */

export const HISTORY_ACCEPT = '.json,.gpx,.rec,.geojson,.zip';
export const FILL_GAPS = [5, 15, 60] as const;
export type FillGap = (typeof FILL_GAPS)[number];
/** The most photos one apply request may name. */
export const FILL_APPLY_BATCH = 5000;
/** A day shows this many photos until it is opened. */
export const DAY_PREVIEW = 6;

const WORKING: ReadonlySet<string> = new Set(['proposing', 'applying', 'undoing']);
export const isWorkingRun = (status: string | undefined) => status !== undefined && WORKING.has(status);

export const isHistoryFileName = (name: string) => {
  const lower = name.toLowerCase();
  return HISTORY_ACCEPT.split(',').some((extension) => lower.endsWith(extension));
};

export type SourceState = 'reading' | 'added' | 'failed';
export const sourceState = (source: LocationHistorySourceResponseDto): SourceState => {
  if (source.error) {
    return 'failed';
  }
  return source.importedAt ? 'added' : 'reading';
};

/** The server says this when the staged file went missing; anything else means the file itself. */
export const isLostUpload = (source: LocationHistorySourceResponseDto) => !!source.error?.includes('upload was lost');

/** Names of the apps and formats, the same in every language. */
const KIND_NAMES: Record<string, string> = {
  'google-timeline': 'Google Timeline',
  'google-records': 'Google Timeline',
  gpx: 'GPX',
  owntracks: 'OwnTracks',
  geojson: 'GeoJSON',
};
export const kindName = (kind: string | null) => (kind ? KIND_NAMES[kind] : undefined);

/** The earliest and latest moment across files that were read. */
export const historySpan = (sources: LocationHistorySourceResponseDto[]) => {
  const added = sources.filter((source) => source.firstAt && source.lastAt);
  if (added.length === 0) {
    return;
  }
  let first = added[0].firstAt!;
  let last = added[0].lastAt!;
  for (const source of added) {
    if (Date.parse(source.firstAt!) < Date.parse(first)) {
      first = source.firstAt!;
    }
    if (Date.parse(source.lastAt!) > Date.parse(last)) {
      last = source.lastAt!;
    }
  }
  return { first, last };
};

/** Where a part that the server refused should start again, from its "Resume this upload at byte N". */
const resumeOffset = (error: unknown, offset: number) => {
  if (!isHttpError(error) || error.status !== 409) {
    return;
  }
  const message = (error.data as { message?: unknown } | undefined)?.message;
  const match = typeof message === 'string' ? /byte (\d+)/.exec(message) : null;
  const resume = match ? Number(match[1]) : undefined;
  return resume === offset ? undefined : resume;
};

/** Send a file in parts, then hand it to the server to read in the background. */
export const uploadHistoryFile = async (file: File, signal: AbortSignal, onProgress: (sent: number) => void) => {
  const { id } = await createLocationHistoryUpload({ locationHistoryUploadCreateDto: { size: file.size } }, { signal });
  await sendFileChunks(
    file,
    0,
    async (offset, body) => {
      try {
        const part = await uploadLocationHistoryPart(
          { id, offset, body },
          { headers: { 'Content-Type': 'application/octet-stream' }, signal },
        );
        return part.receivedBytes;
      } catch (error) {
        const resume = resumeOffset(error, offset);
        if (resume === undefined) {
          throw error;
        }
        return resume;
      }
    },
    signal,
    onProgress,
  );
  return createLocationHistorySource(
    { locationHistorySourceCreateDto: { uploadId: id, fileName: file.name } },
    { signal },
  );
};

/** Add a page of days to those loaded; a day cut by the page break continues in the same group. */
export const mergeDays = (loaded: LocationFillDayDto[], next: LocationFillDayDto[]) => {
  const days = loaded.map((day) => ({ ...day, proposals: [...day.proposals] }));
  for (const day of next) {
    const last = days.at(-1);
    if (last?.day === day.day) {
      last.proposals.push(...day.proposals);
    } else {
      days.push({ ...day, proposals: [...day.proposals] });
    }
  }
  return days;
};

/** Group a flat list again, in its order. */
export const groupByDay = (proposals: LocationFillProposalDto[]) =>
  mergeDays(
    [],
    proposals.map((proposal) => ({ day: proposal.localDateTime.slice(0, 10), proposals: [proposal] })),
  );

export const chunkIds = (ids: string[], size = FILL_APPLY_BATCH) => {
  const chunks: string[][] = [];
  for (let index = 0; index < ids.length; index += size) {
    chunks.push(ids.slice(index, index + size));
  }
  return chunks;
};

/**
 * What is ticked, without loading every proposal: everything except `flipped`, or (after Deselect
 * all) only `flipped`.
 */
export type FillSelection = { all: boolean; flipped: ReadonlySet<string> };
export const everySelected = (): FillSelection => ({ all: true, flipped: new Set() });
export const noneSelected = (): FillSelection => ({ all: false, flipped: new Set() });
export const isSelected = ({ all, flipped }: FillSelection, id: string) => all !== flipped.has(id);
export const selectedCount = ({ all, flipped }: FillSelection, total: number) =>
  all ? Math.max(total - flipped.size, 0) : flipped.size;
export const setSelected = (selection: FillSelection, ids: string[], on: boolean): FillSelection => {
  const flipped = new Set(selection.flipped);
  for (const id of ids) {
    if (on === selection.all) {
      flipped.delete(id);
    } else {
      flipped.add(id);
    }
  }
  return { all: selection.all, flipped };
};

/** Nearby photos share a lookup: two decimals is about a kilometre. */
export const placeKey = ({ latitude, longitude }: Pick<LocationFillProposalDto, 'latitude' | 'longitude'>) =>
  `${latitude.toFixed(2)},${longitude.toFixed(2)}`;
export const placeName = (found: MapReverseGeocodeResponseDto | undefined) =>
  found?.city || found?.state || found?.country || undefined;
