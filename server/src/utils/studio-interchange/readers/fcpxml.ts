/**
 * Final Cut Pro XML (`.fcpxml`, and the `Info.fcpxml` inside a `.fcpxmld` bundle) to the neutral
 * model (FL-1546). Final Cut's magnetic timeline is flattened to tracks: the primary storyline is the
 * bottom video track, connected clips and secondary storylines go on tracks above (or below) by lane,
 * sound-only clips go on sound tracks named after their role, and an audition brings over its picked
 * clip. Compound clips and multicam clips become nests.
 *
 * Times are FCPXML rationals ("1001/30000s"). Positions (`offset`) are in the parent's time; a
 * connected clip's offset is in the clip it hangs from, measured from that clip's `start`.
 */
import type {
  Clip,
  ClipFrameleaf,
  InterchangeProject,
  Marker,
  MediaReference,
  Stack,
  Timeline,
  Track,
} from 'src/utils/studio-interchange/model.js';
import {
  InterchangeNotice,
  InterchangeReadError,
  Placed,
  PlacedTransition,
  fileNameOf,
  kindFromName,
  placeTracks,
  timeRange,
  versionNotice,
} from 'src/utils/studio-interchange/readers/common.js';
import { XmlNode, allText, child, children, descendants, parseXml } from 'src/utils/studio-interchange/xml.js';

/** FCPXML versions the reader was written against (Final Cut Pro 10.4 to 11). */
const TESTED_VERSIONS = ['1.8', '1.9', '1.10', '1.11', '1.12', '1.13'];
const CLIP_ELEMENTS = new Set([
  'asset-clip',
  'clip',
  'ref-clip',
  'mc-clip',
  'sync-clip',
  'title',
  'video',
  'audio',
  'gap',
  'audition',
  'spine',
]);

/** Seconds from an FCPXML time ("1001/30000s", "10s"); 0 when absent or unreadable. */
export const fcpxmlSeconds = (value: string | undefined): number => {
  const match = value?.trim().match(/^(-?\d+(?:\.\d+)?)(?:\/(\d+(?:\.\d+)?))?s?$/);
  if (!match) {
    return 0;
  }
  const denominator = match[2] ? Number(match[2]) : 1;
  return denominator > 0 ? Number(match[1]) / denominator : 0;
};

/** A frame duration ("1001/30000s") as an exact rate. */
const rateOf = (frameDuration: string | undefined): { num: number; den: number } | null => {
  const match = frameDuration?.trim().match(/^(\d+)\/(\d+)s$/) ?? frameDuration?.trim().match(/^(\d+)()s$/);
  if (!match) {
    return null;
  }
  const den = Number(match[1]);
  const num = match[2] ? Number(match[2]) : 1;
  if (!(den > 0 && num > 0)) {
    return null;
  }
  const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
  const divisor = gcd(num, den);
  return { num: num / divisor, den: den / divisor };
};

/** "1 0.5 0 1" (red, green, blue, alpha from 0 to 1) to "#ff8000". */
const hexColour = (value: string | undefined) => {
  const parts = value?.trim().split(/\s+/).map(Number);
  if (!parts || parts.length < 3 || parts.some((part) => !Number.isFinite(part))) {
    return;
  }
  return `#${parts
    .slice(0, 3)
    .map((part) =>
      Math.round(Math.max(0, Math.min(1, part)) * 255)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`;
};

type Bucket = { kind: Track['kind']; name: string; order: number; placed: Placed[]; transitions: PlacedTransition[] };
type Context = {
  resources: Map<string, XmlNode>;
  rate: number;
  canvasHeight: number;
  buckets: Map<string, Bucket>;
  disabled: { count: number };
  /** Inside a multicam angle: keep only the picture or only the sound. */
  only?: 'video' | 'audio';
  /** How many compound or multicam clips this one sits inside. */
  depth: number;
  /** Elements read in the whole file: a compound clip is read again each time it is used. */
  read: { count: number };
};

