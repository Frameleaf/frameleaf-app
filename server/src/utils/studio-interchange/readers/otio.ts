/**
 * OpenTimelineIO (`.otio` JSON; `.otioz` and `.otiod` carry it as `content.otio` beside the media) to
 * the neutral model (FL-1547). The neutral model is OpenTimelineIO's own schema, so this reader mostly
 * renames fields and checks types. Unknown schemas inside a track are kept as gaps of their length so
 * the timing holds, and counted in the report.
 */
import type {
  Cdl,
  Clip,
  ClipFrameleaf,
  InterchangeProject,
  Marker,
  MediaReference,
  RationalTime,
  Stack,
  TimeRange,
  Timeline,
  Track,
  TrackChild,
} from 'src/utils/studio-interchange/model.js';
import {
  InterchangeNotice,
  InterchangeReadError,
  fileNameOf,
  kindFromName,
} from 'src/utils/studio-interchange/readers/common.js';

const MAX_BYTES = 128 * 1024 * 1024;
const MAX_ITEMS = 1_000_000;
const MAX_DEPTH = 64;

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const schemaOf = (value: Json) => (typeof value.OTIO_SCHEMA === 'string' ? value.OTIO_SCHEMA.split('.', 1)[0] : '');
const text = (value: unknown) => (typeof value === 'string' ? value : '');

const time = (value: unknown): RationalTime | null => {
  if (!isObject(value)) {
    return null;
  }
  const rate = Number(value.rate);
  const frames = Number(value.value);
  return Number.isFinite(rate) && rate > 0 && Number.isFinite(frames) ? { value: frames, rate } : null;
};
const range = (value: unknown): TimeRange | null => {
  if (!isObject(value)) {
    return null;
  }
  const startTime = time(value.start_time);
  const duration = time(value.duration);
  return startTime && duration ? { startTime, duration } : null;
};

/** An exact rate for a float rate: whole numbers and the n/1001 rates. */
export const exactRate = (rate: number) => {
  if (Number.isSafeInteger(rate)) {
    return { num: rate, den: 1 };
  }
  const ntsc = Math.round((rate * 1001) / 1000) * 1000;
  return Math.abs(ntsc / 1001 - rate) < 1e-3 ? { num: ntsc, den: 1001 } : { num: Math.round(rate * 1000), den: 1000 };
};

type Context = { items: number; skipped: number; disabled: number };

const markersOf = (value: unknown): Marker[] =>
  (Array.isArray(value) ? value : []).filter(isObject).flatMap((marker) => {
    const markedRange = range(marker.marked_range);
    if (!markedRange) {
      return [];
    }
    const note = text(marker.comment).trim();
    return [
      {
        name: text(marker.name) || 'Marker',
        markedRange,
        ...(text(marker.color) && { color: text(marker.color) }),
        ...(note && { note }),
      },
    ];
  });

const triple = (value: unknown): [number, number, number] | null =>
  Array.isArray(value) && value.length === 3 && value.every((part) => Number.isFinite(Number(part)))
    ? [Number(value[0]), Number(value[1]), Number(value[2])]
    : null;

/** A CDL OpenTimelineIO's EDL and ALE adapters put in `metadata.cdl`. */
export const cdlFromMetadata = (metadata: unknown): Cdl | undefined => {
  const cdl = isObject(metadata) && isObject(metadata.cdl) ? metadata.cdl : undefined;
  const sop = cdl && isObject(cdl.asc_sop) ? cdl.asc_sop : undefined;
  const slope = triple(sop?.slope);
  const offset = triple(sop?.offset);
  const power = triple(sop?.power);
  if (!slope || !offset || !power) {
    return undefined;
  }
  const saturation = Number(cdl?.asc_sat ?? 1);
  return { slope, offset, power, saturation: Number.isFinite(saturation) ? saturation : 1 };
};

