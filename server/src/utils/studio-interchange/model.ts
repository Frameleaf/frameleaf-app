/**
 * The neutral timeline every editor reader produces (FL-1541). It is OpenTimelineIO's own schema
 * (timeline, stack, track, clip, gap, transition, media reference, rational time) so the
 * OpenTimelineIO reader stays thin and a later export (FL-1566) can write it back. What OpenTimelineIO
 * has no field for (a title's words and font, sound fades, a picture move) lives in each object's
 * `frameleaf` block, already normalised by the reader.
 *
 * A reader keeps whatever it does not understand in `metadata`, untouched, so a later release can use
 * it. The mapper never reads `metadata`.
 */

/** A time as OpenTimelineIO writes it: `value` frames at `rate` frames per second. */
export type RationalTime = { value: number; rate: number };
export type TimeRange = { startTime: RationalTime; duration: RationalTime };

/** Where a clip's media came from in the other editor. Paths never reach the Studio graph. */
export type MediaReference =
  | {
      kind: 'external';
      /** A stable key the media matcher (FL-1543) answers for; usually the original path or URL. */
      key: string;
      /** The file name alone, shown as the clip's label. */
      name: string;
      /** The whole length of the media, when the editor wrote it. */
      availableRange?: TimeRange;
      /** What the editor knew of the file, for matching and for a placeholder's size. */
      facts?: { kind?: 'video' | 'audio' | 'image'; width?: number; height?: number; hasAudio?: boolean };
    }
  | { kind: 'missing'; name: string }
  | { kind: 'generator'; generator: 'title' | 'solid' | 'other'; name: string };

export type ClipFrameleaf = {
  /** Sound level in dB, and fades in seconds. */
  volumeDb?: number;
  fadeInSeconds?: number;
  fadeOutSeconds?: number;
  muted?: boolean;
  /** Steady speed: 1 is normal, 2 twice as fast; negative plays backwards. */
  speed?: number;
  /** A speed that changes over the clip; not drawn yet, reported. */
  speedRamp?: boolean;
  /** The picture move relative to the fitted picture: scale 1 fills as Studio fits, x and y in canvas pixels from centre. */
  transform?: { scale?: number; x?: number; y?: number; rotation?: number; opacity?: number };
  /** A title's words and look, when the clip is a title generator. */
  title?: { text: string; font?: string; size?: number; color?: string; align?: 'left' | 'center' | 'right' };
  /** Effects the reader found, by the editor's own name. The mapper reports the ones Studio has no match for. */
  effects?: { name: string; fromPlugin?: boolean }[];
};

export type Clip = {
  type: 'clip';
  name: string;
  /**
   * As OpenTimelineIO: `startTime` is where the clip starts in its media (media frames) and `duration`
   * is the clip's length on the timeline. With a speed the media used is `duration × speed`.
   */
  sourceRange: TimeRange;
  mediaReference: MediaReference;
  markers?: Marker[];
  frameleaf?: ClipFrameleaf;
  metadata?: Record<string, unknown>;
};

export type Gap = { type: 'gap'; sourceRange: TimeRange };

/**
 * A transition between its two neighbours. It takes no time of its own: `inOffset` reaches back into
 * the clip before the cut and `outOffset` forward into the clip after it (OpenTimelineIO).
 */
export type Transition = {
  type: 'transition';
  /** The editor's name for it ("Cross Dissolve", "SMPTE_Dissolve", "Page Peel"). */
  name: string;
  inOffset: RationalTime;
  outOffset: RationalTime;
  metadata?: Record<string, unknown>;
};

/** A nested timeline inside a track (a nest, a compound clip). Becomes a Studio composition. */
export type Stack = {
  type: 'stack';
  name: string;
  tracks: Track[];
  /** The part of the nest used; absent means all of it. */
  sourceRange?: TimeRange;
  markers?: Marker[];
  metadata?: Record<string, unknown>;
};

export type TrackChild = Clip | Gap | Transition | Stack;

export type Track = {
  kind: 'video' | 'audio';
  name: string;
  children: TrackChild[];
  muted?: boolean;
  metadata?: Record<string, unknown>;
};

export type Marker = {
  name: string;
  /** Where on the timeline; a duration above 0 is a range. */
  markedRange: TimeRange;
  /** OpenTimelineIO's colour names (RED, GREEN, ...) or `#rrggbb`. */
  color?: string;
  note?: string;
};

export type Timeline = {
  name: string;
  /** The editor's exact frame rate. */
  rate: { num: number; den: number };
  canvas: { width: number; height: number };
  /** Bottom track first, as OpenTimelineIO lists them. */
  tracks: Track[];
  markers?: Marker[];
  metadata?: Record<string, unknown>;
};

/** A project as a reader returns it: the editor it came from and every timeline in it. */
export type InterchangeProject = {
  /** Which mapping tables apply. */
  source: 'premiere' | 'resolve' | 'finalcut' | 'imovie' | 'otio' | 'fcp7' | 'edl' | 'aaf';
  /** The editor's version when the file says, for "untested version" reports. */
  sourceVersion?: string;
  timelines: Timeline[];
};

export const seconds = (time: RationalTime) => (time.rate > 0 ? time.value / time.rate : 0);