const MAX_NESTING = 32;
const MAX_ELEMENTS_READ = 1_000_000;

const bucket = (context: Context, kind: Track['kind'], lane: number, role: string | undefined) => {
  const key = kind === 'video' ? `v:${lane}` : `a:${role ?? lane}`;
  let found = context.buckets.get(key);
  if (!found) {
    const name =
      kind === 'video'
        ? `V${lane >= 0 ? lane + 1 : lane}`
        : role
          ? role[0].toUpperCase() + role.slice(1)
          : `A${Math.abs(lane) + 1}`;
    found = { kind, name, order: lane, placed: [], transitions: [] };
    context.buckets.set(key, found);
  }
  return found;
};

const roleOf = (node: XmlNode) => node.attributes.audioRole?.split('.', 1)[0]?.trim().toLowerCase() || undefined;

const formatOf = (context: Context, id: string | undefined) => (id ? context.resources.get(id) : undefined);

/** The asset's file, as the key the media matcher answers for. */
const mediaReferenceOf = (context: Context, asset: XmlNode | undefined, fallback: string): MediaReference => {
  if (!asset || asset.name !== 'asset') {
    return { kind: 'missing', name: fallback };
  }
  const src = child(asset, 'media-rep')?.attributes.src ?? asset.attributes.src;
  const name = asset.attributes.name || (src ? fileNameOf(src) : fallback);
  if (!src) {
    return { kind: 'missing', name };
  }
  const format = formatOf(context, asset.attributes.format);
  const hasVideo = asset.attributes.hasVideo === '1';
  const duration = fcpxmlSeconds(asset.attributes.duration);
  const kind = kindFromName(src) ?? (hasVideo ? (duration > 0 ? 'video' : 'image') : 'audio');
  const width = Number(format?.attributes.width) || undefined;
  const height = Number(format?.attributes.height) || undefined;
  return {
    kind: 'external',
    key: src,
    name: fileNameOf(src),
    ...(duration > 0 && { availableRange: timeRange(0, duration, context.rate) }),
    facts: { kind, ...(width && { width }), ...(height && { height }), hasAudio: asset.attributes.hasAudio === '1' },
  };
};

const markersOf = (node: XmlNode, mediaStart: number, rate: number): Marker[] =>
  node.children
    .filter((item) => item.name === 'marker' || item.name === 'chapter-marker')
    .map((item) => {
      const note = item.attributes.note?.trim();
      return {
        name: item.attributes.value?.trim() || (item.name === 'chapter-marker' ? 'Chapter' : 'Marker'),
        markedRange: timeRange(
          fcpxmlSeconds(item.attributes.start) - mediaStart,
          fcpxmlSeconds(item.attributes.duration),
          rate,
        ),
        color: item.name === 'chapter-marker' ? 'ORANGE' : item.attributes.completed === '0' ? 'RED' : 'BLUE',
        ...(note && { note }),
      };
    });

const PLUGIN_UID = /^(?:[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}|com\.|net\.|org\.)/i;

