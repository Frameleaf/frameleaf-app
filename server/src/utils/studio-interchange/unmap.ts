/**
 * A Studio project graph back to the neutral timeline (FL-1566), for sending a project to another
 * editor. The mapper (map.ts) run the other way: tracks bottom first, gaps between clips, transitions
 * on the cuts they cover, nests from compositions, titles as title generators, and what only Studio
 * draws (its effects, grades and shapes) named so each writer can say what stays behind.
 *
 * Pure: the caller says what each media id's file is called.
 */
import type {
  Clip,
  ClipFrameleaf,
  Marker,
  Stack,
  Timeline,
  Track,
  TrackChild,
} from 'src/utils/studio-interchange/model.js';

type Item = Record<string, unknown> & {
  id: string;
  trackId: string;
  type: string;
  from: number;
  durationInFrames: number;
};
type GraphTrack = Record<string, unknown> & {
  id: string;
  name?: string;
  kind?: string;
  order?: number;
  muted?: boolean;
};
type GraphTransition = { leftClipId?: string; rightClipId?: string; durationInFrames?: number; presentation?: string };
type Composition = {
  id: string;
  name?: string;
  items?: Item[];
  tracks?: GraphTrack[];
  transitions?: GraphTransition[];
};
export type StudioGraphLike = {
  name?: string;
  metadata?: { width?: number; height?: number; fps?: number; frameRate?: { num: number; den: number } };
  timeline?: {
    tracks?: GraphTrack[];
    items?: Item[];
    transitions?: GraphTransition[];
    markers?: { frame?: number; label?: string; color?: string }[];
    compositions?: Composition[];
  };
};

/** The file a media id plays, as the other editor should look for it. */
export type StudioMediaFile = { name: string; key?: string; kind?: 'video' | 'audio' | 'image' };

const number = (value: unknown, fallback = 0) =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback;
const text = (value: unknown) => (typeof value === 'string' ? value : '');

/** Studio's transition presentations by the name other editors use. */
const TRANSITION_NAMES: Record<string, string> = {
  dissolve: 'SMPTE_Dissolve',
  fade: 'Fade',
  dipToColorDissolve: 'Dip to Color',
  wipe: 'SMPTE_Wipe',
  slide: 'Slide',
  iris: 'Iris',
  additiveDissolve: 'Additive Dissolve',
  nonAdditiveDissolve: 'Non-Additive Dissolve',
  smoothCut: 'Morph Cut',
};

type Context = {
  fps: number;
  media: (id: string) => StudioMediaFile | undefined;
  compositions: Map<string, Composition>;
  depth: number;
};

const frameleafOf = (item: Item): ClipFrameleaf => {
  const frameleaf: ClipFrameleaf = {};
  const speed = number(item.speed, 1);
  if (speed !== 1 || item.isReversed === true) {
    frameleaf.speed = speed * (item.isReversed === true ? -1 : 1);
  }
  if (typeof item.volume === 'number' && item.volume !== 0) {
    frameleaf.volumeDb = item.volume;
  }
  if (typeof item.audioFadeIn === 'number' && item.audioFadeIn > 0) {
    frameleaf.fadeInSeconds = item.audioFadeIn;
  }
  if (typeof item.audioFadeOut === 'number' && item.audioFadeOut > 0) {
    frameleaf.fadeOutSeconds = item.audioFadeOut;
  }
  if (item.muted === true) {
    frameleaf.muted = true;
  }
  const effects = (Array.isArray(item.effects) ? item.effects : []).flatMap((entry) => {
    const effect = (entry as { effect?: { gpuEffectType?: unknown }; enabled?: unknown }) ?? {};
    return effect.enabled === false || typeof effect.effect?.gpuEffectType !== 'string'
      ? []
      : [{ name: effect.effect.gpuEffectType }];
  });
  if (effects.length > 0) {
    frameleaf.effects = effects;
  }
  return frameleaf;
};

const seconds = (frames: number, fps: number) => ({ value: frames, rate: fps });

