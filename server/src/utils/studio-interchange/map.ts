/**
 * The neutral timeline (model.ts) to a Studio project graph in normal form, plus the list of what came
 * over differently or could not (FL-1541). One Studio project per timeline; the caller loops over the
 * timelines the person picked. Nests become compositions.
 *
 * Pure: media is looked up through `resolveMedia`, which the import job answers (FL-1543). A clip whose
 * media is not found keeps its place with an id that resolves to nothing, which the editor shows as
 * missing and offers to relink. Paths, user names and machine names never enter the graph: a clip's
 * label is the file name alone.
 */
import {
  StudioCanvas,
  StudioFrameRate,
  StudioGraphItem,
  fittedTransform,
  secondsToFrames,
  studioFps,
  studioGraphIds,
  studioGraphUuid,
  studioProjectGraph,
  studioTrack,
  timelineToSource,
  transitionFramesFor,
} from 'src/utils/studio-graph-build.js';
import {
  Clip,
  InterchangeProject,
  Marker,
  MediaReference,
  Stack,
  Timeline,
  Track,
  seconds,
} from 'src/utils/studio-interchange/model.js';
import { MARKER_COLOURS, studioTransitionFor } from 'src/utils/studio-interchange/tables.js';

/** What the library holds for a clip's media, as `GET /studio/assets/{id}/media-facts` gives it. */
export type InterchangeMedia = {
  assetId: string;
  kind: 'video' | 'audio' | 'image';
  width: number;
  height: number;
  /** Exact frame rate as a float; 0 for a photo. */
  fps: number;
  /** Source frames when known; otherwise worked out from the length. */
  frameCount: number | null;
  durationSeconds: number;
};

export type InterchangeLossCode =
  | 'frame-rate'
  | 'media-missing'
  | 'media-shorter'
  | 'transition-unmatched'
  | 'transition-shortened'
  | 'transition-dropped'
  | 'transition-recentred'
  | 'audio-crossfade'
  | 'speed-out-of-range'
  | 'speed-ramp'
  | 'font-missing'
  | 'effect-dropped'
  | 'generator-dropped'
  | 'marker-range';

/** One line of the import report and of the notes in the editor. */
export type InterchangeLoss = {
  code: InterchangeLossCode;
  /** The clip, transition or marker it is about, by the name the person knows. */
  clip: string;
  /** What it was in the other editor. */
  what: string;
  /** What it became in Studio. */
  became: string;
  /** Where on the timeline, in project frames. */
  at: number;
};

export type InterchangeMapOptions = {
  source: InterchangeProject['source'];
  /** Seeds the ids, so importing the same file twice gives the same graph. */
  seed: string;
  /** Milliseconds; the project's own timestamps. */
  now: number;
  resolveMedia: (reference: Extract<MediaReference, { kind: 'external' }>) => InterchangeMedia | null;
  /** Font families the editor can draw. */
  fonts: ReadonlySet<string>;
};

const DEFAULT_FONT = 'Inter';
const MIN_SPEED = 0.1;
const MAX_SPEED = 10;
const round3 = (value: number) => Math.round(value * 1000) / 1000;
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
/** The file name alone: no folder of the other machine reaches the graph. */
const baseName = (name: string) => name.split(/[/\\]/).at(-1)?.trim() || 'Clip';

/** Rates the engine reads exactly (protocol 3.2): whole numbers and the five n/1001 rates. */
const DROP_FRAME = [24_000, 30_000, 48_000, 60_000, 120_000];
const studioRate = (rate: StudioFrameRate): StudioFrameRate | null => {
  const fps = rate.num / rate.den;
  if (!(fps > 0) || fps > 120) {
    return null;
  }
  if (Number.isSafeInteger(fps)) {
    return { num: fps, den: 1 };
  }
  const n = DROP_FRAME.find((value) => Math.abs(value / 1001 - fps) < 1e-6);
  return n === undefined ? null : { num: n, den: 1001 };
};

type Context = {
  options: InterchangeMapOptions;
  nextId: () => string;
  fps: number;
  canvas: StudioCanvas;
  losses: InterchangeLoss[];
  compositions: unknown[];
  markers: unknown[];
};

type Built = {
  tracks: ReturnType<typeof studioTrack>[];
  items: StudioGraphItem[];
  transitions: unknown[];
  lengthFrames: number;
};

const lose = (context: Context, loss: InterchangeLoss) => {
  context.losses.push(loss);
};

