/**
 * Final Cut Pro 7 XML (`xmeml`) to the neutral model (FL-1546). Premiere Pro and DaVinci Resolve both
 * export it, so it opens all of their projects by export. Times are frames at the sequence's
 * `timebase` (with `ntsc`, at timebase × 1000/1001). A clip that starts or ends inside a transition
 * says `-1` and takes its edge from the transition.
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
import { XmlNode, child, childText, children, descendants, parseXml } from 'src/utils/studio-interchange/xml.js';

const TESTED_VERSIONS = ['4', '5'];

type Rate = { num: number; den: number };
const rateOf = (node: XmlNode | undefined): Rate | null => {
  const timebase = Number(childText(child(node, 'rate'), 'timebase'));
  if (!(timebase > 0)) {
    return null;
  }
  return childText(child(node, 'rate'), 'ntsc')?.toUpperCase() === 'TRUE'
    ? { num: timebase * 1000, den: 1001 }
    : { num: timebase, den: 1 };
};

type Context = { files: Map<string, XmlNode>; fps: number; canvasHeight: number; canvasWidth: number };

const numberOf = (node: XmlNode | undefined, name: string) => {
  const value = Number(childText(node, name));
  return Number.isFinite(value) ? value : undefined;
};

/** A filter's parameter value by id, from the first effect whose id or name matches. */
const parameter = (clip: XmlNode, effect: string, id: string) => {
  for (const filter of children(clip, 'filter')) {
    const node = child(filter, 'effect');
    const name = (childText(node, 'effectid') ?? childText(node, 'name') ?? '').toLowerCase();
    if (name !== effect) {
      continue;
    }
    const found = children(node, 'parameter').find(
      (item) => (childText(item, 'parameterid') ?? childText(item, 'name') ?? '').toLowerCase() === id,
    );
    if (found) {
      return found;
    }
  }
  return;
};

const BUILT_IN = new Set([
  'basic',
  'basicmotion',
  'opacity',
  'audiolevels',
  'timeremap',
  'crop',
  'cropping',
  'motion',
  'audiopan',
  'pan',
]);

const adjustmentsOf = (context: Context, clip: XmlNode, sound: boolean): ClipFrameleaf => {
  const frameleaf: ClipFrameleaf = {};
  const scale = Number(childText(parameter(clip, 'basic', 'scale'), 'value'));
  const rotation = Number(childText(parameter(clip, 'basic', 'rotation'), 'value'));
  const center = child(parameter(clip, 'basic', 'center'), 'value');
  const opacity = Number(childText(parameter(clip, 'opacity', 'opacity'), 'value'));
  if (Number.isFinite(scale) || Number.isFinite(rotation) || center || Number.isFinite(opacity)) {
    // Centre is -1..1 of the frame's half width and height from the middle; scale is a percent.
    const horiz = Number(childText(center, 'horiz') ?? 0);
    const vert = Number(childText(center, 'vert') ?? 0);
    frameleaf.transform = {
      ...(Number.isFinite(scale) && { scale: scale / 100 }),
      ...(Number.isFinite(rotation) && { rotation }),
      ...(center && {
        x: Math.round(horiz * (context.canvasWidth / 2) * 100) / 100,
        y: Math.round(vert * (context.canvasHeight / 2) * 100) / 100,
      }),
      ...(Number.isFinite(opacity) && { opacity: opacity / 100 }),
    };
  }
  if (sound) {
    const level = Number(childText(parameter(clip, 'audiolevels', 'level'), 'value'));
    if (Number.isFinite(level) && level > 0 && level !== 1) {
      frameleaf.volumeDb = Math.round(20 * Math.log10(level) * 100) / 100;
    }
  }
  if (childText(clip, 'enabled')?.toUpperCase() === 'FALSE') {
    frameleaf.muted = true;
  }
  const speed = Number(childText(parameter(clip, 'timeremap', 'speed'), 'value'));
  const reverse = childText(parameter(clip, 'timeremap', 'reverse'), 'value')?.toUpperCase() === 'TRUE';
  if ((Number.isFinite(speed) && speed !== 100) || reverse) {
    frameleaf.speed = ((Number.isFinite(speed) ? speed : 100) / 100) * (reverse ? -1 : 1);
  }
  if (children(parameter(clip, 'timeremap', 'graphdict'), 'keyframe').length > 2) {
    frameleaf.speedRamp = true;
  }
  const effects = children(clip, 'filter')
    .map((filter) => child(filter, 'effect'))
    .filter((effect): effect is XmlNode => !!effect && childText(effect, 'enabled')?.toUpperCase() !== 'FALSE')
    .filter(
      (effect) =>
        !BUILT_IN.has(
          (childText(effect, 'effectid') ?? childText(effect, 'name') ?? '').toLowerCase().replaceAll(/\s/g, ''),
        ),
    )
    .map((effect) => ({ name: childText(effect, 'name') ?? childText(effect, 'effectid') ?? 'An effect' }));
  if (effects.length > 0) {
    frameleaf.effects = effects;
  }
  return frameleaf;
};

