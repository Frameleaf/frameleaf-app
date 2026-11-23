/**
 * A Premiere Pro project (`.prproj`) to the neutral model (FL-1550). The file is gzip-compressed XML:
 * a flat list of objects under `PremiereData`, each with an `ObjectID` (referred to by `ObjectRef`)
 * or an `ObjectUID` (referred to by `ObjectURef`). Times are ticks, 254,016,000,000 a second, and a
 * value Premiere leaves at its default (a `Start` or `InPoint` of 0) is simply absent.
 *
 * Every sequence in the project is offered as a timeline. The path from a sequence to a file:
 * Sequence › TrackGroup › VideoTrackGroup › VideoClipTrack › VideoClipTrackItem (timeline Start, End)
 * › SubClip › VideoClip (media InPoint, OutPoint) › VideoMediaSource › Media (the file). A clip whose
 * source is a sequence is a nest.
 */
import { gunzipSync } from 'node:zlib';
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
import { exactRate } from 'src/utils/studio-interchange/readers/otio.js';
import { XmlNode, child, childText, children, parseXml } from 'src/utils/studio-interchange/xml.js';

export const PREMIERE_TICKS = 254_016_000_000;
/** Project versions of the files the reader was written against (Premiere Pro 2019 to 2026). */
const TESTED_VERSIONS = ['36', '37', '38', '39', '40', '41', '42', '43', '44', '45'];
/** A project decompresses to far more than its file; past this it is refused, not read. */
const MAX_XML_BYTES = 512 * 1024 * 1024;
const VIDEO = '228cda18-3625-4d2d-951e-348879e4ed93';
const AUDIO = '80b8e3d5-6dca-4195-aefb-cb5f407ab009';
/** Premiere's own generated media: colour mattes, bars and tone, black video, counting leaders. */
const SYNTHETIC_IMPORTER = '42008e7a-de6f-4270-96de-7e287abb9b4b';
/** Components every clip has; anything else is an effect the person added. */
const INTRINSIC = /^(?:AE\.)?ADBE (?:Motion|Opacity|Time Remapping)$|^Internal (?:Channel )?Volume/;

/** Clips read across every sequence. A sequence nested many times over is read each time, so this is counted. */
const MAX_CLIPS = 1_000_000;

type Graph = { byId: Map<string, XmlNode>; byUid: Map<string, XmlNode>; depth: number; clips: { count: number } };

const ticks = (value: string | undefined) => {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number : 0;
};
const seconds = (value: string | undefined) => ticks(value) / PREMIERE_TICKS;

/** The object a reference names, by `ObjectRef` or `ObjectURef`. */
const resolve = (graph: Graph, reference: XmlNode | undefined) => {
  if (!reference) {
    return;
  }
  const { ObjectRef: id, ObjectURef: uid } = reference.attributes;
  return id ? graph.byId.get(id) : uid ? graph.byUid.get(uid) : undefined;
};

/** A descendant by path of names. */
const at = (node: XmlNode | undefined, ...path: string[]) => {
  let current = node;
  for (const name of path) {
    current = child(current, name);
  }
  return current;
};

/** The first text below a node under any of these names, at any depth. */
const deepText = (node: XmlNode | undefined, names: readonly string[]): string | undefined => {
  if (!node) {
    return undefined;
  }
  for (const item of node.children) {
    if (names.includes(item.name) && item.text.trim()) {
      return item.text.trim();
    }
    const found = deepText(item, names);
    if (found) {
      return found;
    }
  }
  return undefined;
};

const markersOf = (graph: Graph, owner: XmlNode | undefined): Marker[] => {
  const list = resolve(graph, at(owner, 'MarkerOwner', 'Markers'));
  return children(child(list, 'Markers'), 'Marker').flatMap((entry) => {
    const marker = resolve(graph, child(entry, 'Second'));
    let parsed: {
      mName?: string;
      mComment?: string;
      mType?: string;
      mStartTime?: { ticks?: string | number };
      mDuration?: { ticks?: string | number };
    };
    try {
      parsed = JSON.parse(childText(marker, 'DVAMarker') ?? '{}').DVAMarker ?? {};
    } catch {
      return [];
    }
    const start = Number(parsed.mStartTime?.ticks ?? 0) / PREMIERE_TICKS;
    const duration = Number(parsed.mDuration?.ticks ?? 0) / PREMIERE_TICKS;
    const note = parsed.mComment?.trim();
    return [
      {
        name: parsed.mName?.trim() || parsed.mType || 'Marker',
        markedRange: timeRange(Number.isFinite(start) ? start : 0, Number.isFinite(duration) ? duration : 0, 1000),
        color: parsed.mType === 'Chapter' ? 'ORANGE' : parsed.mType === 'Segmentation' ? 'PURPLE' : 'GREEN',
        ...(note && { note }),
      },
    ];
  });
};