const markerColour = (colour: string | undefined) =>
  colour && /^#[\da-f]{6}$/i.test(colour)
    ? colour.toUpperCase()
    : (MARKER_COLOURS[colour?.toUpperCase() ?? ''] ?? '#3B82F6');

const addMarkers = (context: Context, markers: readonly Marker[] | undefined, offsetSeconds: number) => {
  for (const marker of markers ?? []) {
    const frame = secondsToFrames(offsetSeconds + seconds(marker.markedRange.startTime), context.fps);
    const name = marker.name.trim();
    context.markers.push({
      id: context.nextId(),
      frame: Math.max(0, frame),
      color: markerColour(marker.color),
      ...(name && { label: name.slice(0, 200) }),
    });
    if (seconds(marker.markedRange.duration) > 0 || marker.note) {
      lose(context, {
        code: 'marker-range',
        clip: name || 'Marker',
        what: marker.note ? 'A marker with a note' : 'A marker over a range',
        became: 'A marker at its start',
        at: frame,
      });
    }
  }
};

/** The picture move on top of the fitted picture. */
const transformOf = (context: Context, clip: Clip, width: number, height: number) => {
  const base = fittedTransform(context.canvas, width, height);
  const move = clip.frameleaf?.transform;
  if (!move) {
    return base;
  }
  const scale = move.scale ?? 1;
  return {
    x: move.x ?? 0,
    y: move.y ?? 0,
    width: base.width * scale,
    height: base.height * scale,
    rotation: (((move.rotation ?? 0) % 360) + 360) % 360,
    ...(move.opacity !== undefined && move.opacity < 1 && { opacity: clamp(move.opacity, 0, 1) }),
  };
};

const soundOf = (clip: Clip) => {
  const sound = clip.frameleaf ?? {};
  return {
    ...(sound.volumeDb !== undefined && sound.volumeDb !== 0 && { volume: clamp(sound.volumeDb, -60, 12) }),
    ...(sound.fadeInSeconds && { audioFadeIn: round3(sound.fadeInSeconds) }),
    ...(sound.fadeOutSeconds && { audioFadeOut: round3(sound.fadeOutSeconds) }),
    ...(sound.muted && { muted: true }),
  };
};

const titleItem = (
  context: Context,
  clip: Clip,
  base: { id: string; trackId: string; from: number; durationInFrames: number },
) => {
  const title = clip.frameleaf?.title ?? { text: clip.name };
  let font = title.font?.trim() || DEFAULT_FONT;
  if (!context.options.fonts.has(font)) {
    lose(context, {
      code: 'font-missing',
      clip: clip.name,
      what: `Set in ${font}`,
      became: `Set in ${DEFAULT_FONT} until you choose another font`,
      at: base.from,
    });
    font = DEFAULT_FONT;
  }
  const text = title.text.trim() || clip.name;
  return {
    ...base,
    type: 'text',
    label: text.slice(0, 64),
    text,
    color: title.color && /^#[\da-f]{6}$/i.test(title.color) ? title.color : '#FFFFFF',
    fontFamily: font,
    fontSize: title.size ?? Math.round(context.canvas.height * 0.085),
    textAlign: title.align ?? 'center',
  } satisfies StudioGraphItem;
};