const childOf = (context: Context, item: Item): Clip | Stack | null => {
  const duration = seconds(item.durationInFrames, context.fps);
  const label = text(item.label) || text(item.text) || 'Clip';
  if (item.type === 'text') {
    return {
      type: 'clip',
      name: label,
      sourceRange: { startTime: seconds(0, context.fps), duration },
      mediaReference: { kind: 'generator', generator: 'title', name: 'Title' },
      frameleaf: {
        title: {
          text: text(item.text) || label,
          ...(text(item.fontFamily) && { font: text(item.fontFamily) }),
          ...(typeof item.fontSize === 'number' && { size: item.fontSize }),
          ...(text(item.color) && { color: text(item.color) }),
          ...(['left', 'center', 'right'].includes(text(item.textAlign)) && {
            align: text(item.textAlign) as 'left' | 'center' | 'right',
          }),
        },
      },
    };
  }
  if (item.type === 'composition') {
    const composition = context.compositions.get(text(item.compositionId));
    if (!composition || context.depth > 16) {
      return null;
    }
    return {
      type: 'stack',
      name: composition.name || label,
      tracks: tracksOf(
        { ...context, depth: context.depth + 1 },
        composition.tracks ?? [],
        composition.items ?? [],
        composition.transitions ?? [],
      ),
      sourceRange: { startTime: seconds(number(item.sourceStart), context.fps), duration },
    };
  }
  if (['video', 'audio', 'image'].includes(item.type)) {
    const file = context.media(text(item.mediaId));
    const sourceFps = number(item.sourceFps, context.fps) || context.fps;
    const frameleaf = frameleafOf(item);
    const clip: Clip = {
      type: 'clip',
      name: label,
      sourceRange: {
        startTime: { value: item.type === 'image' ? 0 : number(item.sourceStart), rate: sourceFps },
        duration,
      },
      mediaReference: file
        ? {
            kind: 'external',
            key: file.key ?? file.name,
            name: file.name,
            facts: { kind: file.kind ?? (item.type === 'image' ? 'image' : item.type === 'audio' ? 'audio' : 'video') },
          }
        : { kind: 'missing', name: label },
      ...(Object.keys(frameleaf).length > 0 && { frameleaf }),
    };
    return clip;
  }
  return {
    type: 'clip',
    name: label,
    sourceRange: { startTime: seconds(0, context.fps), duration },
    mediaReference: { kind: 'generator', generator: item.type === 'shape' ? 'solid' : 'other', name: item.type },
  };
};

/** The tracks of a timeline or composition, bottom video first, then sound. */
const tracksOf = (context: Context, tracks: GraphTrack[], items: Item[], transitions: GraphTransition[]): Track[] => {
  const byLeft = new Map(transitions.filter((item) => item.leftClipId).map((item) => [item.leftClipId!, item]));
  const ordered = [...tracks].sort((a, b) => number(a.order) - number(b.order));
  const video = ordered.filter((track) => track.kind !== 'audio').toReversed();
  const audio = ordered.filter((track) => track.kind === 'audio');
  return [...video, ...audio].flatMap((track): Track[] => {
    const own = items.filter((item) => item.trackId === track.id).sort((a, b) => a.from - b.from);
    if (own.length === 0) {
      return [];
    }
    const children: TrackChild[] = [];
    let position = 0;
    let previous: Item | null = null;
    for (const item of own) {
      if (item.from < position) {
        continue; // Overlaps on one track never happen in a valid graph; keep the first.
      }
      if (item.from > position) {
        children.push({
          type: 'gap',
          sourceRange: { startTime: seconds(0, context.fps), duration: seconds(item.from - position, context.fps) },
        });
      }
      const transition =
        previous && previous.from + previous.durationInFrames === item.from ? byLeft.get(previous.id) : undefined;
      if (transition && transition.rightClipId === item.id && number(transition.durationInFrames) > 0) {
        const half = number(transition.durationInFrames) / 2;
        children.push({
          type: 'transition',
          name: TRANSITION_NAMES[text(transition.presentation)] ?? text(transition.presentation) ?? 'SMPTE_Dissolve',
          inOffset: seconds(half, context.fps),
          outOffset: seconds(half, context.fps),
        });
      }
      const child = childOf(context, item);
      if (child) {
        children.push(child);
      } else {
        children.push({
          type: 'gap',
          sourceRange: { startTime: seconds(0, context.fps), duration: seconds(item.durationInFrames, context.fps) },
        });
      }
      position = item.from + item.durationInFrames;
      previous = item;
    }
    return [
      {
        kind: track.kind === 'audio' ? 'audio' : 'video',
        name: text(track.name),
        children,
        ...(track.muted === true && { muted: true }),
      },
    ];
  });
};

export const unmapStudioGraph = (
  graph: StudioGraphLike,
  media: (id: string) => StudioMediaFile | undefined,
): Timeline => {
  const metadata = graph.metadata ?? {};
  const rate =
    metadata.frameRate && metadata.frameRate.den > 0
      ? metadata.frameRate
      : { num: number(metadata.fps, 30) || 30, den: 1 };
  const fps = rate.num / rate.den;
  const timeline = graph.timeline ?? {};
  const context: Context = {
    fps,
    media,
    compositions: new Map((timeline.compositions ?? []).map((composition) => [composition.id, composition])),
    depth: 0,
  };
  const markers: Marker[] = (timeline.markers ?? []).map((marker) => ({
    name: text(marker.label) || 'Marker',
    markedRange: { startTime: seconds(number(marker.frame), fps), duration: seconds(0, fps) },
    ...(text(marker.color) && { color: text(marker.color) }),
  }));
  return {
    name: text(graph.name) || 'Studio project',
    rate,
    canvas: { width: number(metadata.width, 1920) || 1920, height: number(metadata.height, 1080) || 1080 },
    tracks: tracksOf(context, timeline.tracks ?? [], timeline.items ?? [], timeline.transitions ?? []),
    ...(markers.length > 0 && { markers }),
  };
};