/** The components of a clip's chain: effects, motion, opacity, volume. */
const componentsOf = (graph: Graph, item: XmlNode) => {
  const chain = resolve(graph, at(item, 'ClipTrackItem', 'ComponentOwner', 'Components'));
  return children(at(chain, 'ComponentChain', 'Components'), 'Component').flatMap((reference) => {
    const component = resolve(graph, reference);
    if (!component) {
      return [];
    }
    const params = new Map<string, XmlNode>();
    for (const entry of children(
      at(component, ...(component.name.startsWith('Audio') ? ['AudioComponent', 'Component'] : ['Component'])),
      'Params',
    ).flatMap((list) => children(list, 'Param'))) {
      const param = resolve(graph, entry);
      const name = childText(param, 'Name');
      if (param && name) {
        params.set(name, param);
      }
    }
    // Some versions keep the params one level down.
    if (params.size === 0) {
      for (const list of [component, ...component.children]) {
        for (const entry of children(child(list, 'Params'), 'Param')) {
          const param = resolve(graph, entry);
          const name = childText(param, 'Name');
          if (param && name) {
            params.set(name, param);
          }
        }
      }
    }
    return [
      {
        match: deepText(component, ['FilterMatchName', 'MatchName']) ?? '',
        name:
          deepText(component, ['DisplayName']) ?? deepText(component, ['FilterMatchName', 'MatchName']) ?? 'An effect',
        params,
      },
    ];
  });
};

const valueOf = (param: XmlNode | undefined) => {
  const raw = childText(param, 'CurrentValue') ?? childText(param, 'StartKeyframe')?.split(',', 2)[1];
  return raw;
};
const animated = (param: XmlNode | undefined) =>
  (childText(param, 'Keyframes') ?? '').split(';').filter(Boolean).length > 1;

const frameleafOf = (graph: Graph, item: XmlNode, canvas: { width: number; height: number }, sound: boolean) => {
  const frameleaf: ClipFrameleaf = {};
  const effects: NonNullable<ClipFrameleaf['effects']> = [];
  for (const component of componentsOf(graph, item)) {
    if (/Volume/.test(component.match)) {
      const level = component.params.get('Level');
      const value = Number(valueOf(level));
      // Premiere's level is linear, with 1 at +15 dB: 0.1778 is 0 dB.
      if (Number.isFinite(value) && value > 0) {
        const decibels = Math.round((20 * Math.log10(value) + 15) * 100) / 100;
        if (Math.abs(decibels) > 0.01) {
          frameleaf.volumeDb = decibels;
        }
      }
      if (animated(level)) {
        effects.push({ name: 'Volume keyframes' });
      }
      if (childText(component.params.get('Mute') ?? component.params.get('Bypass'), 'CurrentValue') === 'true') {
        frameleaf.muted = true;
      }
    } else if (component.match.endsWith('ADBE Motion')) {
      const scale = Number(valueOf(component.params.get('Scale')));
      const rotation = Number(valueOf(component.params.get('Rotation')));
      const [x, y] = (valueOf(component.params.get('Position')) ?? '').split(':').map(Number);
      frameleaf.transform = {
        ...frameleaf.transform,
        ...(Number.isFinite(scale) && scale !== 100 && { scale: scale / 100 }),
        ...(Number.isFinite(rotation) && rotation !== 0 && { rotation }),
        // Position is a fraction of the frame from its top left; Studio measures from the centre.
        ...(Number.isFinite(x) &&
          Number.isFinite(y) && { x: Math.round((x - 0.5) * canvas.width), y: Math.round((y - 0.5) * canvas.height) }),
      };
    } else if (component.match.endsWith('ADBE Opacity')) {
      const opacity = Number(valueOf(component.params.get('Opacity')));
      if (Number.isFinite(opacity) && opacity < 100) {
        frameleaf.transform = { ...frameleaf.transform, opacity: opacity / 100 };
      }
    } else if (!INTRINSIC.test(component.match) && !(sound && /Panner|Balance/.test(component.match))) {
      effects.push({
        name: component.name,
        ...(!/^(?:AE\.)?ADBE /.test(component.match) && component.match && { fromPlugin: true }),
      });
    }
  }
  if (effects.length > 0) {
    frameleaf.effects = effects;
  }
  return frameleaf;
};

type Context = { graph: Graph; canvas: { width: number; height: number }; fps: number; disabled: { count: number } };