/** A clip with media: video, sound or a still. */
const mediaItem = (
  context: Context,
  clip: Clip,
  track: Track,
  base: { id: string; trackId: string; from: number; durationInFrames: number },
): StudioGraphItem => {
  const reference = clip.mediaReference as Exclude<MediaReference, { kind: 'generator' }>;
  const media = reference.kind === 'external' ? context.options.resolveMedia(reference) : null;
  const facts = reference.kind === 'external' ? reference.facts : undefined;
  const label = baseName(reference.name || clip.name);
  const kind = media?.kind ?? facts?.kind ?? (track.kind === 'audio' ? 'audio' : 'video');
  const type = track.kind === 'audio' ? 'audio' : kind === 'image' ? 'image' : 'video';
  const missingKey = reference.kind === 'external' ? reference.key : `${reference.name}:${clip.name}`;
  const mediaId = media?.assetId ?? studioGraphUuid(`${context.options.seed}:missing:${missingKey}`);
  if (!media) {
    lose(context, {
      code: 'media-missing',
      clip: label,
      what: 'A clip whose file is not in your library',
      became: 'A placeholder that keeps its place; choose the file to put it back',
      at: base.from,
    });
  }
  for (const effect of clip.frameleaf?.effects ?? []) {
    lose(context, {
      code: 'effect-dropped',
      clip: label,
      what: effect.fromPlugin ? `${effect.name}, from a plug-in` : effect.name,
      became: 'The clip comes over without it',
      at: base.from,
    });
  }
  const common = { ...base, label, mediaId, originId: context.nextId() };
  const width = media?.width || facts?.width || context.canvas.width;
  const height = media?.height || facts?.height || context.canvas.height;

  if (type === 'image') {
    return {
      ...common,
      type,
      src: '',
      sourceStart: 0,
      sourceEnd: base.durationInFrames,
      sourceDuration: base.durationInFrames,
      sourceFps: context.fps,
      trimStart: 0,
      trimEnd: 0,
      sourceWidth: width,
      sourceHeight: height,
      transform: transformOf(context, clip, width, height),
    };
  }

  // Speed: steady only. A ramp comes over at its average speed until Studio draws curves (FL-1560).
  let speed = clip.frameleaf?.speed ?? 1;
  const isReversed = speed < 0;
  speed = Math.abs(speed) || 1;
  if (speed < MIN_SPEED || speed > MAX_SPEED) {
    lose(context, {
      code: 'speed-out-of-range',
      clip: label,
      what: `Played at ${round3(speed * 100)} %`,
      became: `Played at ${round3(clamp(speed, MIN_SPEED, MAX_SPEED) * 100)} %, the nearest Studio allows`,
      at: base.from,
    });
    speed = clamp(speed, MIN_SPEED, MAX_SPEED);
  }
  if (clip.frameleaf?.speedRamp) {
    lose(context, {
      code: 'speed-ramp',
      clip: label,
      what: 'Speed that changes over the clip',
      became: 'One steady speed for the whole clip',
      at: base.from,
    });
  }
  const sourceFps = round3(media?.fps || clip.sourceRange.startTime.rate || context.fps);
  const known = media
    ? (media.frameCount ?? Math.floor(media.durationSeconds * sourceFps))
    : reference.kind === 'external' && reference.availableRange
      ? Math.floor(seconds(reference.availableRange.duration) * sourceFps)
      : 0;
  const span = Math.max(1, Math.round(timelineToSource(base.durationInFrames, context.fps, sourceFps) * speed));
  let sourceStart = Math.max(0, Math.round(seconds(clip.sourceRange.startTime) * sourceFps));
  // A placeholder is as long as it needs to be; a found file may be a little shorter than the original.
  const sourceDuration = media ? Math.max(1, known) : Math.max(known, sourceStart + span);
  if (sourceStart + span > sourceDuration) {
    lose(context, {
      code: 'media-shorter',
      clip: label,
      what: 'A clip that uses more of the file than your library’s copy has',
      became: 'The clip uses the end of the copy it found',
      at: base.from,
    });
    sourceStart = Math.max(0, sourceDuration - span);
  }
  const sourceEnd = Math.min(sourceDuration, sourceStart + span);
  return {
    ...common,
    type,
    src: '',
    sourceStart,
    sourceEnd,
    sourceDuration,
    sourceFps,
    trimStart: 0,
    trimEnd: 0,
    ...(speed !== 1 && { speed: round3(speed) }),
    ...(isReversed && { isReversed: true }),
    ...(type === 'video' && {
      sourceWidth: width,
      sourceHeight: height,
      transform: transformOf(context, clip, width, height),
    }),
    ...soundOf(clip),
  };
};