/** Picture move, opacity, level, fades and effects of a clip. */
const adjustmentsOf = (context: Context, node: XmlNode): ClipFrameleaf => {
  const frameleaf: ClipFrameleaf = {};
  const transform = child(node, 'adjust-transform');
  if (transform) {
    const [x = 0, y = 0] = (transform.attributes.position ?? '0 0').split(/\s+/).map(Number);
    const [sx = 1, sy = sx] = (transform.attributes.scale ?? '1 1').split(/\s+/).map(Number);
    const rotation = Number(transform.attributes.rotation ?? 0);
    // Final Cut measures position in percent of the frame's height, up positive; rotation anticlockwise.
    frameleaf.transform = {
      x: Math.round(((x || 0) / 100) * context.canvasHeight * 100) / 100,
      y: Math.round((-(y || 0) / 100) * context.canvasHeight * 100) / 100,
      scale: (Math.abs(sx) + Math.abs(sy)) / 2 || 1,
      rotation: -(rotation || 0),
    };
  }
  const blend = child(node, 'adjust-blend');
  if (blend?.attributes.amount !== undefined) {
    frameleaf.transform = { ...frameleaf.transform, opacity: Number(blend.attributes.amount) };
  }
  const volume = child(node, 'adjust-volume');
  if (volume) {
    const amount = Number((volume.attributes.amount ?? '0').replace(/db$/i, ''));
    if (Number.isFinite(amount) && amount !== 0) {
      frameleaf.volumeDb = amount;
    }
    const fadeIn = descendants(volume, 'fadeIn')[0];
    const fadeOut = descendants(volume, 'fadeOut')[0];
    if (fadeIn) {
      frameleaf.fadeInSeconds = fcpxmlSeconds(fadeIn.attributes.duration);
    }
    if (fadeOut) {
      frameleaf.fadeOutSeconds = fcpxmlSeconds(fadeOut.attributes.duration);
    }
  }
  if (node.attributes.muted === '1' || node.attributes.audioEnabled === '0') {
    frameleaf.muted = true;
  }
  const effects = [...children(node, 'filter-video'), ...children(node, 'filter-audio')]
    .filter((filter) => filter.attributes.enabled !== '0')
    .map((filter) => {
      const resource = formatOf(context, filter.attributes.ref);
      const uid = resource?.attributes.uid ?? '';
      return {
        name: filter.attributes.name || resource?.attributes.name || 'An effect',
        ...(PLUGIN_UID.test(uid) && { fromPlugin: true }),
      };
    });
  if (effects.length > 0) {
    frameleaf.effects = effects;
  }
  return frameleaf;
};

/** Steady speed from a time map, the media time at the clip's start, and whether the speed changes. */
const retimeOf = (node: XmlNode, localStart: number) => {
  const points = children(child(node, 'timeMap'), 'timept').map((point) => ({
    time: fcpxmlSeconds(point.attributes.time),
    value: fcpxmlSeconds(point.attributes.value),
  }));
  if (points.length < 2) {
    return null;
  }
  const slopes = points.slice(1).map((point, index) => {
    const before = points[index];
    return point.time > before.time ? (point.value - before.value) / (point.time - before.time) : 1;
  });
  const first = points[0];
  const last = points.at(-1)!;
  const speed = last.time > first.time ? (last.value - first.value) / (last.time - first.time) : 1;
  const segment = Math.max(
    0,
    points.findIndex((point, index) => index > 0 && point.time >= localStart),
  );
  const before = points[Math.max(0, segment - 1)];
  const mediaStart = before.value + (localStart - before.time) * (slopes[Math.max(0, segment - 1)] ?? speed);
  const ramp = slopes.some((slope) => Math.abs(slope - slopes[0]) > 1e-3);
  return { speed: Math.round(speed * 1000) / 1000, mediaStart, ramp };
};

/** The title's words and the look of its first run of text. */
const titleOf = (context: Context, node: XmlNode): ClipFrameleaf['title'] => {
  const text = children(node, 'text')
    .map((item) => allText(item))
    .join('\n')
    .trim();
  const style = descendants(node, 'text-style').find((item) => item.attributes.font || item.attributes.fontSize);
  const size = Number(style?.attributes.fontSize);
  const align = style?.attributes.alignment;
  return {
    text: text || node.attributes.name || 'Title',
    ...(style?.attributes.font && { font: style.attributes.font }),
    ...(size > 0 && { size: Math.round((size * context.canvasHeight) / 1080) }),
    ...(hexColour(style?.attributes.fontColor) && { color: hexColour(style?.attributes.fontColor) }),
    ...(align && ['left', 'center', 'right'].includes(align) && { align: align as 'left' | 'center' | 'right' }),
  };
};

const withoutEmpty = (frameleaf: ClipFrameleaf) => (Object.keys(frameleaf).length > 0 ? { frameleaf } : {});

