/**
 * What every editor reader shares (FL-1546, FL-1547): the error it throws, time helpers, and the
 * track builder that turns clips placed at absolute times into an OpenTimelineIO track with gaps and
 * transitions. Readers whose formats place clips by position (FCPXML, Final Cut Pro 7 XML, EDL) use it.
 */
import type {
  Clip,
  InterchangeProject,
  RationalTime,
  Stack,
  Track,
  TrackChild,
} from 'src/utils/studio-interchange/model.js';

export type InterchangeReadErrorCode = 'unsupported' | 'malformed' | 'too-large' | 'too-complex' | 'empty';

/** A file a reader cannot read. The message is shown to the person. */
export class InterchangeReadError extends Error {
  constructor(
    readonly code: InterchangeReadErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** A note about the whole file for the import report: an untested version, what a format cannot carry. */
export type InterchangeNotice = InterchangeProject['notices'] extends (infer T)[] | undefined ? T : never;

const EPSILON = 1e-6;

export const rational = (secondsValue: number, rate: number): RationalTime => ({
  value: Math.round(secondsValue * rate * 1e6) / 1e6,
  rate,
});
export const timeRange = (start: number, duration: number, rate: number) => ({
  startTime: rational(start, rate),
  duration: rational(duration, rate),
});

/** The file name alone, from a path or a `file://` URL. */
export const fileNameOf = (path: string) => {
  let name = path;
  try {
    name = decodeURIComponent(path);
  } catch {
    // A stray % keeps the name as written.
  }
  return name.split(/[/\\]/).at(-1)?.trim() || path;
};

const IMAGE_EXTENSIONS = new Set([
  'jpg',
  'jpeg',
  'png',
  'tif',
  'tiff',
  'heic',
  'heif',
  'gif',
  'bmp',
  'psd',
  'webp',
  'dng',
]);
const AUDIO_EXTENSIONS = new Set(['wav', 'aif', 'aiff', 'mp3', 'm4a', 'aac', 'flac', 'caf', 'ogg']);
export const kindFromName = (name: string): 'video' | 'audio' | 'image' | undefined => {
  const extension = name.split('.').at(-1)?.toLowerCase() ?? '';
  if (IMAGE_EXTENSIONS.has(extension)) {
    return 'image';
  }
  return AUDIO_EXTENSIONS.has(extension) ? 'audio' : undefined;
};

/** A version the readers were checked against, or a notice that it was not. */
export const versionNotice = (
  format: string,
  version: string | undefined,
  tested: readonly string[],
): InterchangeNotice[] =>
  version && !tested.includes(version)
    ? [
        {
          code: 'version-untested',
          what: `${format} version ${version}`,
          became: 'Read as the nearest version Frameleaf knows; check the report for anything that looks wrong',
        },
      ]
    : [];

export type Placed = { start: number; duration: number; item: Clip | Stack };
export type PlacedTransition = { name: string; start: number; duration: number; edit?: number };

/**
 * Clips placed at absolute timeline seconds become one or more tracks: a clip that overlaps another
 * goes on a track of its own above it, so nothing is lost. Transitions attach to the cut they cover.
 */
export const placeTracks = (
  kind: Track['kind'],
  name: string,
  placed: readonly Placed[],
  transitions: readonly PlacedTransition[],
  rate: number,
): Track[] => {
  const lanes: Placed[][] = [];
  for (const entry of [...placed].toSorted((a, b) => a.start - b.start)) {
    const lane = lanes.find((items) => {
      const last = items.at(-1)!;
      return last.start + last.duration <= entry.start + EPSILON;
    });
    if (lane) {
      lane.push(entry);
    } else {
      lanes.push([entry]);
    }
  }
  return lanes.map((lane, index) => {
    const children: TrackChild[] = [];
    let position = 0;
    // A transition at a clip's edge with nothing beside it stays in the track; the mapper reports it.
    const addTransitionAt = (cut: number) => {
      const transition = transitions.find(
        (item) =>
          (item.edit === undefined || Math.abs(item.edit - cut) < EPSILON) &&
          item.start <= cut + EPSILON &&
          item.start + item.duration >= cut - EPSILON,
      );
      if (transition) {
        children.push({
          type: 'transition',
          name: transition.name,
          inOffset: rational(Math.max(0, cut - transition.start), rate),
          outOffset: rational(Math.max(0, transition.start + transition.duration - cut), rate),
        });
      }
    };
    for (const entry of lane) {
      if (entry.start > position + EPSILON) {
        if (position > 0) {
          addTransitionAt(position);
        }
        children.push({ type: 'gap', sourceRange: timeRange(0, entry.start - position, rate) });
      }
      addTransitionAt(entry.start);
      children.push(entry.item);
      position = entry.start + entry.duration;
    }
    addTransitionAt(position);
    return { kind, name: index === 0 ? name : `${name} ${index + 1}`, children };
  });
};