const markersOf = (node: XmlNode, offset: number, fps: number): Marker[] =>
  children(node, 'marker').map((marker) => {
    const start = numberOf(marker, 'in') ?? 0;
    const end = numberOf(marker, 'out') ?? -1;
    const note = childText(marker, 'comment');
    return {
      name: childText(marker, 'name') ?? 'Marker',
      markedRange: timeRange((start - offset) / fps, end > start ? (end - start) / fps : 0, fps),
      ...(note && { note }),
    };
  });

const mediaReferenceOf = (context: Context, file: XmlNode | undefined, fallback: string): MediaReference => {
  const full = file ? (context.files.get(file.attributes.id ?? '') ?? file) : undefined;
  const path = childText(full, 'pathurl');
  const name = childText(full, 'name') ?? (path ? fileNameOf(path) : fallback);
  if (!full || !path) {
    return { kind: 'missing', name };
  }
  const video = child(child(full, 'media'), 'video');
  const audio = child(child(full, 'media'), 'audio');
  const characteristics = child(video, 'samplecharacteristics');
  const width = numberOf(characteristics, 'width');
  const height = numberOf(characteristics, 'height');
  const rate = rateOf(full);
  const duration = numberOf(full, 'duration');
  const kind = kindFromName(path) ?? (video ? 'video' : audio ? 'audio' : undefined);
  return {
    kind: 'external',
    key: path,
    name: fileNameOf(path),
    ...(rate &&
      duration &&
      duration > 0 && { availableRange: timeRange(0, duration / (rate.num / rate.den), rate.num / rate.den) }),
    facts: { ...(kind && { kind }), ...(width && { width }), ...(height && { height }), hasAudio: !!audio },
  };
};

/**
 * A clip item's place on the timeline in frames. An edge inside a transition says `-1`; `in` and `out`
 * are the cut points in the media, so the other edge and the length give it back.
 */
const windowOf = (item: XmlNode) => {
  let start = numberOf(item, 'start') ?? -1;
  let end = numberOf(item, 'end') ?? -1;
  const length = (numberOf(item, 'out') ?? 0) - (numberOf(item, 'in') ?? 0);
  if (start < 0 && end >= 0) {
    start = end - length;
  }
  if (end < 0) {
    end = Math.max(0, start) + length;
  }
  return { start: Math.max(0, start), end };
};

const transitionEdit = (item: XmlNode, start: number, end: number) => {
  switch (childText(item, 'alignment')?.toLowerCase()) {
    case 'start':
    case 'start-black': {
      return start;
    }
    case 'end':
    case 'end-black': {
      return end;
    }
    default: {
      return (start + end) / 2;
    }
  }
};