/** A clip whose media is an asset, from an asset-clip, a clip's inner video or audio, or a bare audio/video. */
const assetClip = (
  context: Context,
  node: XmlNode,
  media: XmlNode,
  window: { start: number; duration: number },
): { item: Clip; kind: Track['kind'] } | null => {
  const asset = context.resources.get(media.attributes.ref ?? '');
  if (asset?.name === 'effect') {
    return {
      kind: 'video',
      item: {
        type: 'clip',
        name: node.attributes.name || asset.attributes.name || 'Generator',
        sourceRange: timeRange(0, window.duration, context.rate),
        mediaReference: { kind: 'generator', generator: 'other', name: asset.attributes.name || 'Generator' },
      },
    };
  }
  const assetStart = fcpxmlSeconds(asset?.attributes.start);
  const reference = mediaReferenceOf(context, asset, node.attributes.name || 'Clip');
  const assetRate = rateOf(formatOf(context, asset?.attributes.format)?.attributes.frameDuration);
  const rate = assetRate ? assetRate.num / assetRate.den : context.rate;
  const frameleaf = adjustmentsOf(context, node);
  let mediaStart = window.start;
  const retime = retimeOf(node, window.start);
  if (retime) {
    mediaStart = retime.mediaStart;
    if (retime.speed !== 1) {
      frameleaf.speed = retime.speed;
    }
    if (retime.ramp) {
      frameleaf.speedRamp = true;
    }
  }
  const soundOnly =
    context.only === 'audio' ||
    media.name === 'audio' ||
    (asset?.name === 'asset' && asset.attributes.hasVideo !== '1');
  if (context.only === 'video') {
    frameleaf.muted = true;
  }
  const markers = markersOf(node, assetStart, rate);
  return {
    kind: soundOnly ? 'audio' : 'video',
    item: {
      type: 'clip',
      name: node.attributes.name || (reference.kind === 'external' ? reference.name : reference.name),
      sourceRange: timeRange(mediaStart - assetStart, window.duration, rate),
      mediaReference: reference,
      ...(markers.length > 0 && { markers }),
      ...withoutEmpty(frameleaf),
    },
  };
};

/** A sequence inside a compound clip or one angle of a multicam, as tracks. */
const nestedTracks = (context: Context, items: XmlNode[], origin: number, only?: 'video' | 'audio'): Track[] => {
  if (context.depth >= MAX_NESTING) {
    throw new InterchangeReadError('too-complex', 'The project nests compound clips too deeply to read');
  }
  const inner: Context = { ...context, buckets: new Map(), only: only ?? context.only, depth: context.depth + 1 };
  readContainer(inner, items, (time) => time - origin, 0);
  return tracksOf(inner);
};