const mediaOf = (graph: Graph, media: XmlNode | undefined, fallback: string): MediaReference => {
  if (!media) {
    return { kind: 'missing', name: fallback };
  }
  const title = childText(media, 'Title') ?? fallback;
  if (childText(media, 'ImplementationID') === SYNTHETIC_IMPORTER) {
    return { kind: 'generator', generator: /matte|black|transparent/i.test(title) ? 'solid' : 'other', name: title };
  }
  const path = childText(media, 'ActualMediaFilePath') ?? childText(media, 'FilePath');
  if (!path) {
    return { kind: 'missing', name: title };
  }
  const stream = resolve(graph, child(media, 'VideoStream'));
  const rect = childText(stream, 'FrameRect')?.split(',').map(Number);
  const still = childText(media, 'Infinite') === 'true' || childText(stream, 'IsStill') === 'true';
  const duration = seconds(
    childText(stream, 'Duration') ?? childText(resolve(graph, child(media, 'AudioStream')), 'Duration'),
  );
  const kind = kindFromName(path) ?? (still ? 'image' : stream ? 'video' : 'audio');
  return {
    kind: 'external',
    key: path,
    name: fileNameOf(path),
    ...(!still && duration > 0 && duration < 1e6 && { availableRange: timeRange(0, duration, 1000) }),
    facts: {
      kind,
      ...(rect && rect.length === 4 && rect[2] > 0 && { width: rect[2], height: rect[3] }),
      hasAudio: !!child(media, 'AudioStream'),
    },
  };
};

/** One clip on a track: media, a generated clip, or a nested sequence. */
const clipOf = (context: Context, item: XmlNode, sound: boolean): Placed | null => {
  const { graph } = context;
  if (++graph.clips.count > MAX_CLIPS) {
    throw new InterchangeReadError('too-complex', 'The project nests too many clips to read');
  }
  const position = at(item, 'ClipTrackItem', 'TrackItem');
  const start = seconds(childText(position, 'Start'));
  const end = seconds(childText(position, 'End'));
  if (!(end > start)) {
    return null;
  }
  if (childText(at(item, 'ClipTrackItem'), 'IsEnabled') === 'false' || childText(item, 'Disabled') === 'true') {
    context.disabled.count++;
    return null;
  }
  const sub = resolve(graph, at(item, 'ClipTrackItem', 'SubClip'));
  const clip = resolve(graph, child(sub, 'Clip'));
  const inner = child(clip, 'Clip');
  const name = childText(sub, 'Name') ?? 'Clip';
  const inPoint = seconds(childText(inner, 'InPoint'));
  const outPoint = seconds(childText(inner, 'OutPoint'));
  const source = resolve(graph, child(inner, 'Source'));
  const duration = end - start;

  const nested = graph.byUid.get(at(source, 'SequenceSource', 'Sequence')?.attributes.ObjectURef ?? '');
  if (nested) {
    if (graph.depth > 16) {
      throw new InterchangeReadError('too-complex', 'The project nests sequences too deeply to read');
    }
    const stack: Stack = {
      type: 'stack',
      name: childText(nested, 'Name') ?? name,
      tracks: sequenceTracks(
        { ...context, graph: { ...graph, depth: graph.depth + 1 } },
        nested,
        sound ? 'audio' : 'video',
      ),
      sourceRange: timeRange(inPoint, duration, context.fps),
    };
    return { start, duration, item: stack };
  }

  const reference = mediaOf(graph, resolve(graph, at(source, 'MediaSource', 'Media')), name);
  const frameleaf = frameleafOf(graph, item, context.canvas, sound);
  const still = reference.kind === 'external' && reference.facts?.kind === 'image';
  const span = outPoint - inPoint;
  if (!still && span > 0 && Math.abs(span / duration - 1) > 0.005) {
    frameleaf.speed = Math.round((span / duration) * 1000) / 1000;
  }
  const remap = resolve(graph, child(inner, 'TimeRemapping'));
  if (remap && /;/.test(deepText(remap, ['Keyframes']) ?? '')) {
    frameleaf.speedRamp = true;
  }
  const markers = markersOf(graph, inner);
  const result: Clip = {
    type: 'clip',
    name,
    sourceRange: timeRange(still ? 0 : inPoint, duration, context.fps),
    mediaReference: reference,
    ...(markers.length > 0 && { markers }),
    ...(Object.keys(frameleaf).length > 0 && { frameleaf }),
  };
  return { start, duration, item: result };
};