const readTrack = (context: Context, track: XmlNode, kind: Track['kind'], name: string): Track[] => {
  const transitionNodes = children(track, 'transitionitem');
  const frames = transitionNodes.map((item) => {
    const start = numberOf(item, 'start') ?? 0;
    const end = numberOf(item, 'end') ?? start;
    return { start, end, edit: transitionEdit(item, start, end), item };
  });
  const placed: Placed[] = [];
  for (const item of track.children) {
    if (!['clipitem', 'generatoritem'].includes(item.name) || childText(item, 'enabled')?.toUpperCase() === 'FALSE') {
      continue;
    }
    const { start, end } = windowOf(item);
    if (end <= start) {
      continue;
    }
    const duration = (end - start) / context.fps;
    const clipName = childText(item, 'name') ?? 'Clip';
    let clip: Clip | Stack;
    const nested = child(item, 'sequence');
    if (item.name === 'generatoritem') {
      const effect = child(item, 'effect');
      const effectName = childText(effect, 'name') ?? clipName;
      const words = children(effect, 'parameter').find((parameter) =>
        ['str', 'text'].includes((childText(parameter, 'parameterid') ?? '').toLowerCase()),
      );
      const font = children(effect, 'parameter').find(
        (parameter) => (childText(parameter, 'parameterid') ?? '').toLowerCase() === 'font',
      );
      const size = Number(
        childText(
          children(effect, 'parameter').find(
            (parameter) => (childText(parameter, 'parameterid') ?? '').toLowerCase() === 'fontsize',
          ),
          'value',
        ),
      );
      clip = {
        type: 'clip',
        name: clipName,
        sourceRange: timeRange(0, duration, context.fps),
        mediaReference: words
          ? { kind: 'generator', generator: 'title', name: effectName }
          : { kind: 'generator', generator: 'other', name: effectName },
        ...(words && {
          frameleaf: {
            title: {
              text: childText(words, 'value') ?? clipName,
              ...(childText(font, 'value') && { font: childText(font, 'value') }),
              ...(size > 0 && { size: Math.round((size * context.canvasHeight) / 480) }),
            },
          },
        }),
      };
    } else if (nested) {
      const nestedRate = rateOf(nested);
      const nestedFps = nestedRate ? nestedRate.num / nestedRate.den : context.fps;
      clip = {
        type: 'stack',
        name: clipName,
        tracks: readSequenceTracks({ ...context, fps: nestedFps }, nested),
        sourceRange: timeRange((numberOf(item, 'in') ?? 0) / nestedFps, duration, context.fps),
      };
    } else {
      const reference = mediaReferenceOf(context, child(item, 'file'), clipName);
      const rate = rateOf(item);
      const sourceFps = rate ? rate.num / rate.den : context.fps;
      const frameleaf = adjustmentsOf(context, item, kind === 'audio');
      const markers = markersOf(item, 0, sourceFps);
      clip = {
        type: 'clip',
        name: clipName,
        sourceRange: timeRange((numberOf(item, 'in') ?? 0) / sourceFps, duration, sourceFps),
        mediaReference: reference,
        ...(markers.length > 0 && { markers }),
        ...(Object.keys(frameleaf).length > 0 && { frameleaf }),
      };
    }
    placed.push({ start: start / context.fps, duration, item: clip });
  }
  const transitions: PlacedTransition[] = frames.map(({ start, end, edit, item }) => ({
    name: childText(child(item, 'effect'), 'name') ?? 'Cross Dissolve',
    start: start / context.fps,
    duration: (end - start) / context.fps,
    edit: edit / context.fps,
  }));
  return placeTracks(kind, name, placed, transitions, context.fps);
};

const readSequenceTracks = (context: Context, sequence: XmlNode): Track[] => {
  const media = child(sequence, 'media');
  const video = children(child(media, 'video'), 'track').flatMap((track, index) =>
    readTrack(context, track, 'video', `V${index + 1}`),
  );
  const audio = children(child(media, 'audio'), 'track').flatMap((track, index) =>
    readTrack(context, track, 'audio', `A${index + 1}`),
  );
  return [...video, ...audio];
};

/** Sequences at the top of the file or in its bins, not those nested inside a clip. */
const topSequences = (node: XmlNode, into: XmlNode[] = []): XmlNode[] => {
  for (const item of node.children) {
    if (item.name === 'sequence') {
      into.push(item);
    } else if (item.name !== 'clipitem' && item.name !== 'clip') {
      topSequences(item, into);
    }
  }
  return into;
};

export const readFcp7Xml = (bytes: Buffer | string): InterchangeProject => {
  const root = parseXml(bytes);
  if (root.name !== 'xmeml') {
    throw new InterchangeReadError('unsupported', 'This is not a Final Cut Pro 7 XML file');
  }
  // A file is described once in full and referred to by id after that.
  const files = new Map<string, XmlNode>();
  for (const file of descendants(root, 'file')) {
    if (file.attributes.id && file.children.length > 0 && !files.has(file.attributes.id)) {
      files.set(file.attributes.id, file);
    }
  }
  const timelines: Timeline[] = [];
  for (const sequence of topSequences(root)) {
    const rate = rateOf(sequence) ?? { num: 30, den: 1 };
    const characteristics = child(child(child(child(sequence, 'media'), 'video'), 'format'), 'samplecharacteristics');
    const canvas = {
      width: numberOf(characteristics, 'width') || 1920,
      height: numberOf(characteristics, 'height') || 1080,
    };
    const context: Context = {
      files,
      fps: rate.num / rate.den,
      canvasWidth: canvas.width,
      canvasHeight: canvas.height,
    };
    const markers = markersOf(sequence, 0, context.fps);
    timelines.push({
      name: childText(sequence, 'name') ?? 'Sequence',
      rate,
      canvas,
      tracks: readSequenceTracks(context, sequence),
      ...(markers.length > 0 && { markers }),
    });
  }
  if (timelines.length === 0) {
    throw new InterchangeReadError('empty', 'This Final Cut Pro 7 XML file has no sequence in it');
  }
  const notices: InterchangeNotice[] = versionNotice('Final Cut Pro 7 XML', root.attributes.version, TESTED_VERSIONS);
  return {
    source: 'fcp7',
    ...(root.attributes.version && { sourceVersion: root.attributes.version }),
    timelines,
    ...(notices.length > 0 && { notices }),
  };
};