/** One element of a storyline at `lane`; `toTimeline` turns the parent's times into the timeline's. */
const readItem = (context: Context, original: XmlNode, toTimeline: (time: number) => number, lane: number) => {
  if (++context.read.count > MAX_ELEMENTS_READ) {
    throw new InterchangeReadError('too-complex', 'The project nests too many clips to read');
  }
  let node = original;
  if (node.name === 'audition') {
    const picked = node.children.find((item) => CLIP_ELEMENTS.has(item.name));
    if (!picked) {
      return;
    }
    node = {
      ...picked,
      attributes: { ...picked.attributes, offset: picked.attributes.offset ?? original.attributes.offset },
    };
  }
  if (node.name === 'spine') {
    readContainer(context, node.children, toTimeline, lane + Number(node.attributes.lane ?? 0));
    return;
  }
  if (node.attributes.enabled === '0') {
    context.disabled.count++;
    return;
  }
  const offset = fcpxmlSeconds(node.attributes.offset);
  const start = fcpxmlSeconds(node.attributes.start);
  const duration = fcpxmlSeconds(node.attributes.duration);
  const timelineStart = toTimeline(offset);
  const window = { start, duration };
  let placed: { item: Clip | Stack; kind: Track['kind'] } | null = null;

  switch (node.name) {
    case 'asset-clip':
    case 'audio':
    case 'video': {
      placed = assetClip(context, node, node, window);
      break;
    }
    case 'clip': {
      const media = child(node, 'video') ?? child(node, 'audio');
      if (media) {
        // The inner media's own offset is in the clip's time; its start is in the media's.
        const mediaWindow = {
          start: fcpxmlSeconds(media.attributes.start) + start - fcpxmlSeconds(media.attributes.offset),
          duration,
        };
        placed = assetClip(context, { ...node, children: [...media.children, ...node.children] }, media, mediaWindow);
      }
      break;
    }
    case 'title': {
      const effect = context.resources.get(node.attributes.ref ?? '');
      const frameleaf: ClipFrameleaf = { title: titleOf(context, node), ...adjustmentsOf(context, node) };
      placed = {
        kind: 'video',
        item: {
          type: 'clip',
          name: node.attributes.name || effect?.attributes.name || 'Title',
          sourceRange: timeRange(0, duration, context.rate),
          mediaReference: { kind: 'generator', generator: 'title', name: effect?.attributes.name || 'Title' },
          frameleaf,
        },
      };
      break;
    }
    case 'ref-clip': {
      const media = context.resources.get(node.attributes.ref ?? '');
      const sequence = child(media, 'sequence');
      if (sequence) {
        const origin = fcpxmlSeconds(sequence.attributes.tcStart);
        placed = {
          kind: 'video',
          item: {
            type: 'stack',
            name: node.attributes.name || media?.attributes.name || 'Compound clip',
            tracks: nestedTracks(context, child(sequence, 'spine')?.children ?? [], origin),
            sourceRange: timeRange(start - origin, duration, context.rate),
          },
        };
      }
      break;
    }
    case 'mc-clip': {
      const multicam = child(context.resources.get(node.attributes.ref ?? ''), 'multicam');
      if (multicam) {
        const origin = fcpxmlSeconds(multicam.attributes.tcStart);
        const angles = children(multicam, 'mc-angle');
        const sources = children(node, 'mc-source');
        const angleFor = (wanted: 'video' | 'audio') => {
          const source = sources.find((item) => ['all', wanted].includes(item.attributes.srcEnable ?? 'all'));
          return angles.find((angle) => angle.attributes.angleID === source?.attributes.angleID) ?? angles[0];
        };
        const video = angleFor('video');
        const audio = angleFor('audio');
        const tracks =
          video === audio
            ? nestedTracks(context, video?.children ?? [], origin)
            : [
                ...nestedTracks(context, video?.children ?? [], origin, 'video'),
                ...nestedTracks(context, audio?.children ?? [], origin, 'audio'),
              ];
        placed = {
          kind: 'video',
          item: {
            type: 'stack',
            name: node.attributes.name || 'Multicam clip',
            tracks,
            sourceRange: timeRange(start - origin, duration, context.rate),
          },
        };
      }
      break;
    }
    case 'sync-clip': {
      placed = {
        kind: 'video',
        item: {
          type: 'stack',
          name: node.attributes.name || 'Synchronized clip',
          tracks: nestedTracks(
            context,
            node.children.filter((item) => CLIP_ELEMENTS.has(item.name)),
            0,
          ),
          sourceRange: timeRange(start, duration, context.rate),
        },
      };
      break;
    }
    // A gap places nothing; its connected clips still come over.
  }

  if (placed && duration > 0) {
    bucket(context, placed.kind, lane, placed.kind === 'audio' ? roleOf(node) : undefined).placed.push({
      start: timelineStart,
      duration,
      item: placed.item,
    });
  }

  // Connected clips and secondary storylines hang from this one, in its time.
  if (node.name !== 'sync-clip') {
    const local = (time: number) => timelineStart + (time - start);
    for (const item of node.children) {
      if (CLIP_ELEMENTS.has(item.name) && item.attributes.lane !== undefined) {
        readItem(context, item, local, lane + Number(item.attributes.lane));
      }
    }
  }
};