const mediaReferenceOf = (value: unknown, fallback: string): MediaReference => {
  if (!isObject(value)) {
    return { kind: 'missing', name: fallback };
  }
  const name = text(value.name) || fallback;
  switch (schemaOf(value)) {
    case 'ExternalReference': {
      const url = text(value.target_url);
      if (!url) {
        return { kind: 'missing', name };
      }
      const availableRange = range(value.available_range);
      const kind = kindFromName(url);
      return {
        kind: 'external',
        key: url,
        name: fileNameOf(url),
        ...(availableRange && { availableRange }),
        ...(kind && { facts: { kind } }),
      };
    }
    case 'ImageSequenceReference': {
      const base = text(value.target_url_base);
      const prefix = text(value.name_prefix);
      return base
        ? { kind: 'external', key: `${base}${prefix}`, name: prefix || fileNameOf(base) }
        : { kind: 'missing', name };
    }
    case 'GeneratorReference': {
      const kind = text(value.generator_kind).toLowerCase();
      return {
        kind: 'generator',
        generator:
          kind.includes('text') || kind.includes('title') ? 'title' : kind.includes('solid') ? 'solid' : 'other',
        name: name || kind || 'Generator',
      };
    }
    default: {
      return { kind: 'missing', name };
    }
  }
};

const frameleafOf = (clip: Json): ClipFrameleaf => {
  const frameleaf: ClipFrameleaf = {};
  const effects: NonNullable<ClipFrameleaf['effects']> = [];
  for (const effect of Array.isArray(clip.effects) ? clip.effects : []) {
    if (!isObject(effect)) {
      continue;
    }
    const schema = schemaOf(effect);
    const scalar = Number(effect.time_scalar);
    if (schema === 'LinearTimeWarp' && Number.isFinite(scalar)) {
      frameleaf.speed = (frameleaf.speed ?? 1) * scalar;
    } else if (schema === 'FreezeFrame') {
      effects.push({ name: 'Freeze frame' });
    } else {
      effects.push({ name: text(effect.effect_name) || text(effect.name) || schema || 'An effect' });
    }
  }
  if (effects.length > 0) {
    frameleaf.effects = effects;
  }
  const cdl = cdlFromMetadata(clip.metadata);
  if (cdl) {
    frameleaf.grade = { cdl };
  }
  const own = isObject(clip.metadata) && isObject(clip.metadata.frameleaf) ? clip.metadata.frameleaf : undefined;
  if (own) {
    // What Frameleaf wrote when it sent a project out (FL-1566) comes back as it was.
    Object.assign(frameleaf, own);
  }
  return frameleaf;
};

const readChild = (context: Context, value: unknown, depth: number): TrackChild | null => {
  if (!isObject(value)) {
    return null;
  }
  if (++context.items > MAX_ITEMS || depth > MAX_DEPTH) {
    throw new InterchangeReadError('too-complex', 'The project file is too deeply nested or too large to read');
  }
  const sourceRange = range(value.source_range);
  if (value.enabled === false) {
    context.disabled++;
    return sourceRange ? { type: 'gap', sourceRange } : null;
  }
  switch (schemaOf(value)) {
    case 'Gap': {
      return sourceRange ? { type: 'gap', sourceRange } : null;
    }
    case 'Transition': {
      const inOffset = time(value.in_offset);
      const outOffset = time(value.out_offset);
      return inOffset && outOffset
        ? {
            type: 'transition',
            name: text(value.transition_type) || text(value.name) || 'SMPTE_Dissolve',
            inOffset,
            outOffset,
          }
        : null;
    }
    case 'Clip': {
      const references = isObject(value.media_references) ? value.media_references : undefined;
      const active = references
        ? references[text(value.active_media_reference_key) || 'DEFAULT_MEDIA']
        : value.media_reference;
      const name = text(value.name) || 'Clip';
      const mediaReference = mediaReferenceOf(active, name);
      const window =
        sourceRange ?? (mediaReference.kind === 'external' ? mediaReference.availableRange : undefined) ?? null;
      if (!window) {
        context.skipped++;
        return null;
      }
      const markers = markersOf(value.markers);
      const frameleaf = frameleafOf(value);
      const clip: Clip = {
        type: 'clip',
        name,
        sourceRange: window,
        mediaReference,
        ...(markers.length > 0 && { markers }),
        ...(Object.keys(frameleaf).length > 0 && { frameleaf }),
        ...(isObject(value.metadata) && { metadata: value.metadata }),
      };
      return clip;
    }
    case 'Stack': {
      const markers = markersOf(value.markers);
      const stack: Stack = {
        type: 'stack',
        name: text(value.name) || 'Nest',
        tracks: tracksOf(context, value.children, depth + 1),
        ...(sourceRange && { sourceRange }),
        ...(markers.length > 0 && { markers }),
      };
      return stack;
    }
    case 'Track': {
      // A track inside a track is a nest of one track.
      return {
        type: 'stack',
        name: text(value.name) || 'Nest',
        tracks: tracksOf(context, [value], depth + 1),
        ...(sourceRange && { sourceRange }),
      };
    }
    default: {
      context.skipped++;
      return sourceRange ? { type: 'gap', sourceRange } : null;
    }
  }
};