/** The tracks of a sequence, picture first then sound; `only` keeps one kind for a nest's sound or picture. */
const sequenceTracks = (context: Context, sequence: XmlNode, only?: Track['kind']): Track[] => {
  const tracks: Track[] = [];
  for (const group of children(child(sequence, 'TrackGroups'), 'TrackGroup')) {
    const type = childText(group, 'First');
    const kind = type === VIDEO ? 'video' : type === AUDIO ? 'audio' : null;
    if (!kind || (only && only !== kind)) {
      continue;
    }
    const container = resolve(context.graph, child(group, 'Second'));
    for (const [index, reference] of children(at(container, 'TrackGroup', 'Tracks'), 'Track').entries()) {
      const track = resolve(context.graph, reference);
      const clipTrack = child(track, 'ClipTrack');
      const placed = children(at(clipTrack, 'ClipItems', 'TrackItems'), 'TrackItem')
        .map((entry) => resolve(context.graph, entry))
        .filter((item): item is XmlNode => !!item)
        .map((item) => clipOf(context, item, kind === 'audio'))
        .filter((item): item is Placed => !!item);
      const transitions: PlacedTransition[] = children(at(clipTrack, 'TransitionItems', 'TrackItems'), 'TrackItem')
        .map((entry) => resolve(context.graph, entry))
        .filter((item): item is XmlNode => !!item)
        .map((item) => {
          const transition = child(item, 'TransitionTrackItem');
          const start = seconds(at(transition, 'TrackItem', 'Start')?.text);
          return {
            name: childText(transition, 'DisplayName') ?? childText(transition, 'MatchName') ?? 'Cross Dissolve',
            start,
            duration: seconds(at(transition, 'TrackItem', 'End')?.text) - start,
          };
        })
        .filter((item) => item.duration > 0);
      const label = `${kind === 'video' ? 'V' : 'A'}${index + 1}`;
      tracks.push(...(placed.length > 0 ? placeTracks(kind, label, placed, transitions, context.fps) : []));
    }
  }
  return tracks;
};

/** The gzip stream, inflated with a ceiling so a small file cannot expand without end. */
const inflate = (bytes: Buffer, maxBytes: number) => {
  if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) {
    return bytes;
  }
  try {
    return gunzipSync(bytes, { maxOutputLength: maxBytes });
  } catch (error) {
    throw (error as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE'
      ? new InterchangeReadError('too-large', 'The project is too large to read once uncompressed')
      : new InterchangeReadError('malformed', 'This Premiere Pro project could not be uncompressed');
  }
};

export const readPrproj = (bytes: Buffer, maxXmlBytes = MAX_XML_BYTES): InterchangeProject => {
  const root = parseXml(inflate(bytes, maxXmlBytes), { maxBytes: maxXmlBytes, maxDepth: 256, maxElements: 8_000_000 });
  if (root.name !== 'PremiereData') {
    throw new InterchangeReadError('unsupported', 'This is not a Premiere Pro project');
  }
  const graph: Graph = { byId: new Map(), byUid: new Map(), depth: 0, clips: { count: 0 } };
  for (const node of root.children) {
    if (node.attributes.ObjectID) {
      graph.byId.set(node.attributes.ObjectID, node);
    }
    if (node.attributes.ObjectUID) {
      graph.byUid.set(node.attributes.ObjectUID, node);
    }
  }
  const project = root.children.find((node) => node.name === 'Project' && node.attributes.ObjectID);
  const disabled = { count: 0 };
  const timelines: Timeline[] = root.children
    .filter((node) => node.name === 'Sequence')
    .map((sequence) => {
      const groups = children(child(sequence, 'TrackGroups'), 'TrackGroup');
      const video = resolve(
        graph,
        child(
          groups.find((group) => childText(group, 'First') === VIDEO),
          'Second',
        ),
      );
      const frameTicks = ticks(childText(at(video, 'TrackGroup'), 'FrameRate'));
      const rate =
        frameTicks > 0 ? exactRate(Math.round((PREMIERE_TICKS / frameTicks) * 1000) / 1000) : { num: 30, den: 1 };
      const rect = childText(video, 'FrameRect')?.split(',').map(Number);
      const canvas =
        rect && rect.length === 4 && rect[2] > 0 && rect[3] > 0
          ? { width: rect[2], height: rect[3] }
          : { width: 1920, height: 1080 };
      const context: Context = { graph, canvas, fps: rate.num / rate.den, disabled };
      const markers = markersOf(graph, sequence);
      return {
        name: childText(sequence, 'Name') ?? 'Sequence',
        rate,
        canvas,
        tracks: sequenceTracks(context, sequence),
        ...(markers.length > 0 && { markers }),
      };
    });
  if (timelines.length === 0) {
    throw new InterchangeReadError('empty', 'This Premiere Pro project has no sequence in it');
  }
  const version = project?.attributes.Version;
  const notices: InterchangeNotice[] = versionNotice('Premiere Pro project', version, TESTED_VERSIONS);
  if (disabled.count > 0) {
    notices.push({
      code: 'clips-disabled',
      subject: String(disabled.count),
      what: `${disabled.count} ${disabled.count === 1 ? 'clip' : 'clips'} switched off in Premiere Pro`,
      became: 'Left out',
    });
  }
  return {
    source: 'premiere',
    ...(version && { sourceVersion: version }),
    timelines,
    ...(notices.length > 0 && { notices }),
  };
};