/** A storyline's elements: clips and the transitions between them. */
const readContainer = (
  context: Context,
  items: readonly XmlNode[],
  toTimeline: (time: number) => number,
  lane: number,
) => {
  for (const item of items) {
    if (item.name === 'transition') {
      const filter = child(item, 'filter-video');
      bucket(context, 'video', lane, undefined).transitions.push({
        name: item.attributes.name || filter?.attributes.name || 'Cross Dissolve',
        start: toTimeline(fcpxmlSeconds(item.attributes.offset)),
        duration: fcpxmlSeconds(item.attributes.duration),
      });
    } else if (CLIP_ELEMENTS.has(item.name) && (item.attributes.lane === undefined || item.name === 'spine')) {
      readItem(context, item, toTimeline, lane);
    } else if (CLIP_ELEMENTS.has(item.name)) {
      readItem(context, item, toTimeline, lane + Number(item.attributes.lane));
    }
  }
};

/** Bottom video track first, then the sound tracks, as OpenTimelineIO lists them. */
const tracksOf = (context: Context): Track[] => {
  const all = context.buckets.values().toArray();
  const video = all.filter((item) => item.kind === 'video').toSorted((a, b) => a.order - b.order);
  const audio = all.filter((item) => item.kind === 'audio').toSorted((a, b) => b.order - a.order);
  return [...video, ...audio].flatMap((item) =>
    item.placed.length > 0 ? placeTracks(item.kind, item.name, item.placed, item.transitions, context.rate) : [],
  );
};

export const readFcpxml = (bytes: Buffer | string): InterchangeProject => {
  const root = parseXml(bytes);
  if (root.name !== 'fcpxml') {
    throw new InterchangeReadError('unsupported', 'This is not a Final Cut Pro XML file');
  }
  const resources = new Map<string, XmlNode>();
  for (const item of child(root, 'resources')?.children ?? []) {
    if (item.attributes.id) {
      resources.set(item.attributes.id, item);
    }
  }
  const projects = descendants(root, 'project');
  if (projects.length === 0) {
    throw new InterchangeReadError('empty', 'This Final Cut Pro XML file has no project in it');
  }
  const disabled = { count: 0 };
  const read = { count: 0 };
  const timelines: Timeline[] = [];
  for (const project of projects) {
    const sequence = child(project, 'sequence');
    if (!sequence) {
      continue;
    }
    const format = resources.get(sequence.attributes.format ?? '');
    const rate = rateOf(format?.attributes.frameDuration) ?? { num: 30, den: 1 };
    const canvas = {
      width: Number(format?.attributes.width) || 1920,
      height: Number(format?.attributes.height) || 1080,
    };
    const context: Context = {
      resources,
      rate: rate.num / rate.den,
      canvasHeight: canvas.height,
      buckets: new Map(),
      disabled,
      depth: 0,
      read,
    };
    const origin = fcpxmlSeconds(sequence.attributes.tcStart);
    readContainer(context, child(sequence, 'spine')?.children ?? [], (time) => time - origin, 0);
    timelines.push({
      name: project.attributes.name?.trim() || 'Final Cut Pro project',
      rate,
      canvas,
      tracks: tracksOf(context),
    });
  }
  if (timelines.length === 0) {
    throw new InterchangeReadError('empty', 'This Final Cut Pro XML file has no project in it');
  }
  const notices: InterchangeNotice[] = versionNotice('Final Cut Pro XML', root.attributes.version, TESTED_VERSIONS);
  if (disabled.count > 0) {
    notices.push({
      code: 'clips-disabled',
      subject: String(disabled.count),
      what:
        disabled.count === 1
          ? 'A clip switched off in Final Cut Pro'
          : `${disabled.count} clips switched off in Final Cut Pro`,
      became: 'Left out',
    });
  }
  return {
    source: 'finalcut',
    ...(root.attributes.version && { sourceVersion: root.attributes.version }),
    timelines,
    ...(notices.length > 0 && { notices }),
  };
};