const tracksOf = (context: Context, value: unknown, depth: number): Track[] =>
  (Array.isArray(value) ? value : []).filter(isObject).flatMap((track) => {
    if (schemaOf(track) !== 'Track') {
      context.skipped++;
      return [];
    }
    const children = (Array.isArray(track.children) ? track.children : [])
      .map((item) => readChild(context, item, depth + 1))
      .filter((item): item is TrackChild => item !== null);
    return [
      {
        kind: text(track.kind).toLowerCase() === 'audio' ? 'audio' : 'video',
        name: text(track.name),
        children,
        ...(track.enabled === false && { muted: true }),
        ...(isObject(track.metadata) && { metadata: track.metadata }),
      } satisfies Track,
    ];
  });

/** The first rate any clip states, for a timeline that does not give one. */
const firstRate = (tracks: Track[]): number | undefined => {
  for (const track of tracks) {
    for (const item of track.children) {
      if (item.type === 'clip' || item.type === 'gap') {
        return item.sourceRange.duration.rate;
      }
    }
  }
  return undefined;
};

export const readOtio = (bytes: Buffer | string): InterchangeProject => {
  const length = typeof bytes === 'string' ? Buffer.byteLength(bytes) : bytes.length;
  if (length > MAX_BYTES) {
    throw new InterchangeReadError('too-large', 'The project file is too large to read');
  }
  let document: unknown;
  try {
    document = JSON.parse(typeof bytes === 'string' ? bytes : bytes.toString('utf8'));
  } catch (error) {
    throw error instanceof RangeError
      ? new InterchangeReadError('too-complex', 'The project file is too deeply nested to read')
      : new InterchangeReadError('malformed', 'This is not an OpenTimelineIO file');
  }
  if (!isObject(document) || typeof document.OTIO_SCHEMA !== 'string') {
    throw new InterchangeReadError('unsupported', 'This is not an OpenTimelineIO file');
  }
  const context: Context = { items: 0, skipped: 0, disabled: 0 };
  const sources =
    schemaOf(document) === 'SerializableCollection'
      ? (Array.isArray(document.children) ? document.children : [])
          .filter(isObject)
          .filter((item) => schemaOf(item) === 'Timeline')
      : [document];
  const timelines: Timeline[] = sources.flatMap((source) => {
    if (schemaOf(source) !== 'Timeline') {
      return [];
    }
    const stack = isObject(source.tracks) ? source.tracks : undefined;
    const tracks = tracksOf(context, stack?.children, 0);
    const own =
      isObject(source.metadata) && isObject(source.metadata.frameleaf) ? source.metadata.frameleaf : undefined;
    const canvas = isObject(own?.canvas) ? own.canvas : undefined;
    const rate = time(source.global_start_time)?.rate ?? firstRate(tracks) ?? 24;
    const markers = markersOf(stack?.markers);
    return [
      {
        name: text(source.name) || 'Timeline',
        rate: exactRate(rate),
        canvas: { width: Number(canvas?.width) || 1920, height: Number(canvas?.height) || 1080 },
        tracks,
        ...(markers.length > 0 && { markers }),
        ...(isObject(source.metadata) && { metadata: source.metadata }),
      },
    ];
  });
  if (timelines.length === 0) {
    throw new InterchangeReadError('empty', 'This OpenTimelineIO file has no timeline in it');
  }
  const notices: InterchangeNotice[] = [];
  if (context.skipped > 0) {
    notices.push({
      code: 'items-unknown',
      subject: String(context.skipped),
      what: `${context.skipped} ${context.skipped === 1 ? 'item' : 'items'} of a kind Frameleaf does not read yet`,
      became: 'Left out; the space each took is kept',
    });
  }
  if (context.disabled > 0) {
    notices.push({
      code: 'clips-disabled',
      subject: String(context.disabled),
      what: `${context.disabled} ${context.disabled === 1 ? 'clip' : 'clips'} switched off in the other editor`,
      became: 'Left out; the space each took is kept',
    });
  }
  return { source: 'otio', timelines, ...(notices.length > 0 && { notices }) };
};