/** The tracks of a timeline or a nest, Studio's way up: video top first, then sound. */
const buildTracks = (context: Context, tracks: readonly Track[], offsetSeconds: number): Built => {
  const video = tracks.filter((track) => track.kind === 'video').toReversed();
  const audio = tracks.filter((track) => track.kind === 'audio');
  const studioTracks: Built['tracks'] = [];
  const soundTracks: Built['tracks'] = [];
  const items: StudioGraphItem[] = [];
  const transitions: unknown[] = [];
  let lengthFrames = 0;

  const ordered = [
    ...video.map((track, index) => ({ track, name: track.name || `V${index + 1}` })),
    ...audio.map((track, index) => ({ track, name: track.name || `A${index + 1}` })),
  ];
  for (const { track, name } of ordered) {
    const trackId = context.nextId();
    const studio = studioTrack(trackId, name, track.kind, 0);
    if (track.muted) {
      studio.muted = true;
    }
    studioTracks.push(studio);
    let soundTrackId: string | null = null;
    let position = 0;
    let previous: StudioGraphItem | null = null;
    let pending: { name: string; inSeconds: number; outSeconds: number } | null = null;

    for (const child of track.children) {
      if (child.type === 'transition') {
        pending = { name: child.name, inSeconds: seconds(child.inOffset), outSeconds: seconds(child.outOffset) };
        continue;
      }
      const length = child.type === 'stack' && !child.sourceRange ? null : seconds(child.sourceRange!.duration);
      if (child.type === 'gap') {
        position += length ?? 0;
        previous = null;
        pending = null;
        continue;
      }
      const from = secondsToFrames(position, context.fps);
      let placed: StudioGraphItem | null = null;
      let advance = length ?? 0;

      if (child.type === 'stack') {
        const nest = nestItem(context, child, trackId, from, offsetSeconds + position);
        if (nest) {
          placed = nest.item;
          advance = nest.item.durationInFrames / context.fps;
          items.push(nest.item);
          if (nest.sound) {
            if (!soundTrackId) {
              soundTrackId = context.nextId();
              soundTracks.push(studioTrack(soundTrackId, `${name} sound`, 'audio', 0));
            }
            items.push({ ...nest.sound, trackId: soundTrackId });
          }
        }
      } else {
        const durationInFrames = Math.max(1, secondsToFrames(position + advance, context.fps) - from);
        const base = { id: context.nextId(), trackId, from, durationInFrames };
        const reference = child.mediaReference;
        if (reference.kind === 'generator' && reference.generator === 'title') {
          placed = titleItem(context, child, base);
        } else if (reference.kind === 'generator') {
          lose(context, {
            code: 'generator-dropped',
            clip: child.name,
            what: `${reference.name}, drawn by the other editor`,
            became: 'Left out; the space is kept',
            at: from,
          });
        } else {
          placed = mediaItem(context, child, track, base);
        }
        if (placed) {
          items.push(placed);
        }
        addMarkers(context, child.markers, offsetSeconds + position - seconds(child.sourceRange.startTime));
      }

      if (placed && previous && pending && previous.from + previous.durationInFrames === placed.from) {
        transitions.push(...transitionBetween(context, track, previous, placed, pending));
      }
      pending = null;
      previous = placed;
      position += advance;
      if (placed) {
        lengthFrames = Math.max(lengthFrames, placed.from + placed.durationInFrames);
      }
    }
  }

  const allTracks = [...studioTracks, ...soundTracks];
  for (const [order, track] of allTracks.entries()) {
    track.order = order;
  }
  return { tracks: allTracks, items, transitions, lengthFrames };
};

/** A transition, or for sound a fade out and a fade in of the same length. */
const transitionBetween = (
  context: Context,
  track: Track,
  left: StudioGraphItem,
  right: StudioGraphItem,
  transition: { name: string; inSeconds: number; outSeconds: number },
): unknown[] => {
  const total = transition.inSeconds + transition.outSeconds;
  const requested = secondsToFrames(total, context.fps);
  const label = `${String(left.label)} → ${String(right.label)}`;
  if (requested < 2) {
    return [];
  }
  if (track.kind === 'audio') {
    left.audioFadeOut = round3(total);
    right.audioFadeIn = round3(total);
    lose(context, {
      code: 'audio-crossfade',
      clip: label,
      what: 'A crossfade between sound clips',
      became: 'A fade out and a fade in of the same length',
      at: right.from,
    });
    return [];
  }
  const alignment = total > 0 ? transition.inSeconds / total : 0.5;
  if (Math.abs(alignment - 0.5) > 0.1) {
    lose(context, {
      code: 'transition-recentred',
      clip: label,
      what: `${transition.name} placed off the cut`,
      became: 'Centred on the cut',
      at: right.from,
    });
  }
  let presentation = studioTransitionFor(context.options.source, transition.name);
  if (!presentation) {
    lose(context, {
      code: 'transition-unmatched',
      clip: label,
      what: transition.name,
      became: 'A cross dissolve of the same length',
      at: right.from,
    });
    presentation = 'dissolve';
  }
  const frames = transitionFramesFor(left, right, context.fps, requested);
  if (frames === 0) {
    lose(context, {
      code: 'transition-dropped',
      clip: label,
      what: transition.name,
      became: 'A cut: the clips have no spare frames to blend',
      at: right.from,
    });
    return [];
  }
  if (frames < requested) {
    lose(context, {
      code: 'transition-shortened',
      clip: label,
      what: `${transition.name}, ${requested} frames`,
      became: `${frames} frames, as long as the clips' spare frames allow`,
      at: right.from,
    });
  }
  return [
    {
      id: context.nextId(),
      type: 'crossfade',
      leftClipId: left.id,
      rightClipId: right.id,
      trackId: left.trackId,
      durationInFrames: frames,
      presentation,
      timing: 'linear',
      alignment: 0.5,
    },
  ];
};

/** A nest as a composition (protocol 14.2.1) and the clip that shows it, with its sound clip when it has sound. */
const nestItem = (context: Context, stack: Stack, trackId: string, from: number, offsetSeconds: number) => {
  const lossesBefore = context.losses.length;
  const inner = buildTracks(
    context,
    stack.tracks,
    offsetSeconds - (stack.sourceRange ? seconds(stack.sourceRange.startTime) : 0),
  );
  if (inner.lengthFrames < 1) {
    return null;
  }
  const compositionId = context.nextId();
  const tracks = inner.tracks.map((track) => ({
    ...track,
    items: inner.items.filter((item) => item.trackId === track.id),
  }));
  context.compositions.push({
    id: compositionId,
    name: stack.name || 'Nest',
    editorKind: 'sequence',
    items: inner.items,
    tracks,
    ...(inner.transitions.length > 0 && { transitions: inner.transitions }),
    fps: context.fps,
    width: context.canvas.width,
    height: context.canvas.height,
    durationInFrames: inner.lengthFrames,
  });
  const sourceStart = stack.sourceRange
    ? clamp(secondsToFrames(seconds(stack.sourceRange.startTime), context.fps), 0, inner.lengthFrames - 1)
    : 0;
  const used = stack.sourceRange
    ? secondsToFrames(seconds(stack.sourceRange.duration), context.fps)
    : inner.lengthFrames;
  const durationInFrames = Math.max(1, Math.min(used, inner.lengthFrames - sourceStart));
  // Losses inside the nest were counted from its own start; the notes need the main timeline's frame.
  for (const loss of context.losses.slice(lossesBefore)) {
    loss.at = clamp(from + loss.at - sourceStart, from, from + durationInFrames - 1);
  }
  const window = {
    from,
    durationInFrames,
    label: stack.name || 'Nest',
    compositionId,
    sourceStart,
    sourceEnd: sourceStart + durationInFrames,
    sourceDuration: inner.lengthFrames,
    sourceFps: context.fps,
    trimStart: 0,
    trimEnd: 0,
  };
  const hasSound = stack.tracks.some((track) => track.kind === 'audio');
  const linkedGroupId = hasSound ? context.nextId() : undefined;
  const item: StudioGraphItem = {
    id: context.nextId(),
    trackId,
    type: 'composition',
    ...window,
    ...(linkedGroupId && { linkedGroupId }),
    compositionWidth: context.canvas.width,
    compositionHeight: context.canvas.height,
    transform: fittedTransform(context.canvas, context.canvas.width, context.canvas.height),
  };
  addMarkers(context, stack.markers, offsetSeconds);
  const sound: StudioGraphItem | null = linkedGroupId
    ? { id: context.nextId(), trackId: '', type: 'audio', ...window, linkedGroupId, src: '' }
    : null;
  return { item, sound };
};

/** One timeline as a Studio project, and what changed on the way. */
export const mapInterchangeTimeline = (timeline: Timeline, options: InterchangeMapOptions) => {
  const losses: InterchangeLoss[] = [];
  let rate = studioRate(timeline.rate);
  if (!rate) {
    const nearest = clamp(Math.round(timeline.rate.num / timeline.rate.den) || 30, 1, 120);
    losses.push({
      code: 'frame-rate',
      clip: timeline.name,
      what: `${round3(timeline.rate.num / timeline.rate.den)} frames a second`,
      became: `${nearest} frames a second`,
      at: 0,
    });
    rate = { num: nearest, den: 1 };
  }
  const context: Context = {
    options,
    nextId: studioGraphIds(options.seed),
    fps: studioFps(rate),
    canvas: {
      width: Math.max(1, Math.round(timeline.canvas.width)),
      height: Math.max(1, Math.round(timeline.canvas.height)),
    },
    losses,
    compositions: [],
    markers: [],
  };
  const built = buildTracks(context, timeline.tracks, 0);
  addMarkers(context, timeline.markers, 0);
  const graph = studioProjectGraph({
    id: context.nextId(),
    name: timeline.name.trim() || 'Imported project',
    now: options.now,
    canvas: context.canvas,
    rate,
    lengthFrames: Math.max(1, built.lengthFrames),
    tracks: built.tracks,
    items: built.items,
    markers: context.markers.toSorted((a, b) => (a as { frame: number }).frame - (b as { frame: number }).frame),
    transitions: built.transitions,
    compositions: context.compositions,
  });
  return { graph, losses: losses.toSorted((a, b) => a.at - b.at) };
};
