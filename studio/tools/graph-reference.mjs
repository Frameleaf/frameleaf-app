/**
 * A reference implementation of parts 2, 3 and 4 of the Studio graph protocol v1 (FL-307, FL-308,
 * FL-309), written from sections 12 to 14 of `docs/docs/developer/studio-graph-protocol-v1.md` and
 * the parameter catalogue `studio/graph-parameters-v1.json` alone, without the engine.
 *
 * `graph-protocol.test.mjs` replays the conformance fixtures of the three parts through it: if the
 * prose is not enough to reproduce the engine's graphs, ids and refusals, a fixture fails here. It
 * is what a native client implements, in the smallest form that passes; it is not shipped anywhere.
 * It writes what the engine writes: for a case the fixtures mark `settlesOnLoad` that is the
 * unsettled graph, which `settle` in `graph-protocol.mjs` brings to normal form (14.2.3).
 *
 * Not covered: what the page declares engine arithmetic (13.1), the values of baked keyframes and
 * the poses of animated or already-parented clips, and the few things it leaves outside the
 * protocol. Those raise `Unspecified`.
 */
import { readFileSync } from 'node:fs';
import {
  applyMarkerCommand,
  applyTrackCommand,
  canonicalJson,
  carryFrame,
  clampInOut,
  exactRate,
  firstTrackName,
  framesOf,
  toSource,
  toTimeline,
  uuidStream,
  writeTracks,
} from './graph-protocol.mjs';

class Refusal extends Error {
  constructor(reason, detail) {
    super(detail);
    this.reason = reason;
  }
}
/** 13.2.1: the ids a graph may name. */
const catalogue = JSON.parse(readFileSync(new URL('../graph-parameters-v1.json', import.meta.url), 'utf8'));

/** Raised for what part 4 specifies and for engine arithmetic: the caller skips the case. */
export class Unspecified extends Error {}

const invalid = (detail) => {
  throw new Refusal('invalid', detail);
};
const failed = (detail) => {
  throw new Refusal('failed', detail);
};

const end = (clip) => clip.from + clip.durationInFrames;
const isMedia = (clip) => ['video', 'audio', 'composition'].includes(clip.type);
const isRational = (value) =>
  !!value && typeof value === 'object' && Number.isSafeInteger(value.num) && Number.isSafeInteger(value.den) && value.den > 0;
const unique = (ids) => [...new Set(ids)];

/** 13.9: defaults and field domains of the existing clip EQ stage, independent of the engine. */
const AUDIO_EQ_DEFAULTS = {
  outputGainDb: 0,
  band1Enabled: false, band1Type: 'high-pass', band1FrequencyHz: 30, band1GainDb: 0, band1Q: 1.1, band1SlopeDbPerOct: 12,
  lowCutEnabled: false, lowCutFrequencyHz: 30, lowCutSlopeDbPerOct: 12,
  lowEnabled: true, lowType: 'low-shelf', lowGainDb: 0, lowFrequencyHz: 120, lowQ: 2.3,
  lowMidEnabled: true, lowMidType: 'peaking', lowMidGainDb: 0, lowMidFrequencyHz: 400, lowMidQ: 1.1,
  midGainDb: 0,
  highMidEnabled: true, highMidType: 'peaking', highMidGainDb: 0, highMidFrequencyHz: 1600, highMidQ: 1.1,
  highEnabled: true, highType: 'high-shelf', highGainDb: 0, highFrequencyHz: 2800, highQ: 2.3,
  band6Enabled: false, band6Type: 'low-pass', band6FrequencyHz: 22000, band6GainDb: 0, band6Q: 1.1, band6SlopeDbPerOct: 12,
  highCutEnabled: false, highCutFrequencyHz: 22000, highCutSlopeDbPerOct: 12,
};
const audioEqField = (key) => `audioEq${key[0].toUpperCase()}${key.slice(1)}`;

function audioEqSettings(eq) {
  const defaults = { enabled: true, ...AUDIO_EQ_DEFAULTS };
  if (eq === null) return undefined;
  if (typeof eq !== 'object' || Array.isArray(eq)) invalid('eq must be an object or null');
  const resolved = { ...defaults, ...eq };
  for (const [key, value] of Object.entries(eq)) {
    if (!Object.hasOwn(defaults, key)) invalid(`eq: unknown field "${key}"`);
    let valid = typeof value === typeof defaults[key];
    if (typeof value === 'number') {
      const range = key.endsWith('GainDb') ? [-20, 20]
        : key.endsWith('Q') ? [0.3, 10.3]
        : key.endsWith('FrequencyHz') ? (key.startsWith('band1') || key.startsWith('lowCut') ? [20, 399]
          : key.startsWith('band6') || key.startsWith('highCut') ? [1400, 22000] : [20, 22000]) : null;
      valid &&= Number.isFinite(value) && (range ? value >= range[0] && value <= range[1] : [6, 12, 18, 24].includes(value));
    }
    if (typeof value === 'string') valid &&= (key === 'band1Type' ? ['low-shelf', 'peaking', 'high-shelf', 'high-pass']
      : key === 'band6Type' ? ['low-pass', 'low-shelf', 'peaking', 'high-shelf'] : ['low-shelf', 'peaking', 'high-shelf', 'notch']).includes(value);
    if (!valid) invalid(`eq.${key} is outside the engine's type or range, or contradicts its cut-band aliases`);
  }
  for (const [band, cut, type] of [['band1', 'lowCut', 'high-pass'], ['band6', 'highCut', 'low-pass']]) {
    if (!Object.keys(eq).some((key) => key.startsWith(band))) {
      resolved[`${band}Type`] = type;
      for (const suffix of ['Enabled', 'FrequencyHz', 'SlopeDbPerOct'])
        resolved[`${band}${suffix}`] = eq[`${cut}${suffix}`] ?? defaults[`${band}${suffix}`];
    }
    resolved[`${cut}Enabled`] = resolved[`${band}Enabled`] && resolved[`${band}Type`] === type;
    for (const suffix of ['FrequencyHz', 'SlopeDbPerOct']) resolved[`${cut}${suffix}`] = resolved[`${band}${suffix}`];
  }
  for (const [key, value] of Object.entries(eq)) {
    if (resolved[key] !== value) invalid(`eq.${key} is outside the engine's type or range, or contradicts its cut-band aliases`);
  }
  return { ...resolved, enabled: eq.enabled };
}

function clipAudioEqPatch(eq) {
  const resolved = audioEqSettings(eq);
  return Object.fromEntries(Object.keys({ enabled: true, ...AUDIO_EQ_DEFAULTS }).map((key) => [audioEqField(key), resolved?.[key]]));
}

/** The working state of one batch: the parts of the graph the commands read and write. */
function open(graph, media) {
  const timeline = structuredClone(graph.timeline);
  return {
    metadata: structuredClone(graph.metadata),
    fps: graph.metadata.fps,
    rate: graph.metadata.frameRate,
    canvas: { width: graph.metadata.width, height: graph.metadata.height },
    // 14.2.1: loading gives every track of a composition its sync lock.
    compositions: (timeline.compositions ?? []).map((composition) => ({
      ...composition,
      tracks: composition.tracks.map((track) => ({ ...track, syncLock: track.syncLock ?? true })),
    })),
    media: new Map(media.map((record) => [record.id, record])),
    tracks: timeline.tracks,
    items: timeline.items,
    transitions: timeline.transitions ?? [],
    keyframes: timeline.keyframes ?? [],
    markers: timeline.markers ?? [],
    inPoint: timeline.inPoint,
    outPoint: timeline.outPoint,
    timeline,
  };
}

function close(graph, state) {
  const { transitions, keyframes, markers, inPoint, outPoint, compositions, topLevelSequenceIds, ...rest } = state.timeline;
  const timeline = { ...rest, tracks: state.tracks, items: state.items };
  if (state.compositions.length > 0) timeline.compositions = state.compositions.map(storedComposition);
  // 14.2.1: a timeline tab that names no sequence left in the graph is dropped.
  const tabs = (topLevelSequenceIds ?? []).filter((id) => state.compositions.some((composition) => composition.id === id && composition.editorKind !== 'composite-2d'));
  if (tabs.length > 0) timeline.topLevelSequenceIds = tabs;
  if (state.transitions.length > 0) timeline.transitions = state.transitions;
  if (state.keyframes.length > 0) timeline.keyframes = state.keyframes.map(tidy);
  if (state.markers.length > 0) timeline.markers = state.markers;
  if (state.inPoint !== undefined) timeline.inPoint = state.inPoint;
  if (state.outPoint !== undefined) timeline.outPoint = state.outPoint;
  return { ...graph, metadata: state.metadata, timeline };
}

/* 12.1: common refusals */

const text = (payload, name) => {
  const value = payload[name];
  if (typeof value !== 'string' || value.length === 0) invalid(`${name} is required`);
  return value;
};
const clipOf = (state, id) => state.items.find((item) => item.id === id) ?? invalid(`clip "${id}" does not exist`);
const namedClip = (state, payload, name = 'clipId') => clipOf(state, text(payload, name));
const trackOf = (state, id) => state.tracks.find((track) => track.id === id) ?? invalid(`track "${id}" does not exist`);
const namedTrack = (state, payload) => trackOf(state, text(payload, 'trackId'));
const lockedTrack = (state, clip) => state.tracks.find((track) => track.id === clip.trackId)?.locked === true;

/** Section 3.3: a payload time as a non-negative frame of the project. */
const time = (state, payload, name) => {
  if (!isRational(payload[name])) invalid(`${name} must be an exact rational time`);
  const frames = framesOf(payload[name], state.rate);
  if (frames === null) invalid('The time is out of range');
  if (frames < 0) invalid(`${name} must not be negative`);
  return frames;
};
/** Section 3.3: a signed payload duration as frames at `rate`. */
const signed = (payload, name, rate) => {
  if (!isRational(payload[name])) invalid(`${name} must be an exact rational duration`);
  if (!rate) invalid('The frame rate has no exact reading');
  const frames = framesOf(payload[name], rate);
  if (frames === null) invalid('The time is out of range');
  return frames;
};

/* 12.2.1: linked clips */

function linkedGroup(state, clip) {
  if (clip.linkedGroupId) return state.items.filter((item) => item.linkedGroupId === clip.linkedGroupId);
  const pair = (other) =>
    ((clip.type === 'video' && other.type === 'audio') || (clip.type === 'audio' && other.type === 'video')) &&
    !!clip.originId &&
    clip.originId === other.originId &&
    !!clip.mediaId &&
    clip.mediaId === other.mediaId &&
    clip.from === other.from &&
    clip.durationInFrames === other.durationInFrames;
  const group = state.items.filter((item) => item.id === clip.id || pair(item));
  return group.length > 1 ? group : [clip];
}

const synchronised = (state, clip) =>
  linkedGroup(state, clip).filter(
    (member) =>
      member.id === clip.id ||
      (member.from === clip.from &&
        member.durationInFrames === clip.durationInFrames &&
        (member.sourceStart ?? null) === (clip.sourceStart ?? null) &&
        (member.sourceEnd ?? null) === (clip.sourceEnd ?? null) &&
        (member.speed ?? 1) === (clip.speed ?? 1)),
  );

const captionsOf = (state, clip) =>
  clip.type === 'text' ? [] : state.items.filter((item) => item.type === 'text' && item.captionSource?.clipId === clip.id);

/** The linked set of some clips, as ids: the clips, their linked groups (when `linked`), and attached captions. */
function linkedSet(state, ids, linked = true) {
  const clips = unique(ids)
    .map((id) => state.items.find((item) => item.id === id))
    .filter(Boolean);
  const members = linked
    ? unique(clips.flatMap((clip) => linkedGroup(state, clip).map((member) => member.id)))
    : clips.map((clip) => clip.id);
  const captions = members.flatMap((id) => captionsOf(state, clipOf(state, id)).map((caption) => caption.id));
  return unique([...members, ...captions]);
}

const refuseLocked = (state, ids, command) => {
  for (const id of ids) if (lockedTrack(state, clipOf(state, id))) failed(`${command}: a clip it would change is on a locked track`);
};

/** Section 5: two clips of a track share a frame (transitions do not excuse it in these checks). */
function refuseOverlap(state, trackIds, command) {
  for (const trackId of new Set(trackIds)) {
    const onTrack = state.items.filter((item) => item.trackId === trackId).sort((a, b) => a.from - b.from);
    for (let index = 1; index < onTrack.length; index++) {
      if (end(onTrack[index - 1]) > onTrack[index].from) failed(`${command}: clips would overlap on track "${trackId}"`);
    }
  }
}

/* 12.2.4: source frames */

const source = (state, clip, frames) => toSource(frames, state.fps, clip.sourceFps ?? state.fps, clip.speed ?? 1);
const timelineFrames = (state, clip, frames) => toTimeline(frames, state.fps, clip.sourceFps ?? state.fps, clip.speed ?? 1);

/** Whether the start of `clip` can be trimmed by `amount`, and the clip that results. */
function trimmedStart(state, clip, amount) {
  if (clip.durationInFrames - amount < 1) return null;
  if (isMedia(clip) && amount < 0 && -amount > timelineFrames(state, clip, clip.sourceStart ?? 0)) return null;
  const next = { ...clip, from: clip.from + amount, durationInFrames: clip.durationInFrames - amount };
  if (isMedia(clip)) next.sourceStart = (clip.sourceStart ?? 0) + source(state, clip, amount);
  return next;
}

function trimmedEnd(state, clip, amount) {
  if (clip.durationInFrames + amount < 1) return null;
  if (isMedia(clip) && clip.sourceDuration !== undefined) {
    if (clip.durationInFrames + amount > timelineFrames(state, clip, Math.max(0, clip.sourceDuration - (clip.sourceStart ?? 0))))
      return null;
  }
  const next = { ...clip, durationInFrames: clip.durationInFrames + amount };
  if (isMedia(clip)) {
    const start = clip.sourceStart ?? 0;
    // A clip with no sourceEnd gets one from its new length; otherwise the end moves with the trim.
    const asked = clip.sourceEnd === undefined ? start + source(state, clip, next.durationInFrames) : clip.sourceEnd + source(state, clip, amount);
    const moved = Math.max(start + 1, asked);
    next.sourceEnd = clip.sourceDuration === undefined ? moved : Math.min(clip.sourceDuration, moved);
  }
  return next;
}

const replace = (state, clip) => {
  state.items[state.items.findIndex((item) => item.id === clip.id)] = clip;
  return clip;
};
const move = (state, id, from) => replace(state, { ...clipOf(state, id), from });

/* 12.2.5: splitting */

function inTransition(state, clip, at) {
  const relative = at - clip.from;
  return state.transitions.some((transition) => {
    const length = Math.max(1, Math.floor(transition.durationInFrames));
    const left = Math.floor(length * Math.max(0, Math.min(1, transition.alignment ?? 0.5)));
    return (
      (transition.leftClipId === clip.id && relative >= clip.durationInFrames - left) ||
      (transition.rightClipId === clip.id && relative < length - left)
    );
  });
}

/** Split one clip at `at` with no link bookkeeping; returns its two halves. */
function cut(state, clip, at, draw) {
  const leftLength = at - clip.from;
  const rightLength = end(clip) - at;
  const originId = clip.originId ?? clip.id;
  const left = { ...clip, originId, durationInFrames: leftLength };
  const right = { ...clip, id: draw(), originId, from: at, durationInFrames: rightLength };
  if (isMedia(clip)) {
    const start = clip.sourceStart ?? 0;
    left.sourceStart = start;
    left.sourceEnd = start + source(state, clip, leftLength);
    right.sourceStart = left.sourceEnd;
    right.sourceEnd = start + source(state, clip, leftLength + rightLength);
  }
  replace(state, left);
  state.items.push(right);
  return { original: clip, left, right };
}

/** Split clips together (12.2.5): transitions follow the right halves and linked groups are re-made. */
function splitTogether(state, clips, at, draw) {
  const halves = clips.map((clip) => cut(state, clip, at, draw));
  const rightOf = new Map(halves.map((half) => [half.original.id, half.right.id]));
  state.transitions = state.transitions.map((transition) =>
    rightOf.has(transition.leftClipId) ? { ...transition, leftClipId: rightOf.get(transition.leftClipId) } : transition,
  );
  const linked = halves.filter((half) => half.original.linkedGroupId);
  if (linked.length > 0) {
    const [leftGroup, rightGroup] = linked.length > 1 ? [draw(), draw()] : [undefined, undefined];
    for (const half of linked) {
      for (const [id, group] of [
        [half.left.id, leftGroup],
        [half.right.id, rightGroup],
      ]) {
        const { linkedGroupId: _dropped, ...rest } = clipOf(state, id);
        replace(state, group ? { ...rest, linkedGroupId: group } : rest);
      }
    }
  }
  return halves.map((half) => ({ left: clipOf(state, half.left.id), right: clipOf(state, half.right.id) }));
}

function removeClips(state, ids) {
  const gone = new Set(ids);
  state.items = state.items.filter((item) => !gone.has(item.id));
  state.transitions = state.transitions.filter((transition) => !gone.has(transition.leftClipId) && !gone.has(transition.rightClipId));
  dropKeyframes(state, gone);
}

/** 13.2.4: an entry holds animation when it has a keyframe, an expression, a link or a separated vector. */
const holdsAnimation = (entry) =>
  entry.properties.some((group) => group.keyframes.length > 0) ||
  (entry.vectorProperties ?? []).some((group) => group.keyframes.length > 0) ||
  [entry.separatedVectorProperties, entry.propertyLinks, entry.expressions].some((list) => (list?.length ?? 0) > 0);

/** 13.2.7: removing clips removes their entries, and every entry that holds no animation. */
function dropKeyframes(state, gone) {
  state.keyframes = state.keyframes.filter((entry) => !gone.has(entry.itemId) && holdsAnimation(entry));
}

/* 12.2.3: sync lock */

const syncEnabled = (track) => !track.locked && track.syncLock !== false;
const followers = (state, edited) => state.tracks.filter((track) => !edited.has(track.id) && syncEnabled(track));

function removeIntervalFromTrack(state, trackId, a, b, draw) {
  const affected = [];
  const overlapping = state.items
    .filter((item) => item.trackId === trackId && item.from < b && end(item) > a)
    .sort((x, y) => x.from - y.from)
    .map((item) => item.id);
  for (const id of overlapping) {
    const clip = state.items.find((item) => item.id === id);
    if (!clip) continue;
    const before = clip.from < a;
    const after = end(clip) > b;
    if (!before && !after) removeClips(state, [clip.id]);
    else if (before && after) {
      const [first] = splitTogether(state, [clip], a, draw);
      const [second] = splitTogether(state, [first.right], b, draw);
      removeClips(state, [second.left.id]);
      affected.push(first.left.id, second.right.id);
    } else if (before) {
      const [first] = splitTogether(state, [clip], a, draw);
      removeClips(state, [first.right.id]);
      affected.push(first.left.id);
    } else {
      const [first] = splitTogether(state, [clip], b, draw);
      removeClips(state, [first.left.id]);
      affected.push(first.right.id);
    }
  }
  for (const item of state.items.filter((candidate) => candidate.trackId === trackId && candidate.from >= b)) {
    move(state, item.id, Math.max(0, item.from - (b - a)));
    affected.push(item.id);
  }
  return affected;
}

/** Remove intervals from every sync-enabled track that is not edited; returns the clips cut or moved. */
function removeIntervals(state, edited, intervals, draw) {
  const sorted = intervals.filter((interval) => interval.end > interval.start).sort((x, y) => x.start - y.start);
  const merged = [];
  for (const interval of sorted) {
    const previous = merged.at(-1);
    if (previous && interval.start <= previous.end) previous.end = Math.max(previous.end, interval.end);
    else merged.push({ ...interval });
  }
  const affected = [];
  for (const track of followers(state, edited)) {
    let removed = 0;
    for (const interval of merged) {
      affected.push(...removeIntervalFromTrack(state, track.id, interval.start - removed, interval.end - removed, draw));
      removed += interval.end - interval.start;
    }
  }
  return affected;
}

function openGaps(state, edited, at, length, draw) {
  const affected = [];
  if (length <= 0) return affected;
  for (const track of followers(state, edited)) {
    const spanning = state.items
      .filter((item) => item.trackId === track.id && item.from < at && end(item) > at)
      .sort((x, y) => x.from - y.from);
    for (const clip of spanning) {
      const [halves] = splitTogether(state, [clipOf(state, clip.id)], at, draw);
      affected.push(halves.left.id, halves.right.id);
    }
    for (const item of state.items.filter((candidate) => candidate.trackId === track.id && candidate.from >= at)) {
      move(state, item.id, item.from + length);
      affected.push(item.id);
    }
  }
  return affected;
}

/* 12.2.6: transition repair */

const VISUAL = ['video', 'image', 'composition'];
const portions = (length, alignment) => {
  const whole = Math.max(1, Math.floor(length));
  const left = Math.floor(whole * Math.max(0, Math.min(1, alignment ?? 0.5)));
  return { left, right: whole - left };
};
function handle(state, clip, side) {
  if (['text', 'shape', 'adjustment', 'image'].includes(clip.type)) return Infinity;
  if (clip.type === 'audio') return 0;
  if (side === 'head') return timelineFrames(state, clip, clip.sourceStart ?? 0);
  const total = clip.sourceDuration ?? 0;
  return timelineFrames(state, clip, Math.max(0, total - (clip.sourceEnd ?? total)));
}
const fits = (state, left, right, length, alignment) => {
  const part = portions(length, alignment);
  return part.right <= handle(state, left, 'tail') && part.left <= handle(state, right, 'head');
};
function longestByHandles(state, left, right, alignment) {
  const most = Math.floor(Math.min(left.durationInFrames, right.durationInFrames) - 1);
  for (let length = most; length >= 1; length--) if (fits(state, left, right, length, alignment)) return length;
  return 0;
}

/** 12.2.6: whether a transition of this length is valid between two clips as they are. */
function transitionValid(state, left, right, transition) {
  if (left.trackId !== right.trackId) return false;
  const meet = Math.abs(end(left) - right.from) <= 1;
  if (!meet && !(right.from < end(left))) return false;
  if (!VISUAL.includes(left.type) || !VISUAL.includes(right.type)) return false;
  if (transition.durationInFrames > Math.min(left.durationInFrames, right.durationInFrames) - 1) return false;
  return !meet || fits(state, left, right, transition.durationInFrames, transition.alignment);
}

/**
 * 12.2.6: every transition that touches an edited clip is valid before the edit and with the edited
 * clips of `preview` in place.
 */
function transitionsStayValid(state, preview) {
  const stored = (id) => state.items.find((item) => item.id === id);
  const edited = (id) => preview.get(id) ?? stored(id);
  return state.transitions
    .filter((transition) => preview.has(transition.leftClipId) || preview.has(transition.rightClipId))
    .every((transition) =>
      [stored, edited].every((clipAt) => {
        const left = clipAt(transition.leftClipId);
        const right = clipAt(transition.rightClipId);
        return !left || !right || transitionValid(state, left, right, transition);
      }),
    );
}

function repair(state, changedIds) {
  const changed = new Set(changedIds);
  const kept = [];
  const shortened = [];
  for (const transition of state.transitions) {
    if (!changed.has(transition.leftClipId) && !changed.has(transition.rightClipId)) {
      kept.push(transition);
      continue;
    }
    const left = state.items.find((item) => item.id === transition.leftClipId);
    const right = state.items.find((item) => item.id === transition.rightClipId);
    if (!left || !right || left.trackId !== right.trackId) continue;
    const meet = Math.abs(end(left) - right.from) <= 1;
    if (!meet && !(right.from < end(left))) continue;
    if (!VISUAL.includes(left.type) || !VISUAL.includes(right.type)) continue;
    const length = transition.durationInFrames;
    const shortest = Math.min(left.durationInFrames, right.durationInFrames);
    if (meet) {
      const most = longestByHandles(state, left, right, transition.alignment);
      if (most <= 0) continue;
      if (length > most) shortened.push({ ...transition, durationInFrames: most });
      else kept.push(transition);
    } else {
      const overlap = end(left) - right.from;
      if (overlap < length) {
        const next = Math.max(2, Math.floor(overlap));
        if (next < left.durationInFrames && next < right.durationInFrames) shortened.push({ ...transition, durationInFrames: next });
      } else if (length >= shortest) shortened.push({ ...transition, durationInFrames: Math.max(2, shortest - 1) });
      else kept.push(transition);
    }
  }
  state.transitions = [...kept, ...shortened];
}

/** Move clips; a transition whose two clips both moved and share a track takes that track (12.2.6). */
function moveClips(state, moves) {
  for (const { id, from, trackId } of moves) replace(state, { ...clipOf(state, id), from, ...(trackId ? { trackId } : {}) });
  const moved = new Set(moves.map((entry) => entry.id));
  state.transitions = state.transitions.map((transition) => {
    if (!moved.has(transition.leftClipId) || !moved.has(transition.rightClipId)) return transition;
    const left = clipOf(state, transition.leftClipId);
    return left.trackId === clipOf(state, transition.rightClipId).trackId ? { ...transition, trackId: left.trackId } : transition;
  });
  repair(state, moved);
}

/* 12.2.7: in and out points */

const lastFrame = (state) => Math.max(0, ...state.items.map(end));
const clamp = (state) => Object.assign(state, clampInOut(state.inPoint, state.outPoint, lastFrame(state), state.fps));

/* 12.3.1, 12.5.3: placing library media */

const round3 = (value) => Math.round(value * 1000) / 1000;

function mediaOf(state, assetId) {
  const record = state.media.get(assetId) ?? invalid(`assetId: "${assetId}" is not media this session may use`);
  const type = record.mimeType.startsWith('image/')
    ? 'image'
    : record.mimeType.startsWith('video/')
      ? 'video'
      : invalid('unsupported media type');
  return { record, type };
}

/** The items of a placed asset. `range` is the source window of a marked range, when there is one. */
function placed(state, { record, type }, trackId, audioTrackId, from, durationInFrames, range, draw) {
  const { fps, canvas } = state;
  const rate = type === 'image' ? fps : record.fps || fps;
  const sourceDuration = type === 'image' ? fps * 3 : Math.max(1, Math.round(record.duration * rate));
  const originId = draw();
  const linkedGroupId = audioTrackId ? draw() : undefined;
  const width = record.width || canvas.width;
  const height = record.height || canvas.height;
  const fit = Math.min(canvas.width / width, canvas.height / height);
  const build = (itemType, track) => {
    const window =
      itemType !== 'image' && range
        ? range
        : { sourceStart: 0, sourceEnd: Math.min(sourceDuration, Math.round((durationInFrames * rate) / fps)) };
    return {
      id: draw(),
      trackId: track,
      from,
      durationInFrames,
      label: record.fileName,
      mediaId: record.id,
      originId,
      ...(linkedGroupId ? { linkedGroupId } : {}),
      sourceStart: window.sourceStart,
      sourceEnd: Math.max(0, Math.round(window.sourceEnd)),
      sourceDuration: Math.max(0, Math.round(sourceDuration)),
      sourceFps: round3(rate),
      trimStart: 0,
      trimEnd: 0,
      type: itemType,
      src: '',
      ...(itemType === 'audio'
        ? {}
        : {
            ...(record.width ? { sourceWidth: record.width } : {}),
            ...(record.height ? { sourceHeight: record.height } : {}),
            transform: { x: 0, y: 0, width: Math.round(width * fit), height: Math.round(height * fit), rotation: 0 },
          }),
    };
  };
  return [build(type, trackId), ...(audioTrackId ? [build('audio', audioTrackId)] : [])];
}

function createAudioTrack(state, draw) {
  const created = {
    id: `track-${draw()}`,
    name: firstTrackName(state.tracks, 'audio'),
    kind: 'audio',
    height: 100,
    locked: false,
    syncLock: true,
    visible: true,
    muted: false,
    solo: false,
    volume: 0,
    order: Math.max(0, ...state.tracks.map((track) => track.order)) + 1,
    items: [],
  };
  state.tracks = writeTracks([...state.tracks, created]);
  return created.id;
}

/** Whether a new clip would share a frame with a clip on its track. */
const taken = (state, clip) => state.items.some((item) => item.trackId === clip.trackId && item.from < end(clip) && end(item) > clip.from);

/** 12.5.3: the shared checks and the placed clips of `clip.insert` and `clip.overwrite`. */
function sourceEdit(state, payload, command, draw) {
  const asset = mediaOf(state, text(payload, 'assetId'));
  const track = namedTrack(state, payload);
  if ((track.kind ?? 'video') !== 'video') invalid('library media goes on a video track');
  if (track.locked) failed(`${command}: the destination track is locked`);
  const at = time(state, payload, 'at');
  const { sourceIn, sourceOut } = payload;
  if (!isRational(sourceIn) || !isRational(sourceOut)) invalid('sourceIn and sourceOut must be exact rational times');
  if (sourceIn.num < 0) invalid('sourceIn must not be negative');
  const lengthNum = BigInt(sourceOut.num) * BigInt(sourceIn.den) - BigInt(sourceIn.num) * BigInt(sourceOut.den);
  const lengthDen = BigInt(sourceOut.den) * BigInt(sourceIn.den);
  if (lengthNum <= 0n) invalid('sourceOut must be after sourceIn');
  const project = state.rate;
  const doubled = 2n * lengthNum * BigInt(project.num) + lengthDen * BigInt(project.den);
  const durationInFrames = Number(doubled / (2n * lengthDen * BigInt(project.den)));
  if (durationInFrames < 1) invalid('The marked range is shorter than one frame');
  let range;
  if (asset.type === 'video') {
    const rate = exactRate(asset.record.fps) ?? invalid('The source rate has no exact reading');
    range = { sourceStart: framesOf(sourceIn, rate), sourceEnd: framesOf(sourceOut, rate) };
    if (range.sourceEnd > Math.max(1, Math.round(asset.record.duration * asset.record.fps)))
      invalid('sourceOut is past the end of the source');
    if (range.sourceEnd <= range.sourceStart) invalid('The marked range is shorter than one source frame');
  }
  let audioTrackId;
  if (asset.type === 'video' && asset.record.audioCodec) {
    const audio = state.tracks.filter((candidate) => candidate.kind === 'audio');
    audioTrackId = audio.find((candidate) => !candidate.locked)?.id;
    if (!audioTrackId && audio.length > 0) failed(`${command}: every audio track is locked`);
    audioTrackId ??= createAudioTrack(state, draw);
  }
  const clips = placed(state, asset, track.id, audioTrackId, at, durationInFrames, range, draw);
  return { clips, at, durationInFrames, trackIds: clips.map((clip) => clip.trackId) };
}

function land(state, clips, command) {
  for (const clip of clips) if (taken(state, clip)) failed(`${command}: the clip could not be placed`);
  state.items.push(...clips);
  repair(
    state,
    clips.map((clip) => clip.id),
  );
}

/* 12.5.5 */

function joinable(left, right) {
  if (left.originId !== right.originId || left.trackId !== right.trackId) return false;
  const key = (clip) => clip.compositionId ?? clip.mediaId;
  if (!key(left) || key(left) !== key(right)) return false;
  if (Math.abs(end(left) - right.from) > 1) return false;
  if ((left.speed || 1) !== (right.speed || 1)) return false;
  const leftEnd = left.sourceEnd ?? (left.sourceStart ?? 0) + left.durationInFrames * (left.speed || 1);
  return Math.abs(leftEnd - (right.sourceStart ?? 0)) <= 0.5;
}

/** The synchronised linked clips of `left` and `right` that share a track and a type, if any (12.4.2, 12.5.5). */
function counterparts(state, left, right) {
  const rights = synchronised(state, right).filter((member) => member.id !== right.id);
  for (const candidate of synchronised(state, left).filter((member) => member.id !== left.id)) {
    const match = rights.find((member) => member.trackId === candidate.trackId && member.type === candidate.type);
    if (match) return [candidate, match];
  }
  return null;
}

/* The commands of part 2 */

const commands = {
  /* 12.3.1 */
  'clip.add'(state, payload, draw) {
    const assetId = text(payload, 'assetId');
    const track = namedTrack(state, payload);
    const from = time(state, payload, 'at');
    const duration = payload.duration === undefined ? undefined : time(state, payload, 'duration');
    if (duration !== undefined && duration < 1) invalid('duration must be at least one frame');
    const asset = mediaOf(state, assetId);
    const { kind } = payload;
    if (kind !== undefined && typeof kind !== 'string') invalid('kind must be a string');
    if (kind !== undefined && kind !== asset.type && !(kind === 'photo' && asset.type === 'image'))
      invalid('kind does not match the asset');
    if ((track.kind ?? 'video') !== 'video') invalid('library media goes on a video track');
    const rounded = Math.round(asset.record.duration * state.fps);
    const natural = rounded > 0 ? rounded : Math.max(1, Math.round(asset.type === 'image' ? state.fps * 3 : state.fps));
    if (asset.type === 'video' && duration !== undefined && duration > natural) invalid('duration is longer than the source');
    let audioTrackId;
    if (asset.type === 'video' && asset.record.audioCodec) {
      audioTrackId = state.tracks.find((candidate) => candidate.kind === 'audio')?.id ?? createAudioTrack(state, draw);
    }
    const clips = placed(state, asset, track.id, audioTrackId, from, duration ?? natural, undefined, draw);
    for (const clip of clips) if (taken(state, clip)) failed('clip.add: that place on the track is taken');
    state.items.push(...clips);
  },

  /* 12.3.2 */
  'clip.delete'(state, payload, draw) {
    const named = Array.isArray(payload.clipIds) ? payload.clipIds : payload.clipId !== undefined ? [payload.clipId] : [];
    if (named.length === 0 || named.some((id) => typeof id !== 'string')) invalid('clipId or clipIds is required');
    for (const id of named) clipOf(state, id);
    const removed = linkedSet(state, named);
    if (payload.ripple !== true) {
      removeClips(state, removed);
      return;
    }
    const gone = new Set(removed);
    const deleted = state.items.filter((item) => gone.has(item.id));
    const edited = new Set(deleted.map((item) => item.trackId));
    const survivors = state.items.filter((item) => !gone.has(item.id));
    const shift = new Map();
    const view = { ...state, items: survivors };
    for (const clip of survivors) {
      const base = deleted
        .filter((other) => other.trackId === clip.trackId && end(other) <= clip.from)
        .reduce((sum, other) => sum + other.durationInFrames, 0);
      if (base <= 0) continue;
      for (const id of linkedSet(view, [clip.id])) {
        const member = survivors.find((item) => item.id === id);
        const track = state.tracks.find((candidate) => candidate.id === member.trackId);
        if (!edited.has(member.trackId) && (!track || syncEnabled(track))) continue;
        shift.set(id, Math.max(shift.get(id) ?? 0, base));
      }
    }
    // Covered clips: a clip that stays put and that a moved clip on its track would land on.
    const landing = (clip) => ({ from: clip.from - shift.get(clip.id), end: end(clip) - shift.get(clip.id) });
    const covered = survivors
      .filter((clip) => !shift.has(clip.id))
      .filter((clip) =>
        survivors.some((other) => {
          if (!shift.has(other.id) || other.trackId !== clip.trackId) return false;
          const next = landing(other);
          return next.from < end(clip) && next.end > clip.from;
        }),
      )
      .map((clip) => clip.id);
    const alsoRemoved = new Set(linkedSet(view, covered));
    const intervals = deleted.map((item) => ({ start: item.from, end: end(item) }));
    removeClips(state, [...removed, ...alsoRemoved]);
    const moves = survivors.filter((clip) => shift.has(clip.id) && !alsoRemoved.has(clip.id));
    for (const clip of moves) move(state, clip.id, clip.from - shift.get(clip.id));
    const affected = removeIntervals(state, edited, intervals, draw);
    repair(state, [...moves.map((clip) => clip.id), ...affected]);
  },

  /* 12.3.3 */
  'clip.move'(state, payload) {
    const clip = namedClip(state, payload);
    const start = time(state, payload, 'start');
    const { trackId, linkedSelectionEnabled } = payload;
    if (trackId !== undefined && typeof trackId !== 'string') invalid('trackId must be a string');
    if (linkedSelectionEnabled !== undefined && typeof linkedSelectionEnabled !== 'boolean')
      invalid('linkedSelectionEnabled must be a boolean');
    if (trackId && trackOf(state, trackId).locked) failed('clip.move: the destination track is locked');
    const moving = linkedSet(state, [clip.id], linkedSelectionEnabled !== false).filter((id) => !lockedTrack(state, clipOf(state, id)));
    if (!moving.includes(clip.id)) failed('clip.move: the clip is on a locked track');
    const delta = start - clip.from;
    const moves = moving.map((id) => ({ id, from: clipOf(state, id).from + delta, ...(id === clip.id && trackId ? { trackId } : {}) }));
    if (moves.some((entry) => entry.from < 0)) failed('clip.move: a linked clip or caption would start before the timeline');
    moveClips(state, moves);
  },

  /* 12.3.4 */
  'clip.split'(state, payload, draw) {
    const at = time(state, payload, 'at');
    const { clipIds } = payload;
    const splittable = (group) => group.every((member) => member.from < at && at < end(member) && !inTransition(state, member, at));
    if (clipIds === undefined) {
      const seen = new Set();
      let count = 0;
      for (const candidate of state.items.filter((item) => item.from < at && at < end(item)).map((item) => item.id)) {
        if (seen.has(candidate)) continue;
        const group = linkedGroup(state, clipOf(state, candidate));
        for (const member of group) seen.add(member.id);
        if (!splittable(group)) continue;
        splitTogether(state, group, at, draw);
        count++;
      }
      if (count === 0) invalid('clip.split: nothing spans that time');
      return;
    }
    if (!Array.isArray(clipIds) || clipIds.length === 0 || clipIds.some((id) => typeof id !== 'string'))
      invalid('clipIds must be clip ids');
    for (const id of clipIds) clipOf(state, id);
    const seen = new Set();
    const anchors = [];
    for (const id of clipIds) {
      if (seen.has(id)) continue;
      anchors.push(id);
      for (const member of linkedGroup(state, clipOf(state, id))) seen.add(member.id);
    }
    for (const id of anchors) {
      const group = linkedGroup(state, clipOf(state, id));
      if (!splittable(group)) invalid(`clip.split: "${id}" cannot be split there`);
      splitTogether(state, group, at, draw);
    }
  },

  /* 12.4.1 */
  'clip.trimStart': (state, payload, draw) => trim(state, payload, draw, 'start'),
  'clip.trimEnd': (state, payload, draw) => trim(state, payload, draw, 'end'),

  /* 12.4.2 */
  'clip.roll'(state, payload) {
    const clip = namedClip(state, payload);
    const next =
      state.items.find((item) => item.trackId === clip.trackId && item.id !== clip.id && item.from === end(clip)) ??
      invalid('clip.roll: no clip starts where this one ends');
    const at = time(state, payload, 'at');
    if (at === end(clip)) return;
    if (at <= clip.from || at >= end(next)) invalid('at must fall inside the two clips');
    refuseLocked(state, linkedSet(state, [clip.id, next.id]), 'clip.roll');
    const delta = at - end(clip);
    const pairs = [[clip, next]];
    const other = counterparts(state, clip, next);
    if (other) pairs.push(other);
    const preview = new Map();
    for (const [left, right] of pairs) {
      const [nextLeft, nextRight] = [trimmedEnd(state, left, delta), trimmedStart(state, right, delta)];
      if (!nextLeft || !nextRight) failed('clip.roll: the source media does not allow the cut there');
      preview.set(left.id, nextLeft).set(right.id, nextRight);
    }
    if (!transitionsStayValid(state, preview)) failed('clip.roll: a transition does not allow the cut there');
    for (const next of preview.values()) replace(state, next);
    repair(state, preview.keys());
  },

  /* 12.4.3 */
  'clip.slip'(state, payload) {
    const clip = namedClip(state, payload);
    if (!isMedia(clip)) invalid('clip.slip applies to video, audio and composition clips');
    if (clip.sourceEnd === undefined) invalid('clip.slip: the clip has no source range to slip');
    const delta = signed(payload, 'delta', exactRate(clip.sourceFps ?? state.fps));
    if (delta === 0) return;
    refuseLocked(state, linkedSet(state, [clip.id]), 'clip.slip');
    const preview = new Map();
    for (const member of synchronised(state, clip)) {
      if (member.sourceEnd === undefined) continue;
      const start = (member.sourceStart ?? 0) + delta;
      const stop = member.sourceEnd + delta;
      if (start < 0 || (member.sourceDuration !== undefined && stop > member.sourceDuration))
        failed('clip.slip: the source does not have that much media');
      preview.set(member.id, { ...member, sourceStart: start, sourceEnd: stop });
    }
    if (!transitionsStayValid(state, preview)) failed('clip.slip: a transition needs that media');
    for (const next of preview.values()) replace(state, next);
    repair(state, preview.keys());
  },

  /* 12.4.4 */
  'clip.slide'(state, payload) {
    const clip = namedClip(state, payload);
    const delta = signed(payload, 'delta', state.rate);
    if (delta === 0) return;
    const neighbours = (target) => ({
      left: state.items.find((item) => item.trackId === target.trackId && item.id !== target.id && end(item) === target.from),
      right: state.items.find((item) => item.trackId === target.trackId && item.id !== target.id && item.from === end(target)),
    });
    const { left, right } = neighbours(clip);
    if (!left && !right) invalid('clip.slide: the clip has no neighbour to trim; move it instead');
    refuseLocked(state, linkedSet(state, [clip.id, ...[left, right].filter(Boolean).map((item) => item.id)]), 'clip.slide');
    // Source continuity: between two joinable neighbours the clip's source window moves with it.
    let sourceDelta = 0;
    if (left && right && isMedia(clip) && clip.sourceEnd !== undefined && joinable(left, clip) && joinable(clip, right)) {
      sourceDelta = source(state, clip, delta);
      if ((clip.sourceStart ?? 0) + sourceDelta < 0) sourceDelta = -(clip.sourceStart ?? 0);
      if (clip.sourceDuration !== undefined && clip.sourceEnd + sourceDelta > clip.sourceDuration)
        sourceDelta = clip.sourceDuration - clip.sourceEnd;
    }
    const preview = new Map();
    const slide = (target, sides) => {
      if (target.from + delta < 0) failed('clip.slide: the clip would start before the timeline');
      for (const other of state.items) {
        if (other.trackId !== target.trackId || [target.id, sides.left?.id, sides.right?.id].includes(other.id)) continue;
        if (
          (end(other) <= target.from && target.from + delta < end(other)) ||
          (other.from >= end(target) && end(target) + delta > other.from)
        ) {
          failed('clip.slide: another clip is in the way');
        }
      }
      if (sides.left)
        preview.set(sides.left.id, trimmedEnd(state, sides.left, delta) ?? failed('clip.slide: a neighbour does not have enough media'));
      if (sides.right)
        preview.set(
          sides.right.id,
          trimmedStart(state, sides.right, delta) ?? failed('clip.slide: a neighbour does not have enough media'),
        );
      const moved = { ...target, from: target.from + delta };
      if (sourceDelta !== 0 && isMedia(target) && target.sourceEnd !== undefined) {
        moved.sourceStart = (target.sourceStart ?? 0) + sourceDelta;
        moved.sourceEnd = target.sourceEnd + sourceDelta;
      }
      preview.set(target.id, moved);
    };
    slide(clip, { left, right });
    const companion = synchronised(state, clip).find((member) => member.id !== clip.id);
    if (companion) slide(companion, neighbours(companion));
    if (!transitionsStayValid(state, preview)) failed('clip.slide: a transition blocks the slide');
    // 13.2.7: scalar keyframes that are in play must stay inside their clip and outside transitions.
    for (const [id, next] of preview) {
      const before = clipOf(state, id);
      const inPlay = (entryOf(state, id)?.properties ?? [])
        .flatMap((group) => group.keyframes.map((keyframe) => keyframe.frame))
        .filter((frame) => frame >= 0 && frame < before.durationInFrames && !inTransitionRegion(state, before, frame));
      if (inPlay.some((frame) => frame >= next.durationInFrames || inTransitionRegion(state, next, frame)))
        failed('clip.slide: a keyframe would fall outside its clip');
    }
    for (const next of preview.values()) replace(state, next);
    repair(state, preview.keys());
  },

  /* 12.4.5 */
  'clip.setSpeed'(state, payload) {
    const clip = namedClip(state, payload);
    if (!isMedia(clip)) invalid('clip.setSpeed applies to video, audio and composition clips');
    const { speed } = payload;
    if (!isRational(speed) || speed.num <= 0) invalid('speed must be a positive exact rate');
    if (speed.num * 10 < speed.den || speed.num > speed.den * 16) invalid('speed must be between 0.1 and 16');
    if (clip.sourceEnd === undefined) invalid('clip.setSpeed: the clip has no bounded source range');
    const span = clip.sourceEnd - (clip.sourceStart ?? 0);
    if (span < 1) invalid('clip.setSpeed: the clip has no source media to retime');
    const sourceRate = exactRate(clip.sourceFps ?? state.fps) ?? invalid('The source rate has no exact reading');
    const numerator = BigInt(span) * BigInt(sourceRate.den) * BigInt(speed.den) * BigInt(state.rate.num);
    const denominator = BigInt(sourceRate.num) * BigInt(speed.num) * BigInt(state.rate.den);
    const length = Number((2n * numerator + denominator) / (2n * denominator));
    if (length < 1) invalid('speed is too fast for this clip');
    const linked = linkedSet(state, [clip.id]);
    refuseLocked(state, linked, 'clip.setSpeed');
    const before = linked.map((id) => clipOf(state, id));
    const retimed = synchronised(state, clip);
    const oldEnd = end(clip);
    for (const member of retimed) {
      rescaleKeyframes(state, member.id, member.durationInFrames, length);
      const memberSpan = Math.max(1, (member.sourceEnd ?? member.sourceStart ?? 0) - (member.sourceStart ?? 0));
      const derived = (memberSpan * state.fps) / (length * (member.sourceFps ?? state.fps));
      replace(state, { ...member, durationInFrames: length, speed: Math.max(0.1, Math.min(16, derived)) });
    }
    const delta = length - clip.durationInFrames;
    const retimedIds = new Set(retimed.map((member) => member.id));
    const moved = new Set();
    if (delta !== 0) {
      const push = (id) => {
        for (const member of linkedSet(state, [id])) {
          if (moved.has(member) || retimedIds.has(member)) continue;
          moved.add(member);
          move(state, member, clipOf(state, member).from + delta);
        }
      };
      for (const trackId of new Set(retimed.map((member) => member.trackId))) {
        const later = state.items
          .filter((item) => item.trackId === trackId && !retimedIds.has(item.id) && item.from >= oldEnd)
          .sort((a, b) => a.from - b.from);
        for (const item of later) if (!moved.has(item.id)) push(item.id);
      }
      for (const transition of state.transitions) {
        if (retimedIds.has(transition.leftClipId) && !retimedIds.has(transition.rightClipId) && !moved.has(transition.rightClipId))
          push(transition.rightClipId);
      }
    }
    repair(state, [...retimedIds, ...moved]);
    for (const previous of before) {
      if (previous.id === clip.id || previous.from !== clip.from || previous.durationInFrames !== clip.durationInFrames) continue;
      if (clipOf(state, previous.id).durationInFrames !== length) failed('clip.setSpeed: a linked clip was not retimed with it');
    }
    refuseOverlap(
      state,
      before.map((previous) => previous.trackId),
      'clip.setSpeed',
    );
  },

  /* 12.5.1 */
  'clip.push'(state, payload) {
    const clip = namedClip(state, payload);
    const delta = signed(payload, 'delta', state.rate);
    if (delta === 0) return;
    const moving = state.items.filter((item) => item.from >= clip.from);
    refuseLocked(
      state,
      moving.map((item) => item.id),
      'clip.push',
    );
    if (moving.some((item) => item.from + delta < 0)) failed('clip.push: clips would start before the timeline');
    for (const item of moving) move(state, item.id, item.from + delta);
    repair(
      state,
      moving.map((item) => item.id),
    );
    refuseOverlap(
      state,
      moving.map((item) => item.trackId),
      'clip.push',
    );
  },

  /* 12.5.2 */
  'clip.reorder'(state, payload) {
    const track = namedTrack(state, payload);
    const clip = namedClip(state, payload);
    if (clip.trackId !== track.id) invalid('clipId is not on that track');
    if (track.locked) failed('clip.reorder: the track is locked');
    const { index } = payload;
    if (typeof index !== 'number' || !Number.isInteger(index)) invalid('index must be an integer');
    const ordered = state.items.filter((item) => item.trackId === track.id).sort((a, b) => a.from - b.from);
    if (index < 0 || index >= ordered.length) invalid('index is outside the track');
    const next = ordered.filter((item) => item.id !== clip.id);
    next.splice(index, 0, clip);
    let cursor = ordered[0].from;
    const shift = new Map();
    for (const item of next) {
      if (item.from !== cursor) shift.set(item.id, cursor - item.from);
      cursor += item.durationInFrames;
    }
    if (shift.size === 0) return;
    const target = new Map();
    for (const [id, delta] of shift) {
      for (const linkedId of linkedSet(state, [id])) {
        if (target.has(linkedId)) continue;
        const member = clipOf(state, linkedId);
        if (member.trackId !== track.id && lockedTrack(state, member)) failed('clip.reorder: a linked clip is on a locked track');
        target.set(linkedId, member.from + (shift.get(linkedId) ?? delta));
      }
    }
    const moves = [...target].map(([id, from]) => ({ id, from }));
    if (moves.some((entry) => entry.from < 0)) failed('clip.reorder: a linked clip would start before the timeline');
    moveClips(state, moves);
    refuseOverlap(
      state,
      moves.map((entry) => clipOf(state, entry.id).trackId),
      'clip.reorder',
    );
  },

  /* 12.5.3 */
  'clip.insert'(state, payload, draw) {
    const edit = sourceEdit(state, payload, 'clip.insert', draw);
    const targets = new Set(edit.trackIds);
    // Validate all affected original linked members before cutting or moving any of them.
    for (const anchor of state.items.filter((item) => targets.has(item.trackId) && end(item) > edit.at)) {
      const group = linkedGroup(state, anchor);
      refuseLocked(state, group.map((member) => member.id), 'clip.insert');
      if (anchor.from < edit.at && group.some((member) => member.from !== anchor.from || member.durationInFrames !== anchor.durationInFrames))
        failed('clip.insert: linked clips must share the cut partition');
    }
    // Step 1: cut what spans the edit point on the destination tracks, each with its linked group.
    const seen = new Set();
    for (const candidate of state.items
      .filter((item) => targets.has(item.trackId) && item.from < edit.at && end(item) > edit.at)
      .map((item) => item.id)) {
      if (seen.has(candidate)) continue;
      const group = linkedGroup(state, clipOf(state, candidate));
      for (const member of group) seen.add(member.id);
      if (!group.every((member) => member.from < edit.at && end(member) > edit.at))
        failed('clip.insert: linked clips are not all cut at that time');
      splitTogether(state, group, edit.at, draw);
    }
    // Step 2: what makes room, decided before the sync-lock gaps open.
    const onTargets = state.items.filter((item) => targets.has(item.trackId) && item.from >= edit.at).map((item) => item.id);
    const following = new Set(followers(state, targets).map((track) => track.id));
    const companions = linkedSet(state, onTargets).filter((id) => {
      const member = clipOf(state, id);
      return !targets.has(member.trackId) && !following.has(member.trackId) && !lockedTrack(state, member) && member.from >= edit.at;
    });
    const moves = unique([...onTargets, ...companions]).map((id) => ({ id, from: clipOf(state, id).from + edit.durationInFrames }));
    // Step 3.
    const affected = openGaps(state, targets, edit.at, edit.durationInFrames, draw);
    moveClips(state, moves);
    repair(state, [...moves.map((entry) => entry.id), ...affected]);
    refuseOverlap(
      state,
      state.tracks.map((track) => track.id),
      'clip.insert',
    );
    land(state, edit.clips, 'clip.insert');
  },

  /* 12.5.4 */
  'clip.overwrite'(state, payload, draw) {
    const edit = sourceEdit(state, payload, 'clip.overwrite', draw);
    const [start, stop] = [edit.at, edit.at + edit.durationInFrames];
    const targets = new Set(edit.trackIds);
    const affected = state.items.filter((item) => targets.has(item.trackId) && item.from < stop && end(item) > start);
    for (const anchor of affected) {
      if (linkedGroup(state, anchor).some((member) => !targets.has(member.trackId) || lockedTrack(state, member) ||
        member.from !== anchor.from || member.durationInFrames !== anchor.durationInFrames))
        failed('clip.overwrite: linked clips must share unlocked destination partitions');
    }
    for (const boundary of [start, stop]) {
      const seen = new Set();
      const crossing = state.items.filter((item) => targets.has(item.trackId) && item.from < boundary && end(item) > boundary).map((item) => item.id);
      for (const id of crossing) {
        if (seen.has(id)) continue;
        const group = linkedGroup(state, clipOf(state, id));
        for (const member of group) seen.add(member.id);
        splitTogether(state, group, boundary, draw);
      }
    }
    const covered = state.items.filter((item) => targets.has(item.trackId) && item.from >= start && end(item) <= stop);
    removeClips(state, unique(covered.flatMap((item) => linkedSet(state, [item.id], false))));
    // 12.2.7: the points are clamped to the extent the timeline has before the new clips land.
    clamp(state);
    repair(
      state,
      state.items.filter((item) => edit.trackIds.includes(item.trackId)).map((item) => item.id),
    );
    refuseOverlap(state, edit.trackIds, 'clip.overwrite');
    land(state, edit.clips, 'clip.overwrite');
  },

  /* 12.5.5 */
  'clip.join'(state, payload) {
    const { clipIds } = payload;
    if (!Array.isArray(clipIds) || clipIds.some((id) => typeof id !== 'string')) invalid('clipIds must be clip ids');
    const named = unique(clipIds);
    if (named.length < 2) invalid('clip.join needs at least two clips');
    const chain = named.map((id) => clipOf(state, id)).sort((a, b) => a.from - b.from);
    for (let index = 1; index < chain.length; index++) {
      if (!joinable(chain[index - 1], chain[index])) invalid('clip.join: the clips are not contiguous parts of one source at one speed');
    }
    refuseLocked(state, linkedSet(state, named), 'clip.join');
    const first = chain[0];
    const last = chain.at(-1);
    const join = (left, right) => {
      if (left.type !== right.type || left.trackId !== right.trackId) return;
      const { sourceEnd: _end, trimEnd: _trim, ...rest } = left;
      replace(state, {
        ...rest,
        durationInFrames: end(right) - left.from,
        ...(right.sourceEnd === undefined ? {} : { sourceEnd: right.sourceEnd }),
        ...(right.trimEnd === undefined ? {} : { trimEnd: right.trimEnd }),
      });
      state.items = state.items.filter((item) => item.id !== right.id);
      state.transitions = state.transitions
        .map((transition) => ({
          ...transition,
          leftClipId: transition.leftClipId === right.id ? left.id : transition.leftClipId,
          rightClipId: transition.rightClipId === right.id ? left.id : transition.rightClipId,
        }))
        .filter((transition) => transition.leftClipId !== transition.rightClipId);
      dropKeyframes(state, new Set([right.id]));
    };
    for (const part of chain.slice(1)) {
      const [left, right] = [clipOf(state, first.id), clipOf(state, part.id)];
      const other = counterparts(state, left, right);
      join(left, right);
      if (other) join(...other);
      repair(state, [left.id, ...(other ? [other[0].id] : [])]);
    }
    const joined = clipOf(state, first.id);
    if (joined.durationInFrames !== end(last) - first.from) failed('clip.join: the parts could not be joined');
    for (const member of linkedGroup(state, joined)) {
      if (member.durationInFrames !== joined.durationInFrames) failed('clip.join: a linked part was not joined with its clip');
    }
  },

  /* 12.6.1 */
  'clip.setLink'(state, payload, draw) {
    const { clipIds, linked } = payload;
    if (!Array.isArray(clipIds) || clipIds.length === 0 || clipIds.some((id) => typeof id !== 'string'))
      invalid('clipIds must be clip ids');
    if (typeof linked !== 'boolean') invalid('linked must be a boolean');
    const named = unique(clipIds);
    for (const id of named) clipOf(state, id);
    const members = unique(named.flatMap((id) => linkedGroup(state, clipOf(state, id)).map((member) => member.id)));
    if (linked) {
      if (named.length < 2) invalid('clip.setLink: linking needs at least two clips');
      const existing = linkedGroup(state, clipOf(state, members[0])).map((member) => member.id);
      if (existing.length === members.length && members.every((id) => existing.includes(id)))
        failed('clip.setLink: these clips cannot be linked');
      const group = draw();
      for (const id of members) {
        const { embeddedAudioMuted: _muted, ...rest } = clipOf(state, id);
        replace(state, { ...(rest.type === 'video' ? rest : clipOf(state, id)), linkedGroupId: group });
      }
      return;
    }
    const grouped = members.map((id) => clipOf(state, id)).filter((member) => member.linkedGroupId);
    for (const member of grouped) {
      const hasSound =
        member.type === 'video' && grouped.some((other) => other.type === 'audio' && other.linkedGroupId === member.linkedGroupId);
      replace(state, { ...member, linkedGroupId: member.id, ...(hasSound ? { embeddedAudioMuted: true } : {}) });
    }
  },

  /* 13.9 */
  'clip.setAudio'(state, payload) {
    const clip = namedClip(state, payload);
    if (clip.type !== 'video' && clip.type !== 'audio') invalid('clip.setAudio applies to video and audio clips');
    for (const key of Object.keys(payload)) {
      if (!['clipId', 'volume', 'fadeIn', 'fadeOut', 'muted', 'pitchSemitones', 'pitchCents', 'eq'].includes(key))
        invalid(`clip.setAudio: unknown field "${key}"`);
    }
    const updates = {};
    if (payload.volume !== undefined) {
      if (!finite(payload.volume)) invalid('volume must be a number');
      if (payload.volume < -60 || payload.volume > 12) invalid('volume must be in -60..12 dB');
      updates.volume = payload.volume;
    }
    for (const [field, property] of [['fadeIn', 'audioFadeIn'], ['fadeOut', 'audioFadeOut']]) {
      const time = payload[field];
      if (time === undefined) continue;
      if (!isRational(time)) invalid(`${field} must be an exact rational duration`);
      if (time.num < 0 || BigInt(time.num) > 5n * BigInt(time.den)) invalid(`${field} must be in 0..5 seconds`);
      updates[property] = time.num / time.den;
    }
    for (const [field, property, min, max] of [['pitchSemitones', 'audioPitchSemitones', -12, 12], ['pitchCents', 'audioPitchCents', -100, 100]]) {
      const value = payload[field];
      if (value === undefined) continue;
      if (!finite(value)) invalid(`${field} must be a number`);
      if (!Number.isInteger(value) || value < min || value > max) invalid(`${field} must be an integer in ${min}..${max}`);
      updates[property] = value;
    }
    if (payload.eq !== undefined) Object.assign(updates, clipAudioEqPatch(payload.eq));
    if (payload.muted !== undefined) {
      if (typeof payload.muted !== 'boolean') invalid('muted must be a boolean');
      updates.muted = payload.muted;
    }
    if (Object.keys(updates).length === 0) invalid('clip.setAudio needs volume, fadeIn, fadeOut, pitch, eq or muted');
    refuseLocked(state, [clip.id], 'clip.setAudio');
    replace(state, { ...clip, ...updates });
  },

  /* 12.6.2 */
  'clip.update'(state, payload) {
    const clip = namedClip(state, payload);
    const { patch } = payload;
    if (!patch || typeof patch !== 'object') invalid('patch is required');
    const allowed = ['name', 'text', 'style', 'position', 'animation', 'volume', 'muted', 'transform'];
    for (const key of Object.keys(patch)) if (!allowed.includes(key)) invalid(`patch: unknown field "${key}"`);
    const next = { ...clip };
    if (patch.name !== undefined) {
      if (typeof patch.name !== 'string') invalid('name must be a string');
      next.label = patch.name;
    }
    for (const key of ['text', 'style', 'position', 'animation']) {
      if (patch[key] !== undefined && clip.type !== 'text') invalid(`patch.${key} applies to titles only`);
    }
    if (patch.text !== undefined) {
      if (typeof patch.text !== 'string') invalid('text must be a string');
      next.text = patch.text;
    }
    let styled = next;
    if (patch.style !== undefined) {
      if (typeof patch.style !== 'string') invalid('style must be a string');
      styled = withStyle(state, next, patch.style);
    }
    if (patch.position !== undefined) {
      const match = typeof patch.position === 'string' ? /^([tmb])([lcr])$/.exec(patch.position) : null;
      if (!match) invalid('position: unknown title position');
      styled.verticalAlign = { t: 'top', m: 'middle', b: 'bottom' }[match[1]];
      styled.textAlign = { l: 'left', c: 'center', r: 'right' }[match[2]];
    }
    if (patch.animation !== undefined) {
      if (typeof patch.animation !== 'string') invalid('animation must be a string');
      styled.textMotion = titleMotion(patch.animation);
    }
    if (patch.volume !== undefined) {
      if (clip.type !== 'video' && clip.type !== 'audio') invalid('patch.volume applies to video and audio clips');
      if (typeof patch.volume !== 'number' || !Number.isFinite(patch.volume)) invalid('volume must be a number');
      styled.volume = patch.volume;
    }
    if (patch.muted !== undefined) {
      if (clip.type !== 'video' && clip.type !== 'audio') invalid('patch.muted applies to video and audio clips');
      if (typeof patch.muted !== 'boolean') invalid('patch.muted must be a boolean');
      refuseLocked(state, [clip.id], 'clip.update');
      styled.muted = patch.muted;
    }
    replace(state, styled);
    if (patch.transform !== undefined) {
      if (!patch.transform || typeof patch.transform !== 'object') invalid('patch.transform must be an object');
      setTransform(state, styled, patch.transform);
    }
  },

  /* 17: source admission happens before this isolated graph operation. */
  'media.relink'(state, payload) {
    const oldId = text(payload, 'mediaId');
    const newId = text(payload, 'assetId');
    const source = state.media.get(newId) ?? invalid(`assetId: "${newId}" is not media this session may use`);
    for (const owner of [{ items: state.items, fps: state.fps }, ...state.compositions]) {
      for (const item of owner.items) {
        if (item.mediaId !== oldId) continue;
        const accepts = item.type === 'lottie' ? source.mimeType === 'application/lottie+json' : item.type === 'image' ? source.mimeType.startsWith('image/')
          : item.type === 'video' ? source.mimeType.startsWith('video/')
          : item.type === 'audio' && (source.mimeType.startsWith('audio/') || (source.mimeType.startsWith('video/') && !!source.audioCodec));
        if (!accepts) invalid('The replacement does not contain the media this clip needs');
        if (item.type !== 'audio' && (!Number.isFinite(source.width) || source.width <= 0 || !Number.isFinite(source.height) || source.height <= 0)) invalid('The replacement source dimensions could not be read');
        if (item.type === 'lottie') {
          const frames = source.duration * source.fps;
          const start = item.segmentStart ?? 0;
          const end = item.segmentEnd ?? item.totalFrames - 1;
          if (!(source.fps > 0 && Number.isFinite(frames) && frames > 0) || item.frameRate !== source.fps) invalid('Choose a replacement with the same animation frame rate to preserve the cuts');
          if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start || end >= frames) invalid('The replacement is too short for an existing animation segment');
          item.frameRate = source.fps;
          item.totalFrames = Math.round(frames);
        }
        if (item.type === 'audio' || item.type === 'video') {
          const rate = item.sourceFps ?? (source.fps || owner.fps || state.fps);
          if (!(Number.isFinite(source.duration) && source.duration > 0 && Number.isFinite(rate) && rate > 0)) invalid('The replacement source duration could not be read');
          if (source.fps > 0 && Math.abs(rate - source.fps) > 1e-6) invalid('Choose a replacement with the same source frame rate to preserve the cuts');
          const start = item.sourceStart ?? item.trimStart ?? item.offset ?? 0;
          const end = item.sourceEnd ?? item.sourceDuration ?? start + item.durationInFrames * rate / (owner.fps || state.fps) * Math.abs(item.speed ?? 1);
          if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start || end > source.duration * rate + 1e-6) invalid('The replacement is too short for an existing source range');
          item.sourceDuration = Math.round(source.duration * rate);
          item.sourceFps = rate;
        }
        item.mediaId = newId;
        item.sourceWidth = source.width;
        item.sourceHeight = source.height;
        for (const key of Object.keys(item)) if (key.startsWith('reverseConform') || ['src', 'audioSrc', 'thumbnailUrl', 'waveformData', 'transcriptCaptions'].includes(key)) delete item[key];
      }
    }
  },

  'lottie.update'(state, payload) {
    const id = text(payload, 'clipId');
    const clip = state.items.find((entry) => entry.id === id);
    if (!clip) invalid(`clipId: clip "${id}" does not exist`);
    if (clip.type !== 'lottie') invalid('lottie.update requires a Lottie clip');
    refuseLocked(state, [clip.id], 'lottie.update');
    for (const key of Object.keys(payload)) {
      if (!['clipId', 'colors', 'text', 'slots'].includes(key)) invalid('lottie.update: unknown field');
    }
    const next = { ...clip };
    let supplied = false;
    for (const [field, saved] of [['colors', 'colorOverrides'], ['text', 'textOverrides'], ['slots', 'slotOverrides']]) {
      if (!Object.hasOwn(payload, field)) continue;
      supplied = true;
      const map = payload[field];
      if (!map || typeof map !== 'object' || Array.isArray(map) ||
        (Object.getPrototypeOf(map) !== Object.prototype && Object.getPrototypeOf(map) !== null)) invalid(`lottie.update: ${field} must be a map`);
      const entries = Object.entries(map);
      for (const [key, value] of entries) {
        if (key.length === 0) invalid(`lottie.update: ${field} keys must be nonempty`);
        if (field === 'colors' && (typeof value !== 'string' || !/^#[0-9A-Fa-f]{6}$/.test(value))) invalid('lottie.update: colors must be #rrggbb strings');
        if (field === 'text' && typeof value !== 'string') invalid('lottie.update: text values must be strings');
        if (field === 'slots') {
          const values = Array.isArray(value) ? [value[0], value[1]] : [value];
          if ((Array.isArray(value) && value.length !== 2) || values.some((entry) => typeof entry !== 'number' || !Number.isFinite(entry))) invalid('lottie.update: slots must be finite numbers or [x, y] pairs');
        }
      }
      if (!entries.length) delete next[saved];
      else next[saved] = structuredClone(map);
    }
    if (!supplied) invalid('lottie.update needs colors, text or slots');
    replace(state, next);
  },

  /* 17.1 (FL-348) */
  'clip.setMask'(state, payload) {
    for (const key of Object.keys(payload)) if (key !== 'clipId' && key !== 'mask') invalid('clip.setMask: unknown field');
    const id = text(payload, 'clipId');
    const clip = state.items.find((entry) => entry.id === id) ?? invalid(`clipId: clip "${id}" does not exist`);
    if (clip.type !== 'shape') invalid('clip.setMask requires a shape clip');
    if (!Object.hasOwn(payload, 'mask')) invalid('mask is required (null removes the mask)');
    const mask = payload.mask;
    const plain = (value) => !!value && typeof value === 'object' && !Array.isArray(value) &&
      (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
    if (mask !== null && !plain(mask)) invalid('clip.setMask: mask must be an object or null');
    refuseLocked(state, [clip.id], 'clip.setMask');
    const wasMask = clip.isMask === true;
    if (mask === null) {
      if (!wasMask) return;
      const { blendMode, maskType, maskFeather, maskOpacity, maskInvert, pathClosed, ...rest } = clip;
      replace(state, { ...rest, isMask: false });
      return;
    }
    for (const key of Object.keys(mask)) if (!['type', 'feather', 'opacity', 'invert', 'path'].includes(key)) invalid('clip.setMask: unknown mask field');
    let path;
    if (mask.path !== undefined) {
      if (clip.shapeType !== 'path') invalid('clip.setMask: path needs a path shape');
      if (!Array.isArray(mask.path) || mask.path.length < 3 || mask.path.length > 1000) invalid('clip.setMask: path must have 3 to 1000 vertices');
      const pair = (entry) => {
        if (!Array.isArray(entry) || entry.length !== 2 || !entry.every((n) => typeof n === 'number' && Number.isFinite(n))) invalid('clip.setMask: a vertex position or handle must be [x, y]');
        return [entry[0], entry[1]];
      };
      path = mask.path.map((vertex) => {
        if (!plain(vertex)) invalid('clip.setMask: a vertex must be an object');
        for (const key of Object.keys(vertex)) if (!['position', 'inHandle', 'outHandle', 'tangentMode'].includes(key)) invalid('clip.setMask: unknown vertex field');
        const position = pair(vertex.position);
        const inHandle = pair(vertex.inHandle);
        const outHandle = pair(vertex.outHandle);
        if (vertex.tangentMode !== undefined && !['corner', 'smooth', 'continuous', 'broken'].includes(vertex.tangentMode)) invalid('clip.setMask: unknown tangent mode');
        const tangentMode = vertex.tangentMode ?? ([...inHandle, ...outHandle].every((n) => n === 0) ? 'corner' : 'smooth');
        return { position, inHandle, outHandle, tangentMode };
      });
    }
    if (mask.type !== undefined && mask.type !== 'clip' && mask.type !== 'alpha') invalid('clip.setMask: type must be "clip" or "alpha"');
    for (const name of ['feather', 'opacity']) {
      if (mask[name] !== undefined && !(typeof mask[name] === 'number' && Number.isFinite(mask[name]) && mask[name] >= 0 && mask[name] <= 100)) invalid(`clip.setMask: ${name} must be a number from 0 to 100`);
    }
    if (mask.invert !== undefined && typeof mask.invert !== 'boolean') invalid('clip.setMask: invert must be a boolean');
    const current = wasMask
      ? { type: clip.maskType ?? 'clip', feather: clip.maskFeather ?? 10, opacity: clip.maskOpacity ?? 100, invert: clip.maskInvert ?? false }
      : { type: 'clip', feather: 0, opacity: 100, invert: false };
    const type = mask.type ?? current.type;
    const feather = mask.feather ?? (type === current.type ? current.feather : type === 'alpha' ? (current.feather > 0 ? current.feather : 10) : 0);
    replace(state, {
      ...clip,
      isMask: true,
      blendMode: 'normal',
      maskType: type,
      maskFeather: feather,
      maskOpacity: mask.opacity ?? current.opacity,
      maskInvert: mask.invert ?? current.invert,
      ...(wasMask ? {} : { pathClosed: true }),
      ...(path ? { pathVertices: path } : {}),
    });
  },

  /* 17.2 (FL-348) */
  'clip.relink'(state, payload) {
    for (const key of Object.keys(payload)) if (key !== 'clipId' && key !== 'assetId') invalid('clip.relink: unknown field');
    const id = text(payload, 'clipId');
    const clip = state.items.find((entry) => entry.id === id) ?? invalid(`clipId: clip "${id}" does not exist`);
    const assetId = text(payload, 'assetId');
    if (!['video', 'audio', 'image'].includes(clip.type) || !clip.mediaId) invalid('clip.relink requires a library media clip');
    const record = state.media.get(assetId) ?? invalid(`assetId: "${assetId}" is not media this session may use`);
    const kind = record.mimeType.startsWith('image/') ? 'image' : record.mimeType.startsWith('video/') ? 'video' : invalid(`assetId: unsupported media type ${record.mimeType}`);
    const targets = synchronised(state, clip).filter((member) => member.mediaId === clip.mediaId);
    for (const target of targets) {
      if (target.type === 'image' && kind !== 'image') invalid('assetId: an image clip needs an image');
      if (target.type === 'video' && kind !== 'video') invalid('assetId: a video clip needs a video');
      if (target.type === 'audio' && (kind !== 'video' || !record.audioCodec)) invalid('assetId: an audio clip needs a video with sound');
    }
    refuseLocked(state, targets.map((target) => target.id), 'clip.relink');
    if (clip.mediaId === assetId) return;
    for (const target of targets) {
      const { thumbnailUrl, waveformData, ...next } = target;
      Object.assign(next, { mediaId: assetId, label: record.fileName });
      if (target.type !== 'audio' && record.width > 0 && record.height > 0) Object.assign(next, { sourceWidth: record.width, sourceHeight: record.height });
      if (target.type !== 'image') {
        const rate = round3(record.fps || state.fps);
        const previous = target.sourceFps ?? state.fps;
        const sourceDuration = Math.max(1, Math.round(record.duration * rate));
        const start = target.sourceStart ?? 0;
        const stop = target.sourceEnd ?? start;
        const sourceStart = rate === previous ? start : Math.round((start * rate) / previous);
        const sourceEnd = rate === previous ? stop : Math.round((stop * rate) / previous);
        if (sourceEnd > sourceDuration || sourceEnd <= sourceStart) failed("clip.relink: the asset does not cover the clip's source window");
        Object.assign(next, { sourceFps: rate, sourceDuration, sourceStart, sourceEnd });
      }
      replace(state, next);
    }
  },

  /* 12.6.3 */
  'clip.setTransform'(state, payload) {
    const clip = namedClip(state, payload);
    if (!payload.transform || typeof payload.transform !== 'object') invalid('transform is required');
    setTransform(state, clip, payload.transform);
  },

  /* 12.6.4 */
  'clip.setTransformParent'(state, payload) {
    const child = namedClip(state, payload);
    const { parentId } = payload;
    if (parentId !== null && parentId !== undefined && typeof parentId !== 'string') invalid('parentId must be a clip id or null');
    const parent = typeof parentId === 'string' ? clipOf(state, parentId) : undefined;
    const excluded = (clip) => clip.type === 'audio' || clip.type === 'adjustment';
    if (excluded(child) || (parent && (excluded(parent) || parent.id === child.id))) failed('clip.setTransformParent: not allowed');
    for (let current = parent; current; current = state.items.find((item) => item.id === current.transformParent?.parentItemId)) {
      if (current.id === child.id) failed('clip.setTransformParent: the parent would create a cycle');
    }
    if (child.transformParent?.parentItemId === parent?.id) failed('clip.setTransformParent: nothing would change');
    if (
      child.transformParent ||
      parent?.transformParent ||
      state.keyframes.some((entry) => [child.id, parent?.id].includes(entry.itemId)) ||
      [child, parent].some((clip) => (clip?.motionModifiers?.length ?? 0) > 0)
    ) {
      throw new Unspecified('poses of animated or already-parented clips are engine arithmetic (13.2.7)');
    }
    const pose = (clip) => {
      const size = fitted(state, clip);
      const { x = 0, y = 0, width = size.width, height = size.height, rotation = 0 } = clip.transform ?? {};
      return { x, y, width, height, rotation };
    };
    replace(state, {
      ...child,
      transformParent: {
        ...(parent ? { parentItemId: parent.id, parentReference: pose(parent) } : {}),
        childLocalReference: pose(child),
        childWorldReference: pose(child),
      },
    });
  },

  /* 12.7 */
  'track.add': trackList,
  'track.reorder': trackList,
  'track.set': trackList,

  /* 13.10 */
  'track.setAudio'(state, payload) {
    const track = namedTrack(state, payload);
    if (track.isGroup) invalid('track.setAudio applies to media tracks, not organizational groups');
    for (const key of Object.keys(payload)) {
      if (!['trackId', 'gainDb', 'pan', 'eq', 'gainEnvelope'].includes(key)) invalid(`track.setAudio: unknown field "${key}"`);
    }
    const updates = {};
    if(payload.gainEnvelope!==undefined){
      if(!Array.isArray(payload.gainEnvelope)||payload.gainEnvelope.length>4096) invalid('Invalid track gainEnvelope');
      const ids=new Set(),frames=new Set();
      updates.gainEnvelope=payload.gainEnvelope.map(point=>{
        if(!point||typeof point!=='object'||Array.isArray(point)||Object.keys(point).some(k=>!['id','at','gainDb'].includes(k))) invalid('Invalid track gainEnvelope');
        const id=text(point,'id'),frame=time(state,point,'at'),gainDb=point.gainDb;
        if(point.at.num<0 || (BigInt(point.at.num)*BigInt(state.rate.num))%(BigInt(point.at.den)*BigInt(state.rate.den))!==0n) invalid('Track gain point must be on an exact frame');
        if([...id].length>128||ids.has(id)||frames.has(frame)||!finite(gainDb)||gainDb< -60||gainDb>12) invalid('Invalid track gainEnvelope');
        ids.add(id);frames.add(frame);return {id,frame,gainDb};
      }).sort((a,b)=>a.frame-b.frame);
    }
    if (payload.gainDb !== undefined) {
      if (!finite(payload.gainDb)) invalid('gainDb must be a number');
      if (payload.gainDb < -60 || payload.gainDb > 12) invalid('gainDb must be in -60..12 dB');
      updates.volume = payload.gainDb;
    }
    if (payload.eq !== undefined) updates.audioEq = audioEqSettings(payload.eq);
    if (payload.pan !== undefined) {
      if (!finite(payload.pan)) invalid('pan must be a number');
      if (payload.pan < -1 || payload.pan > 1) invalid('pan must be in -1..1');
      updates.pan = payload.pan;
    }
    if (Object.keys(updates).length === 0) invalid('track.setAudio needs gainDb, pan or eq');
    if (track.locked) failed('track.setAudio: the track is locked');
    state.tracks = state.tracks.map((candidate) => candidate.id === track.id ? { ...candidate, ...updates } : candidate);
  },

  'track.remove'(state, payload) {
    const track = namedTrack(state, payload);
    if (track.locked) failed('track.remove: the track is locked');
    if (state.tracks.length === 1) invalid('track.remove: a sequence keeps at least one track');
    const onTrack = state.items.filter((item) => item.trackId === track.id).map((item) => item.id);
    removeClips(state, linkedSet(state, onTrack, false));
    state.tracks = applyTrackCommand(state.tracks, { id: 'track.remove', payload });
  },

  'track.closeGap'(state, payload, draw) {
    const track = namedTrack(state, payload);
    if (track.locked) failed('track.closeGap: the track is locked');
    const onTrack = () => state.items.filter((item) => item.trackId === track.id).sort((a, b) => a.from - b.from);
    if (payload.at === undefined) {
      const linked = linkedSet(state, onTrack().map((item) => item.id));
      refuseLocked(
        state,
        linked,
        'track.closeGap',
      );
      let cursor = 0;
      const base = new Map();
      for (const item of onTrack()) {
        const from = Math.min(item.from, cursor);
        if (item.from - from > 0) base.set(item.id, item.from - from);
        cursor = from + item.durationInFrames;
      }
      const shift = new Map(base);
      const seen = new Set();
      for (const item of state.items) {
        if (seen.has(item.id)) continue;
        const group = linkedGroup(state, item);
        for (const member of group) seen.add(member.id);
        if (group.length <= 1) continue;
        const most = Math.max(0, ...group.map((member) => base.get(member.id) ?? 0));
        if (most > 0) for (const member of group) shift.set(member.id, most);
      }
      for (const [id, amount] of [...shift]) {
        for (const caption of captionsOf(state, clipOf(state, id))) shift.set(caption.id, Math.max(shift.get(caption.id) ?? 0, amount));
      }
      const moves = state.items
        .filter((item) => (shift.get(item.id) ?? 0) > 0)
        .map((item) => ({ id: item.id, from: item.from - shift.get(item.id) }));
      if (moves.some((entry) => entry.from < 0)) failed('track.closeGap: clips would start before the timeline');
      for (const entry of moves) move(state, entry.id, entry.from);
      repair(
        state,
        moves.map((entry) => entry.id),
      );
      refuseOverlap(state, linked.map((id) => clipOf(state, id).trackId), 'track.closeGap');
      let expected = 0;
      for (const item of onTrack()) {
        if (item.from !== expected) failed('track.closeGap: a gap could not be closed');
        expected += item.durationInFrames;
      }
      return;
    }
    const frame = time(state, payload, 'at');
    let [a, b] = [0, undefined];
    for (const item of onTrack()) {
      if (frame >= a && frame < item.from) {
        b = item.from;
        break;
      }
      a = Math.max(a, end(item));
    }
    if (b === undefined || b <= a) invalid('track.closeGap: there is no gap on the track at that time');
    const later = state.items.filter((item) => item.trackId === track.id && item.from >= b);
    const before = structuredClone(state.items);
    const beforeById = new Map(before.map((item) => [item.id, item]));
    const linked = linkedSet(state, later.map((item) => item.id));
    refuseLocked(state, linked, 'track.closeGap');
    const moves = linked.map((id) => ({ id, from: beforeById.get(id).from - (b - a) }));
    if (moves.some((entry) => entry.from < 0)) failed('track.closeGap: clips would start before the timeline');
    const affectedTracks = new Set([
      ...linked.map((id) => beforeById.get(id).trackId),
      ...before.filter((item) => syncEnabled(trackOf(state, item.trackId))).map((item) => item.trackId),
    ]);
    for (const item of later) move(state, item.id, item.from - (b - a));
    const affected = removeIntervals(state, new Set([track.id]), [{ start: a, end: b }], draw);
    repair(state, [...later.map((item) => item.id), ...affected]);
    for (const id of linked) {
      const original = beforeById.get(id);
      const current = state.items.find((item) => item.id === id);
      if (!current || canonicalJson(current) !== canonicalJson({ ...original, from: current.from })) {
        failed('track.closeGap: sync lock would change a linked source window');
      }
    }
    const corrections = moves.filter((entry) => clipOf(state, entry.id).from !== entry.from);
    for (const entry of corrections) move(state, entry.id, entry.from);
    if (corrections.length > 0) repair(state, corrections.map((entry) => entry.id));
    for (const entry of moves) {
      if (canonicalJson(clipOf(state, entry.id)) !== canonicalJson({ ...beforeById.get(entry.id), from: entry.from })) {
        failed('track.closeGap: a linked item could not close the gap without changing its source data');
      }
    }
    refuseOverlap(state, affectedTracks, 'track.closeGap');
  },

  /* 12.8 */
  'marker.add': markers,
  'marker.update': markers,
  'marker.remove': markers,
  'music.add'() {
    failed('music: the music catalogue is not available in this build');
  },
};

/* 12.4.1 */
function trim(state, payload, draw, edge) {
  const clip = namedClip(state, payload);
  const target = time(state, payload, edge);
  const amount = edge === 'start' ? target - clip.from : target - end(clip);
  if (amount === 0) return;
  if (edge === 'start' ? target >= end(clip) : target <= clip.from)
    invalid(edge === 'start' ? 'start must be before the clip ends' : 'end must be after the clip starts');
  const refuse = () => failed(`clip.trim: the requested ${edge} exceeds the source or timeline limits`);
  const trimmed = synchronised(state, clip);
  const apply = (member) => (edge === 'start' ? trimmedStart(state, member, amount) : trimmedEnd(state, member, amount)) ?? refuse();

  if (payload.ripple !== true) {
    for (const member of trimmed) {
      // The neighbour limit: clips joined to this one by a transition do not count.
      const joined = new Set(
        state.transitions.flatMap((transition) =>
          transition.leftClipId === member.id
            ? [transition.rightClipId]
            : transition.rightClipId === member.id
              ? [transition.leftClipId]
              : [],
        ),
      );
      const others = state.items.filter((item) => item.trackId === member.trackId && item.id !== member.id && !joined.has(item.id));
      if (edge === 'end' && amount > 0) {
        const nearest = Math.min(...others.filter((item) => item.from >= end(member)).map((item) => item.from));
        if (end(member) + amount > nearest) refuse();
      }
      if (edge === 'start' && amount < 0) {
        const nearest = Math.max(...others.filter((item) => end(item) <= member.from).map(end));
        if (member.from + amount < nearest) refuse();
      }
    }
    for (const next of trimmed.map(apply)) replace(state, next);
    const shortened = edge === 'start' ? amount > 0 : amount < 0;
    if (shortened) {
      for (const member of trimmed.map((item) => clipOf(state, item.id))) {
        for (const caption of captionsOf(state, member)) {
          const from = Math.max(caption.from, member.from);
          const stop = Math.min(end(caption), end(member));
          if (stop <= from) removeClips(state, [caption.id]);
          else replace(state, { ...caption, from, durationInFrames: stop - from });
        }
      }
    }
    repair(
      state,
      trimmed.map((member) => member.id),
    );
    return;
  }

  const ids = new Set(trimmed.map((member) => member.id));
  const shift = edge === 'end' ? amount : -amount;
  // What moves with each trimmed clip: later clips on its track, and the incoming clip of a transition out of it.
  const downstream = (member) => {
    const partners = new Set(
      state.transitions.filter((transition) => transition.leftClipId === member.id).map((transition) => transition.rightClipId),
    );
    return state.items.filter(
      (item) => !ids.has(item.id) && item.trackId === member.trackId && (item.from >= end(member) || partners.has(item.id)),
    );
  };
  const preview = new Map();
  for (const member of trimmed) {
    const next = apply(member);
    preview.set(member.id, edge === 'start' ? { ...next, from: member.from } : next);
    for (const item of downstream(member)) preview.set(item.id, { ...item, from: item.from + shift });
  }
  if (!transitionsStayValid(state, preview)) refuse();
  const oldEnd = end(clip);
  for (const next of preview.values()) replace(state, next);
  const edited = new Set(trimmed.map((member) => member.trackId));
  const affected =
    shift < 0
      ? removeIntervals(state, edited, [{ start: oldEnd + shift, end: oldEnd }], draw)
      : openGaps(state, edited, oldEnd, shift, draw);
  const after = trimmed.map((member) => clipOf(state, member.id));
  const onTracks = state.items.filter(
    (item) => !ids.has(item.id) && after.some((member) => item.trackId === member.trackId && item.from >= member.from),
  );
  repair(state, [...ids, ...affected, ...onTracks.map((item) => item.id)]);
}

/* 12.6.3 */
function fitted(state, clip) {
  const record = state.media.get(clip.mediaId);
  const size =
    clip.type === 'video' || clip.type === 'image'
      ? clip.sourceWidth && clip.sourceHeight
        ? { width: clip.sourceWidth, height: clip.sourceHeight }
        : record?.width && record?.height
          ? { width: record.width, height: record.height }
          : state.canvas
      : clip.type === 'composition' && clip.compositionWidth && clip.compositionHeight
        ? { width: clip.compositionWidth, height: clip.compositionHeight }
        : state.canvas;
  const fit = Math.min(state.canvas.width / size.width, state.canvas.height / size.height);
  return { width: size.width * fit, height: size.height * fit };
}

function setTransform(state, clip, intent) {
  for (const key of Object.keys(intent))
    if (!['x', 'y', 'scale', 'rotation', 'opacity'].includes(key)) invalid(`transform: unknown field "${key}"`);
  const next = {};
  for (const key of ['x', 'y', 'rotation', 'opacity']) {
    if (intent[key] === undefined) continue;
    if (typeof intent[key] !== 'number' || !Number.isFinite(intent[key])) invalid(`transform.${key} must be a number`);
    next[key] = intent[key];
  }
  if (next.opacity !== undefined && (next.opacity < 0 || next.opacity > 1)) invalid('transform.opacity must be between 0 and 1');
  if (intent.scale !== undefined) {
    if (typeof intent.scale !== 'number' || !Number.isFinite(intent.scale) || intent.scale <= 0)
      invalid('transform.scale must be positive');
    const size = fitted(state, clip);
    next.width = size.width * intent.scale;
    next.height = size.height * intent.scale;
  }
  if (Object.keys(next).length === 0) invalid('transform must change something');
  replace(state, { ...clipOf(state, clip.id), transform: { ...clipOf(state, clip.id).transform, ...next } });
}

/* 12.7.1, 12.7.3, 12.7.4 */
function trackList(state, payload, draw, id) {
  if (id === 'track.add') {
    if (payload.kind !== 'video' && payload.kind !== 'audio') invalid('kind must be video or audio');
    const { index, name } = payload;
    if (index !== undefined && (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index > state.tracks.length))
      invalid('index is outside the track list');
    if (name !== undefined && typeof name !== 'string') invalid('name must be a string');
  } else {
    namedTrack(state, payload);
  }
  if (id === 'track.reorder') {
    const { index } = payload;
    if (typeof index !== 'number' || !Number.isInteger(index)) invalid('index must be an integer');
    if (index < 0 || index >= state.tracks.length) invalid('index is outside the track list');
  }
  if (id === 'track.set') {
    const { patch } = payload;
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) invalid('patch is required');
    const flags = ['muted', 'locked', 'solo', 'visible', 'syncLock'];
    for (const key of Object.keys(patch)) if (!['name', 'gain', ...flags].includes(key)) invalid(`patch: unknown field "${key}"`);
    if (Object.keys(patch).length === 0) invalid('patch must change something');
    if (patch.name !== undefined && (typeof patch.name !== 'string' || !patch.name.trim() || patch.name.length > 80))
      invalid('patch.name must be 1 to 80 characters');
    for (const key of flags) if (patch[key] !== undefined && typeof patch[key] !== 'boolean') invalid(`patch.${key} must be a boolean`);
    if (patch.gain !== undefined && (typeof patch.gain !== 'number' || !Number.isFinite(patch.gain) || patch.gain < -60 || patch.gain > 12))
      invalid('patch.gain must be between -60 and 12 dB');
  }
  const next = applyTrackCommand(state.tracks, { id, payload }, draw);
  if (
    id === 'track.set' &&
    payload.patch.name !== undefined &&
    next.find((track) => track.id === payload.trackId).name !== payload.patch.name
  ) {
    failed('track.set: name was not applied');
  }
  state.tracks = next;
}

/* 12.8 */
function markers(state, payload, draw, id) {
  const colour = (value, name) => {
    if (value === undefined) return;
    if (typeof value !== 'string' || !/^#[0-9a-f]{6}$/i.test(value)) invalid(`${name} must be a #rrggbb colour`);
  };
  const label = (value) => {
    if (value === undefined) return;
    if (typeof value !== 'string') invalid('name must be a string');
    if (value.length > 120) invalid('name must be at most 120 characters');
  };
  if (id === 'marker.add') {
    time(state, payload, 'at');
    colour(payload.colour, 'colour');
    label(payload.name);
  } else {
    const markerId = text(payload, 'markerId');
    if (!state.markers.some((marker) => marker.id === markerId)) invalid(`marker "${markerId}" does not exist`);
  }
  if (id === 'marker.update') {
    const { patch } = payload;
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) invalid('patch is required');
    for (const key of Object.keys(patch)) if (!['name', 'colour', 'at'].includes(key)) invalid(`patch: unknown field "${key}"`);
    label(patch.name);
    colour(patch.colour, 'patch.colour');
    if (patch.at !== undefined) time(state, patch, 'at');
    if (Object.keys(patch).length === 0) invalid('patch must change something');
  }
  state.markers = applyMarkerCommand(state.markers, { id, payload }, state.rate, draw);
}

/* ================================================================== */
/* Part 3 (section 13): effects, transitions, keyframes and animation  */
/* ================================================================== */

/* 13.2.4: keyframes entries */

const entryOf = (state, itemId) => state.keyframes.find((entry) => entry.itemId === itemId);
const isVector = (property) => catalogue.properties.vector.includes(property);
const finite = (value, min = -Infinity, max = Infinity) => typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
const plainObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value);

/** Replace a clip's entry (or add it at the end of the list). */
function writeEntry(state, itemId, change) {
  const index = state.keyframes.findIndex((entry) => entry.itemId === itemId);
  const before = index < 0 ? { itemId, animationVersion: 2, properties: [] } : state.keyframes[index];
  const after = change(before);
  if (index < 0) state.keyframes.push(after);
  else state.keyframes[index] = after;
}

/** Optional lists are written only when they hold something (13.2.4). */
function tidy(entry) {
  const next = { ...entry };
  for (const key of ['propertyLinks', 'expressions', 'vectorProperties', 'separatedVectorProperties']) {
    if ((next[key]?.length ?? 0) === 0) delete next[key];
  }
  return next;
}

/** 13.2.4: remove every entry that holds no animation. */
const sweep = (state) => {
  state.keyframes = state.keyframes.filter(holdsAnimation);
};

const byFrame = (keyframes) => keyframes.toSorted((a, b) => a.frame - b.frame);
const without = (object, ...keys) => Object.fromEntries(Object.entries(object).filter(([key]) => !keys.includes(key)));

/* 13.2.3: transition regions */

function inTransitionRegion(state, clip, frame) {
  let head = 0;
  let tail = 0;
  for (const transition of state.transitions) {
    const part = portions(transition.durationInFrames, transition.alignment);
    if (transition.leftClipId === clip.id) tail = part.left;
    if (transition.rightClipId === clip.id) head = part.right;
  }
  if (head + tail > clip.durationInFrames) throw new Unspecified('two transition regions longer than their clip (13.2.3)');
  return (head > 0 && frame < Math.min(head, clip.durationInFrames)) || (tail > 0 && frame >= Math.max(0, clip.durationInFrames - tail));
}

/** A payload time as a frame of the clip (13.2.4). */
function clipFrame(state, clip, payload) {
  const at = time(state, payload, 'at');
  return { at, inside: at >= clip.from && at < end(clip), frame: at - clip.from };
}

/* 13.2.6: easing */

const EASINGS = catalogue.easing.types;

/* 13.2.7: keyframes under a retime */

function rescaleKeyframes(state, itemId, oldLength, newLength) {
  const entry = entryOf(state, itemId);
  if (!entry || oldLength === newLength || oldLength <= 0 || newLength <= 0) return;
  const factor = newLength / oldLength;
  const scale = (keyframes) => {
    const landed = new Map();
    for (const keyframe of keyframes) {
      const frame = Math.min(newLength - 1, Math.max(0, Math.round(keyframe.frame * factor)));
      const there = landed.get(frame);
      // Two keyframes on one frame: the one that was later stays.
      if (!there || keyframe.frame > there.from) landed.set(frame, { from: keyframe.frame, keyframe: { ...keyframe, frame } });
    }
    return byFrame([...landed.values()].map((slot) => slot.keyframe));
  };
  writeEntry(state, itemId, (before) => ({
    ...before,
    properties: before.properties.map((group) => ({ ...group, keyframes: scale(group.keyframes) })),
    ...(before.vectorProperties ? { vectorProperties: before.vectorProperties.map((group) => ({ ...group, keyframes: scale(group.keyframes) })) } : {}),
  }));
}

/* 13.6.1: expressions */

const EXPRESSION_LIMITS = { length: 2048, tokens: 512, depth: 64 };

/** A fault of the frame, not of the expression: it does not refuse the command. */
class FrameFault extends Error {}

function tokensOf(source) {
  if (source.length > EXPRESSION_LIMITS.length) throw new Error('too long');
  const tokens = [];
  let index = 0;
  while (index < source.length) {
    const character = source[index];
    if (/\s/.test(character)) {
      index++;
      continue;
    }
    if (/[0-9.]/.test(character)) {
      let stop = index;
      while (stop < source.length && /[0-9.]/.test(source[stop])) stop++;
      const text = source.slice(index, stop);
      if (text.split('.').length > 2 || text === '.' || !Number.isFinite(Number(text))) throw new Error('invalid number');
      tokens.push({ kind: 'number', text });
      index = stop;
    } else if (/[A-Za-z_]/.test(character)) {
      let stop = index + 1;
      while (stop < source.length && /[A-Za-z0-9_]/.test(source[stop])) stop++;
      tokens.push({ kind: 'name', text: source.slice(index, stop) });
      index = stop;
    } else if (character === '"' || character === "'") {
      let stop = index + 1;
      let text = '';
      while (stop < source.length && source[stop] !== character) {
        if (source[stop] === '\\') stop++;
        if (stop >= source.length) throw new Error('unterminated string');
        text += source[stop];
        stop++;
      }
      if (source[stop] !== character) throw new Error('unterminated string');
      tokens.push({ kind: 'string', text });
      index = stop + 1;
    } else if ('+-*/(),[]'.includes(character)) {
      tokens.push({ kind: 'mark', text: character });
      index++;
    } else throw new Error('unexpected character');
    if (tokens.length > EXPRESSION_LIMITS.tokens) throw new Error('too many tokens');
  }
  tokens.push({ kind: 'end', text: '' });
  return tokens;
}

/**
 * Check an expression as 13.6.1 says: read it left to right with stand-in values, and return the
 * kind of its result (`number` or `vector`), or `undefined` when a fault of the frame stopped the
 * reading. Throws for an error of the expression.
 */
function expressionKind(source, vectorTarget) {
  const tokens = tokensOf(source);
  const standIn = (vector) => (vector ? { x: 1, y: 1 } : 1);
  const vector = (value) => typeof value !== 'number';
  const each = (left, right, operate) => {
    if (vector(left) && vector(right)) return { x: operate(left.x, right.x), y: operate(left.y, right.y) };
    if (vector(left)) return { x: operate(left.x, right), y: operate(left.y, right) };
    if (vector(right)) return { x: operate(left, right.x), y: operate(left, right.y) };
    return operate(left, right);
  };
  const one = (value, operate) => (vector(value) ? { x: operate(value.x), y: operate(value.y) } : operate(value));
  const number = (value) => (vector(value) ? fail('a number is needed') : value);
  const fail = (message) => {
    throw new Error(message);
  };
  let index = 0;
  let depth = 0;
  const peek = () => tokens[index].text;
  const take = (text) => (text !== undefined && tokens[index].text !== text ? fail(`expected ${text}`) : tokens[index++]);

  const additive = () => {
    let value = multiplicative();
    while (peek() === '+' || peek() === '-') {
      const subtract = take().text === '-';
      const right = multiplicative();
      value = each(value, right, subtract ? (a, b) => a - b : (a, b) => a + b);
    }
    return value;
  };
  const multiplicative = () => {
    let value = unary();
    while (peek() === '*' || peek() === '/') {
      const divide = take().text === '/';
      const right = unary();
      if (divide && (vector(right) ? right.x === 0 || right.y === 0 : right === 0)) throw new FrameFault('division by zero');
      value = each(value, right, divide ? (a, b) => a / b : (a, b) => a * b);
    }
    return value;
  };
  const unary = () => {
    if (peek() === '+') {
      take();
      return unary();
    }
    if (peek() === '-') {
      take();
      return one(unary(), (value) => -value);
    }
    depth++;
    if (depth > EXPRESSION_LIMITS.depth) fail('too deep');
    try {
      return primary();
    } finally {
      depth--;
    }
  };
  const primary = () => {
    const token = tokens[index];
    if (token.kind === 'number') return Number(take().text);
    if (token.text === '(' && token.kind === 'mark') {
      take('(');
      const value = additive();
      take(')');
      return value;
    }
    if (token.text === '[' && token.kind === 'mark') {
      take('[');
      const x = number(additive());
      take(',');
      const y = number(additive());
      take(']');
      return { x, y };
    }
    if (token.kind !== 'name') fail('a value is needed');
    const name = take().text;
    if (name === 'value' || name === 'preValue') return standIn(vectorTarget);
    if (name === 'frame' || name === 'time') return 0;
    if (peek() !== '(') fail('unknown name');
    take('(');
    if (name === 'prop') {
      if (tokens[index].kind !== 'string') fail('a quoted clip id is needed');
      take();
      take(',');
      if (tokens[index].kind !== 'string') fail('a quoted property is needed');
      const property = take().text;
      take(')');
      if (!catalogue.properties.expression.includes(property)) fail('unknown property');
      return standIn(isVector(property));
    }
    const values = [];
    if (peek() !== ')') {
      for (;;) {
        values.push(additive());
        if (peek() !== ',') break;
        take(',');
      }
    }
    take(')');
    if (['abs', 'sin', 'cos'].includes(name)) {
      if (values.length !== 1) fail('one argument is needed');
      return one(values[0], { abs: Math.abs, sin: Math.sin, cos: Math.cos }[name]);
    }
    if (name === 'min' || name === 'max') {
      if (values.length < 2) fail('two arguments are needed');
      return values.slice(1).reduce((result, value) => each(result, value, name === 'min' ? Math.min : Math.max), values[0]);
    }
    if (name === 'clamp') {
      if (values.length !== 3) fail('three arguments are needed');
      return each(each(values[0], values[1], Math.max), values[2], Math.min);
    }
    if (name === 'lerp') {
      if (values.length !== 3) fail('three arguments are needed');
      const amount = number(values[2]);
      return each(values[0], values[1], (from, to) => from + (to - from) * amount);
    }
    return fail('unknown function');
  };

  try {
    const result = additive();
    if (tokens[index].kind !== 'end') fail('unexpected token');
    const parts = vector(result) ? [result.x, result.y] : [result];
    if (parts.some((part) => !Number.isFinite(part))) return undefined;
    return vector(result) ? 'vector' : 'number';
  } catch (error) {
    if (error instanceof FrameFault) return undefined;
    throw error;
  }
}

/* 13.6.2: procedural modifiers */

const GAIN_CHANNELS = [...new Set(catalogue.motionModifiers.flatMap((type) => type.channels))];
/** The channels a modifier drives: those of its type whose gain is above 0 (an absent gain is 1). */
function drivenChannels(modifier) {
  const type = catalogue.motionModifiers.find((entry) => entry.id === modifier.type);
  return (type?.channels ?? []).filter((channel) => {
    const gain = modifier.channelGains?.[channel];
    return (finite(gain) ? Math.max(0, Math.min(2, gain)) : 1) > 0;
  });
}

function modifierOf(value, draw) {
  if (!plainObject(value)) invalid('modifier must be an object or null');
  if (!catalogue.motionModifiers.some((type) => type.id === value.type)) invalid('modifier.type is not a modifier type');
  if (!finite(value.amplitude, 0, 2)) invalid('modifier.amplitude must be in 0..2');
  if (!finite(value.frequency, 0.01, 30)) invalid('modifier.frequency must be in 0.01..30');
  const phaseFrames = value.phaseFrames ?? 0;
  if (!finite(phaseFrames, 0, 1_000_000)) invalid('modifier.phaseFrames must be a whole, non-negative number');
  const seed = value.seed ?? 1;
  if (!finite(seed, -1_000_000, 1_000_000)) invalid('modifier.seed must be a number');
  if (value.enabled !== undefined && typeof value.enabled !== 'boolean') invalid('modifier.enabled must be a boolean');
  let channelGains;
  if (value.channelGains !== undefined) {
    if (!value.channelGains || typeof value.channelGains !== 'object') invalid('modifier.channelGains must be an object');
    channelGains = {};
    for (const [channel, gain] of Object.entries(value.channelGains)) {
      if (!GAIN_CHANNELS.includes(channel)) invalid(`modifier.channelGains: unknown channel ${channel}`);
      if (!finite(gain, 0, 2)) invalid(`modifier.channelGains.${channel} must be in 0..2`);
      channelGains[channel] = gain;
    }
  }
  return {
    version: 2,
    id: typeof value.id === 'string' && value.id ? value.id : draw(),
    type: value.type,
    enabled: value.enabled !== false,
    amplitude: value.amplitude,
    frequency: value.frequency,
    phaseFrames: Math.round(phaseFrames),
    seed,
    ...(channelGains ? { channelGains } : {}),
  };
}

/* 13.7.1: text motion */

function textMotionSlot(value, presets) {
  if (!plainObject(value) || typeof value.presetId !== 'string' || !presets.includes(value.presetId)) return undefined;
  const frames = (given, least, fallback) => (finite(given) ? Math.max(least, Math.round(given)) : fallback);
  const offsetFrames = frames(value.offsetFrames, 0, 0);
  const pick = (given, allowed, fallback) => (allowed.includes(given) ? given : fallback);
  const unit = pick(value.unit, ['character', 'word', 'line', 'whole-clip'], undefined);
  return {
    presetId: value.presetId,
    durationFrames: frames(value.durationFrames, 1, 12),
    ...(offsetFrames > 0 ? { offsetFrames } : {}),
    staggerFrames: frames(value.staggerFrames, 0, 0),
    intensity: finite(value.intensity) ? Math.max(0, Math.min(2, value.intensity)) : 1,
    order: pick(value.order, ['forward', 'backward', 'center', 'random'], 'forward'),
    easing: pick(value.easing, ['linear', 'ease-in', 'ease-out', 'ease-in-out', 'overshoot'], 'ease-out'),
    seed: finite(value.seed) ? Math.round(value.seed) : 0,
    ...(unit ? { unit } : {}),
  };
}

/* 13.7.2: Ken Burns */

function kenBurnsRect(value, name) {
  if (!value || typeof value !== 'object') invalid(`kenBurns.${name} must be { x, y, w, h }`);
  for (const key of ['x', 'y', 'w', 'h']) if (!finite(value[key], 0, 1)) invalid(`kenBurns.${name}.${key} must be in 0..1`);
  const { x, y, w, h } = value;
  if (w < 0.2 || h < 0.2) invalid(`kenBurns.${name} must show at least a fifth of the photo`);
  if (Math.abs(w - h) > 1e-9) invalid(`kenBurns.${name} must keep the frame's shape`);
  if (x + w > 1 + 1e-9 || y + h > 1 + 1e-9) invalid(`kenBurns.${name} must lie inside the photo`);
  return { x, y, w, h };
}

/** Add scalar keyframes as 13.5.1 does; returns the ids, or `null` when a transition region blocks one. */
function addScalarKeyframes(state, clip, list, draw) {
  if (list.some((entry) => inTransitionRegion(state, clip, entry.frame))) return null;
  const ids = [];
  for (const { property, frame, value, easing } of list) {
    const id = draw();
    writeEntry(state, clip.id, (before) => {
      const group = before.properties.find((candidate) => candidate.property === property);
      const fresh = { id, frame, value, easing };
      if (!group) {
        ids.push(id);
        return { ...before, animationVersion: 2, properties: [...before.properties, { property, keyframes: [fresh] }] };
      }
      const there = group.keyframes.find((keyframe) => keyframe.frame === frame);
      ids.push(there ? there.id : id);
      const keyframes = there
        ? group.keyframes.map((keyframe) => (keyframe === there ? { ...without(keyframe, 'easingConfig'), value, easing } : keyframe))
        : byFrame([...group.keyframes, fresh]);
      return { ...before, animationVersion: 2, properties: before.properties.map((candidate) => (candidate === group ? { ...group, keyframes } : candidate)) };
    });
  }
  return ids;
}

const vectorOf = (value, name) => {
  if (!value || typeof value !== 'object' || !finite(value.x, -1e9, 1e9) || !finite(value.y, -1e9, 1e9)) invalid(`${name} must be { x, y } numbers`);
  return { x: value.x, y: value.y };
};

const idList = (payload) => {
  const { keyframeIds } = payload;
  if (!Array.isArray(keyframeIds) || keyframeIds.length === 0 || keyframeIds.some((id) => typeof id !== 'string')) invalid('keyframeIds is required');
  return keyframeIds;
};
const groupOf = (state, clip, property) =>
  (isVector(property) ? entryOf(state, clip.id)?.vectorProperties : entryOf(state, clip.id)?.properties)?.find((group) => group.property === property);
const keyframeOf = (state, clip, property, id) =>
  groupOf(state, clip, property)?.keyframes.find((keyframe) => keyframe.id === id) ?? invalid(`keyframe "${id}" is not on ${property}`);
/** Rewrite the keyframes of one property group of a clip. */
function writeGroup(state, clip, property, change, version) {
  const list = isVector(property) ? 'vectorProperties' : 'properties';
  writeEntry(state, clip.id, (before) => ({
    ...before,
    ...(version ? { animationVersion: 2 } : {}),
    [list]: before[list].map((group) => (group.property === property ? { ...group, keyframes: change(group.keyframes) } : group)),
  }));
}

Object.assign(commands, {
  /* 13.3.1 */
  'effect.add'(state, payload, draw) {
    const clip = namedClip(state, payload);
    const effect = text(payload, 'effect');
    if (!catalogue.effects.some((entry) => entry.id === effect)) invalid(`effect: unknown effect "${effect}"`);
    const params = payload.params ?? {};
    if (typeof params !== 'object' || Array.isArray(params)) invalid('params must be an object');
    const { index } = payload;
    if (index !== undefined && (typeof index !== 'number' || !Number.isFinite(index))) invalid('index must be a number');
    const before = clip.effects ?? [];
    if (index !== undefined && (!Number.isInteger(index) || index < 0 || index > before.length)) invalid('index is outside the effect stack');
    // The id is drawn for an audio clip too, and not kept.
    const added = { id: draw(), effect: { type: 'gpu-effect', gpuEffectType: effect, params }, enabled: true };
    if (clip.type === 'audio') return;
    const effects = [...before];
    effects.splice(index ?? before.length, 0, added);
    replace(state, { ...clip, effects });
  },

  /* 13.3.2 */
  'effect.remove'(state, payload) {
    const clip = namedClip(state, payload);
    const effectId = text(payload, 'effectId');
    if (!(clip.effects ?? []).some((effect) => effect.id === effectId)) invalid(`effectId: "${effectId}" is not on this clip`);
    replace(state, { ...clip, effects: clip.effects.filter((effect) => effect.id !== effectId) });
  },

  /* 13.4.1 */
  'clip.setTransition'(state, payload, draw) {
    const clip = namedClip(state, payload);
    const existing = state.transitions.find((transition) => transition.leftClipId === clip.id);
    const intent = payload.transition;
    if (intent === null) {
      if (existing) state.transitions = state.transitions.filter((transition) => transition !== existing);
      return;
    }
    if (!intent || typeof intent !== 'object') invalid('transition must be an object or null');
    if (typeof intent.type !== 'string') invalid('transition.type is required');
    const presentation = catalogue.transitionAliases[intent.type] ?? intent.type;
    if (!catalogue.transitions.some((entry) => entry.id === presentation)) invalid(`transition: unknown type "${intent.type}"`);
    const length = time(state, intent, 'duration');
    if (length < 1) invalid('transition.duration must be at least one frame');
    if (existing) {
      const left = clipOf(state, existing.leftClipId);
      const right = state.items.find((item) => item.id === existing.rightClipId);
      if (right && !transitionValid(state, left, right, { ...existing, durationInFrames: length })) {
        // Nothing is written. Asking for the length it already has is not noticed as a failure.
        if (existing.durationInFrames !== length) failed('clip.setTransition: the clips do not have enough handle for that length');
        return;
      }
      state.transitions = state.transitions.map((transition) => (transition === existing ? { ...existing, durationInFrames: length, presentation } : transition));
      return;
    }
    const next = state.items
      .filter((item) => item.trackId === clip.trackId && item.id !== clip.id && item.from >= end(clip) - 1)
      .sort((a, b) => a.from - b.from)[0];
    if (!next) invalid('clip.setTransition: no clip follows this one on its track');
    const refuse = () => failed('clip.setTransition: the clips cannot share a transition');
    const most = Math.min(clip.durationInFrames, next.durationInFrames) - 1;
    if (most < 1) refuse();
    let fitted = Math.max(1, Math.min(length, most));
    if (Math.abs(end(clip) - next.from) <= 1) {
      const byHandles = longestByHandles(state, clip, next, 0.5);
      if (byHandles < 1) refuse();
      fitted = Math.min(fitted, byHandles);
    }
    const added = {
      id: draw(),
      leftClipId: clip.id,
      rightClipId: next.id,
      trackId: clip.trackId,
      type: 'crossfade',
      durationInFrames: fitted,
      presentation,
      timing: 'linear',
      alignment: 0.5,
    };
    if (!transitionValid(state, clip, next, added)) refuse();
    state.transitions = [...state.transitions, added];
  },

  /* 13.5.1 */
  'keyframe.add'(state, payload, draw) {
    const clip = namedClip(state, payload);
    const property = text(payload, 'property');
    const { frame, inside } = clipFrame(state, clip, payload);
    const easingText = () => {
      if (payload.easing !== undefined && typeof payload.easing !== 'string') invalid('easing must be a string');
      return payload.easing;
    };
    if (isVector(property)) {
      if (!inside) invalid('at must fall inside the clip');
      const easing = easingText();
      if (easing !== undefined && !EASINGS.includes(easing)) invalid('easing is not an easing type');
      const value = vectorOf(payload.value, 'value');
      const id = draw();
      if (inTransitionRegion(state, clip, frame)) failed('keyframe.add: keyframes cannot be placed inside a transition');
      const fresh = { id, frame, value, easing: easing ?? 'linear' };
      writeEntry(state, clip.id, (before) => {
        const groups = before.vectorProperties ?? [];
        const group = groups.find((candidate) => candidate.property === property);
        if (!group) return { ...before, animationVersion: 2, vectorProperties: [...groups, { property, keyframes: [fresh] }] };
        const there = group.keyframes.find((keyframe) => keyframe.frame === frame);
        // A keyframe on a taken frame is replaced whole and keeps the old id.
        const keyframes = there
          ? group.keyframes.map((keyframe) => (keyframe === there ? { ...fresh, id: there.id } : keyframe))
          : byFrame([...group.keyframes, fresh]);
        return { ...before, animationVersion: 2, vectorProperties: groups.map((candidate) => (candidate === group ? { ...group, keyframes } : candidate)) };
      });
      return;
    }
    const value = payload.value?.value;
    if (!finite(value)) invalid('value must be { value: number }');
    const easing = easingText();
    if (!inside) invalid('at must fall inside the clip');
    if (addScalarKeyframes(state, clip, [{ property, frame, value, easing: easing ?? 'linear' }], draw) === null)
      failed('keyframe.add: keyframes cannot be placed inside a transition');
  },

  /* 13.5.2 */
  'keyframe.remove'(state, payload) {
    const clip = namedClip(state, payload);
    const property = text(payload, 'property');
    const ids = idList(payload);
    for (const id of ids) keyframeOf(state, clip, property, id);
    writeGroup(state, clip, property, (keyframes) => keyframes.filter((keyframe) => !ids.includes(keyframe.id)));
    // Only a vector removal sweeps the entries that hold no animation (13.2.4).
    if (isVector(property)) sweep(state);
  },

  /* 13.5.3 */
  'keyframe.update'(state, payload) {
    const clip = namedClip(state, payload);
    const property = text(payload, 'property');
    const vector = isVector(property);
    if (!vector && (payload.temporalEase !== undefined || payload.spatial !== undefined))
      invalid(`${property} keyframes take no velocity or path handles`);
    const keyframe = keyframeOf(state, clip, property, text(payload, 'keyframeId'));
    const changes = {};
    if (payload.at !== undefined) {
      const { frame, inside } = clipFrame(state, clip, payload);
      if (!inside) invalid('at must fall inside the clip');
      if (groupOf(state, clip, property).keyframes.some((other) => other.id !== keyframe.id && other.frame === frame))
        invalid(`at: ${property} already has a keyframe there`);
      changes.frame = frame;
    }
    if (payload.value !== undefined) {
      if (vector) changes.value = vectorOf(payload.value, 'value');
      else {
        if (!finite(payload.value?.value)) invalid('value must be { value: number }');
        changes.value = payload.value.value;
      }
    }
    const cleared = [];
    if (vector && payload.temporalEase !== undefined) {
      const ease = payload.temporalEase;
      if (ease === null) cleared.push('temporalEase');
      else {
        if (typeof ease !== 'object' || (ease.in === undefined && ease.out === undefined)) invalid('temporalEase must be { in?, out? } or null');
        const handle = (value, name) => {
          if (!value || typeof value !== 'object') invalid(`${name} must be { speed, influence }`);
          if (!finite(value.speed, -1e9, 1e9)) invalid(`${name}.speed must be a number`);
          if (!finite(value.influence, 0.1, 100)) invalid(`${name}.influence must be in 0.1..100`);
          return { speed: value.speed, influence: value.influence };
        };
        changes.temporalEase = {
          ...(ease.in !== undefined ? { in: handle(ease.in, 'temporalEase.in') } : {}),
          ...(ease.out !== undefined ? { out: handle(ease.out, 'temporalEase.out') } : {}),
        };
      }
    }
    if (vector && payload.spatial !== undefined) {
      if (property !== 'position') invalid('only position keyframes have path tangents');
      const { spatial } = payload;
      if (spatial === null) cleared.push('spatial');
      else {
        if (typeof spatial !== 'object') invalid('spatial must be { inTangent, outTangent, continuous? } or null');
        if (spatial.continuous !== undefined && typeof spatial.continuous !== 'boolean') invalid('spatial.continuous must be a boolean');
        const continuous = spatial.continuous === true;
        let inTangent = spatial.inTangent === undefined ? undefined : vectorOf(spatial.inTangent, 'spatial.inTangent');
        let outTangent = spatial.outTangent === undefined ? undefined : vectorOf(spatial.outTangent, 'spatial.outTangent');
        if (continuous && inTangent && !outTangent) outTangent = { x: -inTangent.x, y: -inTangent.y };
        if (continuous && outTangent && !inTangent) inTangent = { x: -outTangent.x, y: -outTangent.y };
        if (!inTangent || !outTangent) invalid('spatial needs both tangents unless they are continuous');
        if (continuous && (Math.abs(inTangent.x + outTangent.x) > 1e-9 || Math.abs(inTangent.y + outTangent.y) > 1e-9))
          invalid('continuous tangents must mirror each other');
        changes.spatial = { inTangent, outTangent, ...(continuous ? { continuous } : {}) };
      }
    }
    if (Object.keys(changes).length + cleared.length === 0) invalid('keyframe.update needs something to change');
    // A new frame inside a transition region writes nothing at all, the value included.
    if (changes.frame !== undefined && inTransitionRegion(state, clip, changes.frame)) {
      if (changes.frame !== keyframe.frame) failed('keyframe.update: keyframes cannot be moved inside a transition');
      return;
    }
    writeGroup(
      state,
      clip,
      property,
      (keyframes) => byFrame(keyframes.map((entry) => (entry.id === keyframe.id ? { ...without(entry, ...cleared), ...changes } : entry))),
      vector,
    );
  },

  /* 13.5.4 */
  'keyframe.setEasing'(state, payload) {
    const clip = namedClip(state, payload);
    const property = text(payload, 'property');
    const ids = idList(payload);
    for (const id of ids) keyframeOf(state, clip, property, id);
    const easing = text(payload, 'easing');
    if (!EASINGS.includes(easing)) invalid('easing is not an easing type');
    let easingConfig;
    if (easing === 'cubic-bezier') {
      const points = ['x1', 'y1', 'x2', 'y2'].map((key) => payload.bezier?.[key]);
      if (!points.every((point) => finite(point))) invalid('bezier must be { x1, y1, x2, y2 } numbers');
      const [x1, y1, x2, y2] = points;
      if (x1 < 0 || x1 > 1 || x2 < 0 || x2 > 1) invalid('bezier x1 and x2 must lie in 0..1');
      easingConfig = { type: easing, bezier: { x1, y1, x2, y2 } };
    } else if (easing === 'spring') {
      const spring = { ...catalogue.easing.springDefault, ...(payload.spring ?? {}) };
      for (const [key, [least, most]] of Object.entries({ tension: [0, 500], friction: [0, 100], mass: [0.1, 10] })) {
        if (!finite(spring[key], least, most)) invalid(`spring.${key} must be in ${least}..${most}`);
      }
      easingConfig = { type: easing, spring };
    } else if (payload.bezier !== undefined || payload.spring !== undefined) {
      invalid(`${easing} takes no bezier or spring parameters`);
    }
    writeGroup(
      state,
      clip,
      property,
      (keyframes) =>
        keyframes.map((keyframe) =>
          ids.includes(keyframe.id) ? { ...without(keyframe, 'easingConfig'), easing, ...(easingConfig ? { easingConfig } : {}) } : keyframe,
        ),
      isVector(property),
    );
  },

  /* 13.6.1 */
  'property.setExpression'(state, payload) {
    const clip = namedClip(state, payload);
    const property = text(payload, 'property');
    if (!catalogue.properties.expression.includes(property)) invalid(`property "${property}" cannot carry an expression`);
    const source = payload.expression;
    if (source === null) {
      if (entryOf(state, clip.id)) {
        writeEntry(state, clip.id, (before) => ({ ...before, expressions: (before.expressions ?? []).filter((entry) => entry.targetProperty !== property) }));
      }
      sweep(state);
      return;
    }
    if (typeof source !== 'string' || !source.trim()) invalid('expression must be a string or null');
    let kind;
    try {
      kind = expressionKind(source, isVector(property));
    } catch (error) {
      if (error instanceof Unspecified) throw error;
      invalid(`expression: ${error.message}`);
    }
    if (kind !== undefined && (kind === 'vector') !== isVector(property)) invalid(`expression gives a ${kind}; ${property} needs the other`);
    writeEntry(state, clip.id, (before) => ({
      ...before,
      animationVersion: 2,
      expressions: [...(before.expressions ?? []).filter((entry) => entry.targetProperty !== property), { type: 'expression', targetProperty: property, source, enabled: true }],
    }));
  },

  /* 13.6.2 */
  'property.setModifier'(state, payload, draw) {
    const clip = namedClip(state, payload);
    const property = text(payload, 'property');
    const present = clip.motionModifiers ?? [];
    if (payload.modifier === null) {
      const kept = present.filter((modifier) => !drivenChannels(modifier).includes(property));
      if (kept.length === present.length) invalid(`no modifier drives ${property}`);
      replace(state, { ...clip, motionModifiers: kept });
      return;
    }
    const modifier = modifierOf(payload.modifier, draw);
    if (!drivenChannels(modifier).includes(property)) invalid(`a ${modifier.type} modifier does not drive ${property}`);
    replace(state, { ...clip, motionModifiers: [...present.filter((entry) => entry.type !== modifier.type), modifier] });
  },

  /* 13.6.3 */
  'property.bakeModifier'(state, payload) {
    const clip = namedClip(state, payload);
    const property = text(payload, 'property');
    const modifierId = text(payload, 'modifierId');
    const modifier = (clip.motionModifiers ?? []).find((entry) => entry.id === modifierId);
    if (!modifier) invalid(`modifierId: "${modifierId}" is not on this clip`);
    if (!modifier.enabled) invalid('a disabled modifier contributes nothing to bake');
    if (!drivenChannels(modifier).includes(property)) invalid(`a ${modifier.type} modifier does not drive ${property}`);
    if ((clip.motionLayers ?? []).some((layer) => layer.enabled) || (clip.effects ?? []).some((effect) => effect.audioPulse?.enabled))
      throw new Unspecified('motion layers and audio pulses are outside this protocol');
    const sampled = clip.motionModifiers.filter((entry) => entry.enabled && entry.amplitude > 0);
    const last = Math.max(0, clip.durationInFrames - 1);
    if (sampled.length > 0 && sampled.some((entry) => drivenChannels(entry).length > 0) && last > 0) {
      const step = Math.min(
        ...sampled.map((entry) => Math.max(1, Math.round(state.fps / Math.max(0.01, entry.frequency * (entry.type === 'micro-shake' ? 1 : 6))))),
      );
      const frames = new Set([0, last]);
      for (let frame = 0; frame <= last; frame += step) frames.add(frame);
      // The engine notices a blocked keyframe by counting the clip's scalar keyframes afterwards, so
      // keyframes of properties the bake does not replace can hide the block (13.6.3).
      const replaced = new Set(sampled.flatMap(drivenChannels));
      const others = (entryOf(state, clip.id)?.properties ?? [])
        .filter((group) => !replaced.has(group.property))
        .reduce((sum, group) => sum + group.keyframes.length, 0);
      const free = [...frames].filter((frame) => !inTransitionRegion(state, clip, frame)).length;
      if (others + free * replaced.size < frames.size * replaced.size)
        failed('property.bakeModifier: keyframes cannot be placed inside a transition');
      throw new Unspecified('baked keyframe values are engine arithmetic (13.6.3)');
    }
    // Nothing to sample: no keyframe is written, and every modifier of the clip is removed.
    replace(state, { ...clip, motionModifiers: [] });
  },

  /* 13.7.1 */
  'text.setMotion'(state, payload) {
    const clip = namedClip(state, payload);
    if (clip.type !== 'text') invalid('text.setMotion needs a text clip');
    const { motion } = payload;
    if (motion === null) {
      replace(state, without(clip, 'textMotion'));
      return;
    }
    if (!plainObject(motion)) invalid('motion must be an object or null');
    const slots = Object.keys(motion);
    if (slots.length === 0 || slots.some((slot) => !['in', 'out', 'loop'].includes(slot))) invalid('motion takes in, out and loop slots');
    const textMotion = {};
    for (const slot of ['in', 'out', 'loop']) {
      if (!(slot in motion)) continue;
      textMotion[slot] = textMotionSlot(motion[slot], catalogue.textMotion[slot]) ?? invalid(`motion.${slot} is not a valid ${slot} text motion`);
    }
    replace(state, { ...clip, textMotion });
  },

  /* 13.7.2 */
  'clip.setKenBurns'(state, payload, draw) {
    const clip = namedClip(state, payload);
    if (clip.type !== 'image') invalid('Ken Burns moves a still photo');
    const owned = new Set(clip.frameleafKenBurns?.keyframeIds ?? []);
    const entry = entryOf(state, clip.id);
    let move = null;
    if (payload.kenBurns !== null) {
      const candidate = payload.kenBurns;
      if (!candidate || typeof candidate !== 'object') invalid('kenBurns must be { from, to } or null');
      move = { from: kenBurnsRect(candidate.from, 'from'), to: kenBurnsRect(candidate.to, 'to') };
      const foreign =
        (entry?.properties ?? []).some(
          (group) => ['x', 'y', 'width', 'height'].includes(group.property) && group.keyframes.some((keyframe) => !owned.has(keyframe.id)),
        ) || (entry?.vectorProperties ?? []).some((group) => ['position', 'scale'].includes(group.property) && group.keyframes.length > 0);
      if (foreign) invalid('the clip already animates its position or size');
    }
    if (entry) {
      writeEntry(state, clip.id, (before) => ({
        ...before,
        properties: before.properties.map((group) => ({ ...group, keyframes: group.keyframes.filter((keyframe) => !owned.has(keyframe.id)) })),
      }));
    }
    if (!move) {
      replace(state, without(clip, 'frameleafKenBurns'));
      return;
    }
    const size = fitted(state, clip);
    const base = { x: clip.transform?.x ?? 0, y: clip.transform?.y ?? 0, width: clip.transform?.width ?? size.width, height: clip.transform?.height ?? size.height };
    const last = Math.max(1, clip.durationInFrames - 1);
    const pose = (rect) => {
      const width = base.width / rect.w;
      const height = base.height / rect.h;
      return { width, height, x: base.x + (0.5 - (rect.x + rect.w / 2)) * width, y: base.y + (0.5 - (rect.y + rect.h / 2)) * height };
    };
    const [first, final] = [pose(move.from), pose(move.to)];
    const list = ['x', 'y', 'width', 'height'].flatMap((property) => [
      { property, frame: 0, value: first[property], easing: 'linear' },
      { property, frame: last, value: final[property], easing: 'linear' },
    ]);
    const keyframeIds = addScalarKeyframes(state, clip, list, draw);
    if (keyframeIds === null) failed('clip.setKenBurns: keyframes cannot be placed inside a transition');
    replace(state, { ...clipOf(state, clip.id), frameleafKenBurns: { ...move, keyframeIds } });
  },
});

/* ================================================================== */
/* Part 4 (section 14): compositions, groups, titles and settings      */
/* ================================================================== */

/* 14.2: compositions */

/** 14.2.1: a composition as it is stored: tracks in order, each listing its own items. */
function storedComposition(composition) {
  const tracks = composition.tracks
    .map((track, index) => ({ track, index }))
    .sort((a, b) => (a.track.order ?? 0) - (b.track.order ?? 0) || a.index - b.index)
    .map(({ track }) => ({ ...track, items: composition.items.filter((item) => item.trackId === track.id) }));
  const next = { ...composition, tracks };
  for (const key of ['transitions', 'keyframes', 'markers']) if ((next[key]?.length ?? 0) === 0) delete next[key];
  for (const key of ['inPoint', 'outPoint', 'backgroundColor', 'compositionControls']) if (next[key] === undefined || next[key] === null) delete next[key];
  if (next.keyframes) next.keyframes = next.keyframes.map(tidy);
  return next;
}

const compositionOf = (state, id) => state.compositions.find((composition) => composition.id === id);
const isSoundClip = (item) => item.type === 'audio' && typeof item.compositionId === 'string' && item.compositionId.length > 0;
/** 14.2.2: the sound clip that goes with a composition clip, and the other way round. */
const soundCompanion = (items, clip) =>
  clip.linkedGroupId
    ? items.find((item) => item.id !== clip.id && isSoundClip(item) && item.linkedGroupId === clip.linkedGroupId && item.compositionId === clip.compositionId)
    : undefined;
const pictureCompanion = (items, clip) =>
  clip.linkedGroupId
    ? items.find((item) => item.type === 'composition' && item.linkedGroupId === clip.linkedGroupId && item.compositionId === clip.compositionId)
    : undefined;

/** 14.2.2: whether a list of clips on these tracks carries sound of its own. */
function carriesSound(state, items, tracks, path = new Set()) {
  const solo = tracks.some((track) => track.solo);
  const heard = new Map(tracks.filter((track) => (solo ? track.solo === true : track.visible !== false) && !track.muted).map((track) => [track.id, track]));
  const inside = (clip) => {
    if (path.has(clip.compositionId)) return false;
    const composition = compositionOf(state, clip.compositionId);
    if (!composition) return false;
    if ((clip.sourceStart ?? 0) !== 0 || (clip.speed ?? 1) !== 1) throw new Unspecified('sound of a trimmed or retimed composition clip (14.2.2)');
    return carriesSound(state, composition.items, composition.tracks, new Set([...path, clip.compositionId]));
  };
  return items
    .filter((item) => heard.has(item.trackId))
    .some((item) => {
      if (item.muted === true) return false;
      if (isSoundClip(item)) return inside(item);
      if (item.type === 'composition') return !soundCompanion(items, item) && inside(item);
      if (!item.mediaId) return false;
      if (item.type === 'audio') return true;
      if (item.type !== 'video' || item.embeddedAudioMuted) return false;
      // A video with a linked audio clip leaves the sound to that clip.
      return !linkedGroup({ items }, item).some((member) => member.id !== item.id && member.type === 'audio');
    });
}

const kindOfTrack = (track, items) => track?.kind ?? (items.every((item) => item.type === 'audio') ? 'audio' : 'video');

/** 14.2.2: gather clips into a new composition and put its clip (and sound clip) in their place. */
function gather(state, name, requested, editorKind, draw) {
  const linked = unique(unique(requested).flatMap((id) => linkedGroup(state, clipOf(state, id)).map((member) => member.id)));
  const chosen = new Set(linked);
  for (const item of state.items) {
    if (!chosen.has(item.id)) continue;
    const companion = item.type === 'composition' ? soundCompanion(state.items, item) : isSoundClip(item) ? pictureCompanion(state.items, item) : undefined;
    if (companion) chosen.add(companion.id);
  }
  const gathered = state.items.filter((item) => chosen.has(item.id));
  const start = Math.min(...gathered.map((item) => item.from));
  const length = Math.max(...gathered.map(end)) - start;

  const sourceTracks = unique(gathered.map((item) => item.trackId))
    .map((id, index) => ({ id, index, track: state.tracks.find((track) => track.id === id) }))
    .sort((a, b) => (a.track?.order ?? 0) - (b.track?.order ?? 0) || a.index - b.index);
  const trackIds = new Map();
  const tracks = sourceTracks.map(({ id, track }, index) => {
    const onTrack = gathered.filter((item) => item.trackId === id);
    const made = {
      id: draw(),
      name: track?.name ?? `Track ${index + 1}`,
      kind: kindOfTrack(track, onTrack),
      height: track?.height ?? 100,
      locked: false,
      visible: track?.visible ?? true,
      muted: track?.muted ?? false,
      solo: track?.solo ?? false,
      volume: track?.volume ?? 0,
      ...(track?.color === undefined ? {} : { color: track.color }),
      order: index,
    };
    trackIds.set(id, made.id);
    return made;
  });
  const itemIds = new Map();
  const items = gathered.map((item) => {
    const id = draw();
    itemIds.set(item.id, id);
    return { ...item, id, from: item.from - start, trackId: trackIds.get(item.trackId) };
  });
  const id = draw();
  const transitions = state.transitions
    .filter((transition) => chosen.has(transition.leftClipId) && chosen.has(transition.rightClipId))
    .map((transition) => ({
      ...transition,
      id: draw(),
      leftClipId: itemIds.get(transition.leftClipId),
      rightClipId: itemIds.get(transition.rightClipId),
      trackId: trackIds.get(transition.trackId) ?? transition.trackId,
    }));
  const keyframes = state.keyframes.filter((entry) => chosen.has(entry.itemId)).map((entry) => ({ ...entry, itemId: itemIds.get(entry.itemId) }));
  const composition = {
    id,
    name,
    editorKind,
    items,
    tracks,
    transitions,
    keyframes,
    fps: state.fps,
    width: state.canvas.width,
    height: state.canvas.height,
    durationInFrames: length,
    ...(state.metadata.backgroundColor ? { backgroundColor: state.metadata.backgroundColor } : {}),
  };
  state.compositions.push(composition);

  // Where the composition clip and its sound clip go.
  const picture = items.some((item) => item.type !== 'audio');
  const sound = carriesSound(state, items, tracks);
  const tracksWith = (audio) => sourceTracks.filter(({ id: trackId }) => gathered.some((item) => item.trackId === trackId && (item.type === 'audio') === audio));
  const pictureTrackId = picture ? (tracksWith(false).at(-1)?.id ?? null) : null;
  let soundTrackId = null;
  if (sound) {
    soundTrackId = tracksWith(true).at(-1)?.id ?? null;
    if (!soundTrackId) {
      const audio = state.tracks.filter((track) => track.kind === 'audio').toSorted((a, b) => a.order - b.order);
      const pictureTrack = state.tracks.find((track) => track.id === pictureTrackId);
      const below = pictureTrack ? audio.find((track) => track.order > pictureTrack.order) : audio.at(-1);
      if (below) soundTrackId = below.id;
      else {
        const anchor = pictureTrack ?? state.tracks.at(-1);
        const made = newTrack(state, 'audio', anchor ? orderBeside(state.tracks, anchor, 'below') : 0, draw);
        state.tracks = writeTracks([...state.tracks, made]);
        soundTrackId = made.id;
      }
    }
  }

  removeClips(state, chosen);
  const linkedGroupId = picture && sound ? draw() : undefined;
  const window = { sourceStart: 0, sourceEnd: length, sourceDuration: length, sourceFps: state.fps, speed: 1 };
  if (picture && pictureTrackId) {
    state.items.push({
      id: draw(),
      type: 'composition',
      trackId: pictureTrackId,
      from: start,
      durationInFrames: length,
      label: name,
      compositionId: id,
      ...(linkedGroupId ? { linkedGroupId } : {}),
      compositionWidth: composition.width,
      compositionHeight: composition.height,
      transform: { x: 0, y: 0, rotation: 0, opacity: 1 },
      ...window,
    });
  }
  if (sound && soundTrackId) {
    state.items.push({
      id: draw(),
      type: 'audio',
      trackId: soundTrackId,
      from: start,
      durationInFrames: length,
      label: name,
      compositionId: id,
      ...(linkedGroupId ? { linkedGroupId } : {}),
      src: '',
      ...window,
    });
  }
}

/** 12.2.8: a track a command creates. */
function newTrack(state, kind, order, draw) {
  return {
    id: `track-${draw()}`,
    name: firstTrackName(state.tracks, kind),
    kind,
    height: 100,
    locked: false,
    syncLock: true,
    visible: true,
    muted: false,
    solo: false,
    volume: 0,
    order,
    items: [],
  };
}

/** The order of a new track just above or below `anchor`. */
function orderBeside(tracks, anchor, side) {
  const sorted = tracks.toSorted((a, b) => a.order - b.order);
  const at = sorted.findIndex((track) => track.id === anchor.id);
  const neighbour = sorted[side === 'above' ? at - 1 : at + 1];
  return neighbour ? (neighbour.order + anchor.order) / 2 : anchor.order + (side === 'above' ? -1 : 1);
}

const clipIdList = (payload, command) => {
  const { clipIds } = payload;
  if (!Array.isArray(clipIds) || clipIds.length === 0 || clipIds.some((id) => typeof id !== 'string')) invalid(`${command} needs clipIds`);
  return clipIds;
};

/** 14.2.6: take a group apart. */
function dissolve(state, wrapper, draw) {
  const composition = compositionOf(state, wrapper.compositionId);
  const soundWrapper = soundCompanion(state.items, wrapper);
  const wrapperIds = [wrapper.id, soundWrapper?.id].filter(Boolean);
  let tracks = state.tracks;
  const nearest = (anchor, kind, side) =>
    tracks
      .filter((track) => track.kind === kind && (side === 'above' ? track.order < anchor.order : track.order > anchor.order))
      .sort((a, b) => (side === 'above' ? b.order - a.order : a.order - b.order))[0];
  const pictureAnchorId = wrapper.trackId;
  let soundAnchorId = soundWrapper?.trackId ?? null;
  if (!soundAnchorId) {
    const anchor = tracks.find((track) => track.id === pictureAnchorId);
    const found = nearest(anchor, 'audio', 'below');
    if (found) soundAnchorId = found.id;
    else {
      // A track made here is kept only if another track is made too: its id is drawn either way.
      const made = newTrack({ tracks }, 'audio', orderBeside(tracks, anchor, 'below'), draw);
      tracks = [...tracks, made];
      soundAnchorId = made.id;
    }
  }
  const inner = composition.tracks.toSorted((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const kindOf = (track) => kindOfTrack(track, composition.items.filter((item) => item.trackId === track.id));
  const trackIds = new Map();
  const made = [];
  const rest = state.items.filter((item) => !wrapperIds.includes(item.id));
  const place = (group, anchorId, kind) => {
    if (group.length === 0 || !anchorId) return;
    const anchor = [...tracks, ...made].find((track) => track.id === anchorId);
    if (!anchor) return;
    const used = new Set(trackIds.values());
    trackIds.set(group.at(-1).id, anchorId);
    used.add(anchorId);
    const above = [...tracks, ...made]
      .filter((track) => track.id !== anchorId && track.kind === kind && track.order < anchor.order)
      .sort((a, b) => b.order - a.order);
    for (let index = group.length - 2; index >= 0; index--) {
      const ranges = composition.items.filter((item) => item.trackId === group[index].id).map((item) => [item.from + wrapper.from, item.from + wrapper.from + item.durationInFrames]);
      const free = above.find(
        (track) => !used.has(track.id) && !rest.some((item) => item.trackId === track.id && ranges.some(([from, to]) => from < end(item) && item.from < to)),
      );
      if (free) {
        trackIds.set(group[index].id, free.id);
        used.add(free.id);
        continue;
      }
      const id = draw();
      trackIds.set(group[index].id, id);
      used.add(id);
      // The engine copies the inner track whole, so the new track lists the inner clips until the
      // next load empties it (14.2.6): the graph settles on load.
      const stray = composition.items.filter((item) => item.trackId === group[index].id);
      made.push({ ...group[index], id, kind, order: anchor.order - (group.length - 1 - index) * 0.01, items: stray });
    }
  };
  place(inner.filter((track) => kindOf(track) === 'video'), pictureAnchorId, 'video');
  place(inner.filter((track) => kindOf(track) === 'audio'), soundAnchorId, 'audio');
  if (made.length > 0) state.tracks = writeTracks([...tracks, ...made]);

  // Each clip comes back through the window the group's clip shows.
  const speed = wrapper.speed ?? 1;
  const windowFps = wrapper.sourceFps ?? composition.fps;
  const windowStart = wrapper.sourceStart ?? wrapper.trimStart ?? 0;
  const windowEnd = wrapper.sourceEnd ?? windowStart + Math.round((wrapper.durationInFrames / state.fps) * windowFps * speed);
  const shown = (frames) => Math.floor(((frames / windowFps) * state.fps) / speed);
  const itemIds = new Map();
  const restored = [];
  for (const item of composition.items) {
    const from = Math.max(item.from, windowStart);
    const to = Math.min(end(item), windowEnd);
    if (to <= from) continue;
    const mapped = { ...item, from: wrapper.from + shown(from - windowStart), speed: (item.speed ?? 1) * speed };
    mapped.durationInFrames = Math.max(1, shown(to - windowStart) - shown(from - windowStart));
    if (isMedia(item)) {
      const perFrame = (frames) => Math.round((frames / composition.fps) * (item.sourceFps ?? composition.fps) * (item.speed ?? 1));
      mapped.sourceStart = (item.sourceStart ?? 0) + perFrame(from - item.from);
      if (item.sourceEnd !== undefined) mapped.sourceEnd = Math.max(mapped.sourceStart + 1, item.sourceEnd - perFrame(end(item) - to));
    }
    mapped.id = draw();
    itemIds.set(item.id, mapped.id);
    mapped.trackId = trackIds.get(item.trackId) ?? pictureAnchorId ?? soundAnchorId ?? item.trackId;
    restored.push(mapped);
  }
  const gone = new Set(wrapperIds);
  state.items = [...state.items.filter((item) => !gone.has(item.id)), ...restored];
  state.transitions = state.transitions.filter((transition) => !gone.has(transition.leftClipId) && !gone.has(transition.rightClipId));
  const transitions = (composition.transitions ?? []).flatMap((transition) =>
    itemIds.has(transition.leftClipId) && itemIds.has(transition.rightClipId)
      ? [{ ...transition, id: draw(), leftClipId: itemIds.get(transition.leftClipId), rightClipId: itemIds.get(transition.rightClipId), trackId: trackIds.get(transition.trackId) ?? transition.trackId }]
      : [],
  );
  if (transitions.length > 0) {
    state.transitions = [...state.transitions, ...transitions];
    repair(state, restored.map((item) => item.id));
  }
  state.keyframes = [...state.keyframes, ...(composition.keyframes ?? []).map((entry) => ({ ...entry, itemId: itemIds.get(entry.itemId) ?? entry.itemId }))];
  const read = [state.items, ...state.compositions.filter((other) => other.id !== composition.id).map((other) => other.items)].some((items) =>
    items.some((item) => item.compositionId === composition.id),
  );
  if (!read) state.compositions = state.compositions.filter((other) => other.id !== composition.id);
}

/* 17.4, 17.5 and 14.3.4: shape and title style fields */

const plainRecord = (value) => !!value && typeof value === 'object' && !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
/** A field's check with the words of its refusal. */
const rule = (check, expects) => ({ check, expects });
const colour = rule((value) => typeof value === 'string' && /^#(?:[0-9a-f]{6}|[0-9a-f]{8})$/i.test(value), 'a #rrggbb or #rrggbbaa colour');
const bool = rule((value) => typeof value === 'boolean', 'a boolean');
const between = (min, max) => rule((value) => finite(value, min, max), `a number from ${min} to ${max}`);
const among = (...options) => rule((value) => options.includes(value), `one of ${options.join(', ')}`);

/** 17.5: each shape field, in the order of the table: its rule, the shapes that have it, and whether null may clear it. */
const SHAPE_FIELDS = [
  ['fillColor', colour, null, false],
  ['fillEnabled', bool],
  ['fillType', among('solid', 'linear')],
  ['gradientStartColor', colour],
  ['gradientEndColor', colour],
  ['gradientAngle', between(-180, 180)],
  ['strokeColor', colour],
  ['strokeWidth', between(0, 50)],
  ['strokeEnabled', bool],
  ['strokeLineCap', among('butt', 'round', 'square')],
  ['strokeLineJoin', among('miter', 'round', 'bevel')],
  ['strokeMiterLimit', between(1, 20)],
  ['trimPathStart', between(0, 100)],
  ['trimPathEnd', between(0, 100)],
  ['trimPathOffset', between(-360, 360)],
  ['taperStartWidth', between(0, 200)],
  ['taperEndWidth', between(0, 200)],
  ['taperStartLength', between(0, 100)],
  ['taperEndLength', between(0, 100)],
  ['cornerRadius', between(0, 100), ['rectangle', 'triangle', 'star', 'polygon']],
  ['direction', among('up', 'down', 'left', 'right'), ['triangle']],
  ['points', rule((value) => Number.isInteger(value) && value >= 3 && value <= 12, 'an integer from 3 to 12'), ['star', 'polygon']],
  ['innerRadius', between(0.1, 0.9), ['star']],
  ['pathClosed', bool, ['path'], false],
];
const KEPT_ON_A_PATH = ['fillEnabled', 'strokeEnabled', 'strokeLineCap', 'strokeLineJoin', 'strokeMiterLimit'];

/** 17.1: pen-path vertices, each written with its four keys. */
function pathVertices(value, command, least) {
  if (!Array.isArray(value) || value.length < least || value.length > 1000) invalid(`${command}: path must have ${least} to 1000 vertices`);
  const pair = (entry) => {
    if (!Array.isArray(entry) || entry.length !== 2 || !entry.every((n) => typeof n === 'number' && Number.isFinite(n))) invalid(`${command}: a vertex position or handle must be [x, y]`);
    return [entry[0], entry[1]];
  };
  return value.map((vertex) => {
    if (!plainRecord(vertex)) invalid(`${command}: a vertex must be an object`);
    for (const key of Object.keys(vertex)) if (!['position', 'inHandle', 'outHandle', 'tangentMode'].includes(key)) invalid(`${command}: unknown vertex field`);
    const position = pair(vertex.position);
    const inHandle = pair(vertex.inHandle);
    const outHandle = pair(vertex.outHandle);
    if (vertex.tangentMode !== undefined && !['corner', 'smooth', 'continuous', 'broken'].includes(vertex.tangentMode)) invalid(`${command}: unknown tangent mode`);
    return { position, inHandle, outHandle, tangentMode: vertex.tangentMode ?? ([...inHandle, ...outHandle].every((n) => n === 0) ? 'corner' : 'smooth') };
  });
}

/** 17.5: the shape a `style` leaves behind. A cleared field is removed. */
function styledShape(command, style, shape) {
  if (!plainRecord(style)) invalid(`${command}: style must be an object`);
  for (const key of Object.keys(style)) {
    if (key !== 'pathVertices' && !SHAPE_FIELDS.some(([name]) => name === key)) invalid(`${command}: unknown style field "${key}"`);
  }
  const isPath = shape.shapeType === 'path';
  let next = { ...shape };
  for (const [name, { check, expects }, shapes, clearable = true] of SHAPE_FIELDS) {
    const given = style[name];
    if (given === undefined) continue;
    if (shapes && !shapes.includes(shape.shapeType)) invalid(`${command}: style.${name} does not apply to a ${shape.shapeType} shape`);
    if (given === null) {
      if (!clearable || (isPath && KEPT_ON_A_PATH.includes(name))) invalid(`${command}: style.${name} cannot be cleared`);
      next = without(next, name);
    } else {
      if (!check(given)) invalid(`${command}: style.${name} must be ${expects}`);
      next[name] = given;
    }
  }
  if (style.pathVertices !== undefined) {
    if (style.pathVertices === null) invalid(`${command}: style.pathVertices cannot be cleared`);
    if (!isPath) invalid(`${command}: path needs a path shape`);
    next.pathVertices = pathVertices(style.pathVertices, command, 2);
  }
  if (isPath) {
    const closed = next.pathClosed ?? true;
    if (!closed && next.isMask === true) invalid(`${command}: a mask path is closed`);
    if (closed && (next.pathVertices?.length ?? 0) < 3) invalid(`${command}: a closed path needs 3 vertices`);
    if (!closed) {
      if (style.fillEnabled === true) invalid(`${command}: an open path has no fill`);
      next.fillEnabled = false;
    }
  }
  if (next.strokeEnabled === true && (next.strokeWidth ?? 0) < 1) next.strokeWidth = 1;
  return next;
}

/** 14.3.4: the title fields, in the order of the table. */
const fonts = catalogue.fonts.families.map((entry) => entry.family);
const font = rule((value) => fonts.includes(value), "a family of the engine's font catalogue");
const weight = among('normal', 'medium', 'semibold', 'bold');
const slant = among('normal', 'italic');
const TITLE_FIELDS = [
  ['color', colour, false],
  ['fontSize', between(8, 500)],
  ['fontFamily', font],
  ['fontWeight', weight],
  ['fontStyle', slant],
  ['underline', bool],
  ['lineHeight', between(0.5, 3)],
  ['letterSpacing', between(-20, 100)],
  ['textPadding', between(0, 160)],
  ['backgroundColor', colour],
  ['backgroundRadius', between(0, 999)],
];
const TITLE_OBJECTS = [
  ['textShadow', [['offsetX', between(-100, 100)], ['offsetY', between(-100, 100)], ['blur', between(0, 160)], ['color', colour]]],
  ['stroke', [['width', between(0, 24)], ['color', colour]]],
];
const SPAN_FIELDS = [['fontSize', between(8, 500)], ['fontFamily', font], ['fontWeight', weight], ['fontStyle', slant], ['underline', bool], ['color', colour], ['letterSpacing', between(-20, 100)]];

/** 14.3.4: a preset's fields at a scale. */
function scaledStyle(state, presetId, scale) {
  const { set, remove } = titleStyle(state, presetId);
  const scaled = { ...set, textStyleScale: scale };
  scaled.fontSize = Math.round(set.fontSize * scale);
  if (set.backgroundRadius !== 999) scaled.backgroundRadius = Math.round(set.backgroundRadius * scale);
  scaled.letterSpacing = set.letterSpacing * scale;
  scaled.textPadding = Math.round(set.textPadding * scale);
  if (set.textShadow) scaled.textShadow = { offsetX: set.textShadow.offsetX * scale, offsetY: set.textShadow.offsetY * scale, blur: set.textShadow.blur * scale, color: set.textShadow.color };
  if (set.stroke) scaled.stroke = { ...set.stroke, width: set.stroke.width * scale };
  return { set: scaled, remove };
}

/* 14.3: titles */

const STYLE_FIELDS_A_PRESET_MAY_OMIT = ['backgroundColor', 'textShadow', 'stroke'];

/** 14.3.2: the fields a title style writes on this canvas, and those it removes. */
function titleStyle(state, style) {
  const named = catalogue.titleStyles.aliases[style] ?? style;
  if (named === 'plain') return { set: { fontWeight: 'medium' }, remove: [] };
  if (named === 'bold') return { set: { fontWeight: 'bold' }, remove: [] };
  const preset = catalogue.titleStyles.presets.find((entry) => entry.id === named) ?? invalid(`style: unknown title style "${style}"`);
  const step = catalogue.titleStyles.sizes[preset.fontSize.size];
  const size = Math.min(step.max, Math.max(step.min, Math.round(state.canvas.height * step.heightFactor)));
  const set = { ...preset.fields, fontSize: Math.round(size * preset.fontSize.multiplier) };
  return { set, remove: STYLE_FIELDS_A_PRESET_MAY_OMIT.filter((field) => !(field in set)) };
}
const withStyle = (state, clip, style) => {
  const { set, remove } = titleStyle(state, style);
  return { ...without(clip, ...remove), ...set };
};

function titlePosition(position) {
  const match = /^([tmb])([lcr])$/.exec(position) ?? invalid(`position: unknown title position "${position}"`);
  return { verticalAlign: { t: 'top', m: 'middle', b: 'bottom' }[match[1]], textAlign: { l: 'left', c: 'center', r: 'right' }[match[2]] };
}

/** 14.3.3: the text motion a title animation writes. */
function titleMotion(animation) {
  const named = catalogue.titleAnimations.aliases[animation] ?? { in: animation };
  if (!catalogue.textMotion.in.includes(named.in)) invalid(`animation: unknown title animation "${animation}"`);
  const slot = (presetId) => ({ ...catalogue.textMotion.defaults[presetId], presetId, seed: 0 });
  return { in: slot(named.in), ...(named.out && catalogue.textMotion.out.includes(named.out) ? { out: slot(named.out) } : {}) };
}

/* 14.5: carrying frames from one rate to another */

const sameRate = (a, b) => {
  const [x, y] = [exactRate(a), exactRate(b)];
  return x && y ? BigInt(x.num) * BigInt(y.den) === BigInt(y.num) * BigInt(x.den) : a === b;
};

/** 14.5.2: the content of the main timeline or of a composition, carried to another rate. */
function retimed(content, from, to) {
  const carry = (frame) => carryFrame(frame, from, to);
  const keyframeList = (keyframes) => {
    const sorted = keyframes.toSorted((a, b) => a.frame - b.frame);
    const out = [];
    sorted.forEach((keyframe, index) => {
      const frame = carry(keyframe.frame);
      if (out.at(-1)?.frame === frame) {
        // Two keyframes on one frame: the earlier stays, unless the later is the last of the group.
        if (index === sorted.length - 1) out[out.length - 1] = { ...keyframe, frame };
        return;
      }
      out.push({ ...keyframe, frame });
    });
    return out;
  };
  const items = content.items.map((item) => {
    if (item.motionLayers?.length || item.effects?.some((effect) => effect.audioPulse) || item.reverseConformLocalStart !== undefined || item.isReversed)
      throw new Unspecified('motion layers, audio pulses and reversed clips are outside this protocol');
    const start = carry(item.from);
    const next = { ...item, from: start, durationInFrames: Math.max(1, carry(end(item)) - start) };
    const window = item.type !== 'composition' && !item.compositionId;
    const reads = ['trimStart', 'trimEnd', 'sourceStart', 'sourceEnd', 'sourceDuration', 'offset'].some((field) => item[field] !== undefined);
    if (reads && item.sourceFps === undefined && window) next.sourceFps = from;
    if (item.sourceEnd !== undefined && window) {
      const sourceStart = item.sourceStart ?? item.trimStart ?? 0;
      const needed = Math.round((next.durationInFrames / to) * (next.sourceFps ?? from) * (item.speed ?? 1));
      if (needed > item.sourceEnd - sourceStart) {
        const wanted = sourceStart + needed;
        next.sourceEnd = Math.max(item.sourceEnd, Math.min(wanted, item.sourceDuration ?? wanted));
      }
    }
    if (item.motionModifiers) next.motionModifiers = item.motionModifiers.map((modifier) => ({ ...modifier, phaseFrames: carry(modifier.phaseFrames) }));
    if (item.type === 'text' && item.textMotion) {
      next.textMotion = Object.fromEntries(
        Object.entries(item.textMotion).map(([slot, motion]) => [
          slot,
          ['in', 'out', 'loop'].includes(slot) && motion
            ? {
                ...motion,
                durationFrames: Math.max(1, carry(motion.durationFrames)),
                staggerFrames: carry(motion.staggerFrames),
                ...(motion.offsetFrames !== undefined ? { offsetFrames: carry(motion.offsetFrames) } : {}),
              }
            : motion,
        ]),
      );
    }
    return next;
  });
  const next = { ...content, items: untangled(content.items, items, content.tracks) };
  if(content.tracks) next.tracks=content.tracks.map(track=>{
    if(!track.gainEnvelope?.length) return track;
    const points=track.gainEnvelope.map(point=>({...point,frame:carry(point.frame)}));
    if(new Set(points.map(p=>p.frame)).size!==points.length) invalid('Track envelope retime collides');
    return {...track,gainEnvelope:points};
  });
  if (content.transitions) next.transitions = content.transitions.map((transition) => ({ ...transition, durationInFrames: Math.max(1, carry(transition.durationInFrames)) }));
  if (content.keyframes) {
    next.keyframes = content.keyframes.map((entry) => ({
      ...entry,
      properties: entry.properties.map((group) => ({ ...group, keyframes: keyframeList(group.keyframes) })),
      ...(entry.vectorProperties ? { vectorProperties: entry.vectorProperties.map((group) => ({ ...group, keyframes: keyframeList(group.keyframes) })) } : {}),
      ...(entry.propertyLinks ? { propertyLinks: entry.propertyLinks.map((link) => ({ ...link, timeOffsetFrames: carry(link.timeOffsetFrames) })) } : {}),
    }));
  }
  if (content.markers) next.markers = content.markers.map((marker) => ({ ...marker, frame: carry(marker.frame) }));
  for (const key of ['inPoint', 'outPoint', 'currentFrame']) if (typeof content[key] === 'number') next[key] = carry(content[key]);
  if (content.durationInFrames !== undefined) next.durationInFrames = Math.max(1, carry(content.durationInFrames));
  return next;
}

/** 14.5.3: clips that rounding pushed onto each other are moved apart, with what must move with them. */
function untangled(before, after, tracks) {
  const synced = new Set((tracks ?? []).filter((track) => !track.isGroup && !track.locked && track.syncLock !== false).map((track) => track.id));
  const shift = before.map(() => 0);
  const byTrack = new Map();
  before.forEach((item, index) => byTrack.set(item.trackId, [...(byTrack.get(item.trackId) ?? []), index]));
  for (const list of byTrack.values()) list.sort((a, b) => before[a].from - before[b].from || a - b);
  const endOf = (index) => end(before[index]);
  // A clip and the clips after it on its track that touched it, directly or in a chain.
  const run = (index) => {
    const list = byTrack.get(before[index].trackId);
    const out = [index];
    let reach = endOf(index);
    for (const other of list.slice(list.indexOf(index) + 1)) {
      if (before[other].from > reach) break;
      out.push(other);
      reach = Math.max(reach, endOf(other));
    }
    return out;
  };
  const movedWith = (index) => {
    const starts = [index];
    if (synced.has(before[index].trackId)) {
      before.forEach((item, other) => {
        if (item.from === before[index].from && item.trackId !== before[index].trackId && synced.has(item.trackId)) starts.push(other);
      });
    }
    const moved = new Set();
    while (starts.length > 0) {
      for (const member of run(starts.pop())) {
        if (moved.has(member)) continue;
        moved.add(member);
        const group = before[member].linkedGroupId;
        if (!group) continue;
        before.forEach((item, other) => {
          if (item.linkedGroupId === group && !moved.has(other)) starts.push(other);
        });
      }
    }
    return moved;
  };
  for (let guard = 0; guard <= before.length * 4 + 8; guard++) {
    let collision = null;
    for (const list of byTrack.values()) {
      let previous = null;
      for (const index of list) {
        const from = after[index].from + shift[index];
        if (previous && before[index].from >= previous.beforeEnd && from < previous.afterEnd) {
          collision = { index, frames: previous.afterEnd - from, with: previous.index };
          break;
        }
        if (!previous || endOf(index) >= previous.beforeEnd) previous = { index, beforeEnd: endOf(index), afterEnd: from + after[index].durationInFrames };
      }
      if (collision) break;
    }
    if (!collision) return after.map((item, index) => (shift[index] === 0 ? item : { ...item, from: item.from + shift[index] }));
    let moved = movedWith(collision.index);
    if (moved.has(collision.with)) moved = new Set([...moved].filter((member) => before[member].from >= before[collision.index].from));
    for (const member of moved) shift[member] += collision.frames;
  }
  throw new Unspecified('a retime that does not settle');
}

/** 14.6: canvas and rate of the main timeline or of one composition. */
function applySettings(state, sequenceId, settings, timing) {
  const to = settings.rate ? settings.rate.num / settings.rate.den : undefined;
  const composition = compositionOf(state, sequenceId);
  if (sequenceId === 'main' && composition) invalid('sequenceId: "main" names both the main timeline and a composition');
  const timed = (content) => content.tracks?.some(t=>t.gainEnvelope?.length) || (content.items?.length ?? 0) > 0 || (content.markers?.length ?? 0) > 0 || (content.inPoint ?? null) !== null || (content.outPoint ?? null) !== null;
  const policy = (what) => timing ?? invalid(`timing is required: ${what} has content`);
  if (sequenceId === 'main') {
    const from = state.fps;
    if (!exactRate(from)) invalid('the project frame rate has no exact reading');
    if (to !== undefined && !sameRate(to, from) && (timed(state) || state.timeline.masterGainEnvelope?.length) && policy('the main timeline') === 'keep-time') {
      const next = retimed(
        { items: state.items, tracks: state.tracks, transitions: state.transitions, keyframes: state.keyframes, markers: state.markers, inPoint: state.inPoint, outPoint: state.outPoint, currentFrame: state.timeline.currentFrame },
        from,
        to,
      );
      if (state.timeline.masterGainEnvelope?.length) {
        const points=state.timeline.masterGainEnvelope.map(point=>({...point,frame:carryFrame(point.frame,from,to)}));
        if (new Set(points.map(point=>point.frame)).size !== points.length) invalid('Master envelope retime collides');
        state.timeline.masterGainEnvelope=points;
      }
      Object.assign(state, { tracks:next.tracks,items: next.items, transitions: next.transitions, keyframes: next.keyframes, markers: next.markers, inPoint: next.inPoint, outPoint: next.outPoint });
      state.timeline = { ...state.timeline, currentFrame: next.currentFrame };
    }
    state.metadata = {
      ...state.metadata,
      ...(settings.width === undefined ? {} : { width: settings.width }),
      ...(settings.height === undefined ? {} : { height: settings.height }),
      ...(settings.rate ? { fps: to, frameRate: { ...settings.rate } } : {}),
    };
  } else {
    if (!composition) invalid(`sequenceId: sequence "${sequenceId}" does not exist`);
    const from = composition.fps;
    if (!exactRate(from)) invalid('the composition frame rate has no exact reading');
    let changed = { ...composition };
    if (to !== undefined && !sameRate(to, from)) {
      const readBy = [state.items, ...state.compositions.map((other) => other.items)].some((items) => items.some((item) => item.compositionId === sequenceId));
      const chosen = timed(composition) || readBy ? policy(`sequence "${sequenceId}"`) : undefined;
      if (chosen === 'keep-frames' && readBy) invalid('a composition that clips read changes its rate with keep-time');
      if (chosen === 'keep-time') {
        changed = retimed(changed, from, to);
        // The clips that show this composition read it in its own frames.
        const readers = (items) =>
          items.map((item) => {
            if (item.compositionId !== sequenceId) return item;
            const next = { ...item };
            for (const field of ['trimStart', 'trimEnd', 'sourceStart', 'sourceEnd', 'sourceDuration', 'offset']) {
              if (item[field] !== undefined) next[field] = carryFrame(item[field], from, to);
            }
            if (item.sourceFps !== undefined) next.sourceFps = to;
            return next;
          });
        state.items = readers(state.items);
        state.compositions = state.compositions.map((other) => ({ ...other, items: readers(other.items) }));
        changed = { ...changed, items: readers(changed.items) };
      }
      changed.fps = to;
    }
    if (settings.width !== undefined) changed.width = settings.width;
    if (settings.height !== undefined) changed.height = settings.height;
    state.compositions = state.compositions.map((other) => (other.id === sequenceId ? changed : other));
  }
  state.fps = state.metadata.fps;
  state.rate = state.metadata.frameRate;
  state.canvas = { width: state.metadata.width, height: state.metadata.height };
  // The engine reloads the graph it made: the in and out points are clamped at the new rate.
  clamp(state);
}

const timingOf = (payload) => {
  if (payload.timing !== undefined && !['keep-time', 'keep-frames'].includes(payload.timing)) invalid('timing must be keep-time or keep-frames');
  return payload.timing;
};

Object.assign(commands, {
  /* 14.2.4 */
  'composition.add'(state, payload, draw) {
    const name = text(payload, 'name');
    const ids = clipIdList(payload, 'composition.add');
    for (const id of ids) clipOf(state, id);
    if (payload.trackId !== undefined || payload.at !== undefined) invalid('composition.add takes no trackId and no at');
    gather(state, name, ids, 'sequence', draw);
  },

  /* 14.2.5 */
  'clip.group'(state, payload, draw) {
    const ids = clipIdList(payload, 'clip.group');
    for (const id of ids) clipOf(state, id);
    if (payload.name !== undefined && typeof payload.name !== 'string') invalid('name must be a string');
    gather(state, payload.name ?? 'Group', ids, 'composite-2d', draw);
  },

  /* 14.2.6 */
  'clip.ungroup'(state, payload, draw) {
    const wrapper = namedClip(state, payload, 'groupId');
    const composition = wrapper.type === 'composition' ? compositionOf(state, wrapper.compositionId) : undefined;
    if (composition?.editorKind !== 'composite-2d') invalid('groupId is not a group');
    dissolve(state, wrapper, draw);
  },

  /* 14.4.1 */
  'composition.setPublishedControls'(state, payload, draw) {
    const compositionId = text(payload, 'compositionId');
    const composition = compositionOf(state, compositionId) ?? invalid(`compositionId: "${compositionId}" is not in the project`);
    if (composition.editorKind !== 'composite-2d') invalid('only a group publishes controls');
    if (!Array.isArray(payload.controls)) invalid('controls must be a list');
    const asked = payload.controls.map((control) => {
      if (!control || typeof control !== 'object') invalid('a control must be an object');
      return { ...control, id: typeof control.id === 'string' && control.id ? control.id : draw() };
    });
    const trimmed = (value) => (typeof value === 'string' && value.trim() ? value.trim() : null);
    const read = {
      'text.text': (item) => (item.type === 'text' && !item.textSpans?.length ? item.text : null),
      'text.color': (item) => (item.type === 'text' && !item.textSpans?.length ? item.color : null),
      'shape.fillColor': (item) => (item.type === 'shape' && item.fillType !== 'linear' ? item.fillColor : null),
      'shape.strokeColor': (item) => (item.type === 'shape' && item.strokeEnabled && item.strokeColor ? item.strokeColor : null),
    };
    const ids = new Set();
    const targets = new Set();
    const controls = asked.map((control) => {
      const [id, name, targetItemId] = [trimmed(control.id), trimmed(control.name), trimmed(control.targetItemId)];
      const target = composition.items.find((item) => item.id === targetItemId);
      const value = target && read[control.property] ? read[control.property](target) : null;
      const key = `${targetItemId}:${control.property}`;
      if (!id || !name || !target || value === null || value === undefined || ids.has(id) || targets.has(key))
        invalid('controls: each needs a name, a clip of this composition and a property it can drive, once');
      ids.add(id);
      targets.add(key);
      return {
        id,
        name,
        targetItemId,
        property: control.property,
        kind: control.property === 'text.text' ? 'text' : 'color',
        defaultValue: typeof control.defaultValue === 'string' ? control.defaultValue : value,
      };
    });
    state.compositions = state.compositions.map((other) =>
      other.id === compositionId
        ? controls.length > 0
          ? { ...other, compositionControls: { version: 1, controls } }
          : without(other, 'compositionControls')
        : other,
    );
  },

  /* 14.4.2 */
  'composition.setControlOverrides'(state, payload) {
    const clip = namedClip(state, payload, 'compositionClipId');
    if (clip.type !== 'composition') invalid('compositionClipId is not a composition');
    const controls = compositionOf(state, clip.compositionId)?.compositionControls?.controls ?? [];
    const { overrides } = payload;
    if (!plainObject(overrides)) invalid('overrides must be an object');
    const colour = /^(#[0-9a-f]{3,4}|#[0-9a-f]{6}|#[0-9a-f]{8}|(rgb|rgba|hsl|hsla)\([0-9.,%\s/+-]+\))$/i;
    for (const [id, value] of Object.entries(overrides)) {
      const control = controls.find((entry) => entry.id === id) ?? invalid(`overrides: "${id}" is not a published control`);
      if (typeof value !== 'string' || value.length > 2000) invalid(`overrides.${id} must be text`);
      if (control.kind === 'color' && !colour.test(value.trim())) invalid(`overrides.${id} must be a colour`);
    }
    replace(state, Object.keys(overrides).length > 0 ? { ...clip, compositionControlOverrides: overrides } : without(clip, 'compositionControlOverrides'));
  },

  /* 14.3.1 */
  /* 17.4 */
  'shape.add'(state, payload, draw) {
    const command = 'shape.add';
    for (const key of Object.keys(payload)) if (!['shapeType', 'at', 'duration', 'trackId', 'style', 'transform', 'mask'].includes(key)) invalid(`${command}: unknown field`);
    const { shapeType } = payload;
    if (!['rectangle', 'circle', 'triangle', 'ellipse', 'star', 'polygon', 'heart', 'path'].includes(shapeType)) invalid(`${command}: shapeType is not a shape type`);
    const from = time(state, payload, 'at');
    const length = payload.duration === undefined ? framesOf({ num: 60, den: 1 }, state.rate) : time(state, payload, 'duration');
    if (length < 1) invalid('duration must be at least one frame');
    let track;
    if (payload.trackId !== undefined) {
      const trackId = text(payload, 'trackId');
      track = state.tracks.find((candidate) => candidate.id === trackId) ?? invalid(`trackId: track "${trackId}" does not exist`);
      if (track.isGroup) invalid(`trackId: track "${trackId}" is a group`);
      if ((track.kind ?? 'video') !== 'video') invalid('trackId: a shape needs a video track');
    }
    const isPath = shapeType === 'path';
    const side = Math.min(state.canvas.width, state.canvas.height) * 0.25;
    const id = draw();
    let shape = { id, type: 'shape', trackId: track?.id, from, durationInFrames: length, label: isPath ? 'Path' : shapeType[0].toUpperCase() + shapeType.slice(1), shapeType, fillColor: '#3b82f6' };
    if (isPath) {
      Object.assign(shape, { fillEnabled: false, strokeColor: '#3b82f6', strokeWidth: 4, strokeEnabled: true, strokeLineCap: 'round', strokeLineJoin: 'round', strokeMiterLimit: 4, pathClosed: true });
    } else {
      shape.strokeWidth = 0;
      if (shapeType === 'rectangle') shape.cornerRadius = 0;
      if (shapeType === 'triangle') shape.direction = 'up';
      if (shapeType === 'star') Object.assign(shape, { points: 5, innerRadius: 0.5 });
      if (shapeType === 'polygon') shape.points = 6;
    }
    if (isPath && (!plainRecord(payload.style) || payload.style.pathVertices === undefined)) invalid(`${command}: a path needs style.pathVertices`);
    if (payload.mask !== undefined) {
      const { mask } = payload;
      if (!plainRecord(mask)) invalid(`${command}: mask must be an object`);
      for (const key of Object.keys(mask)) if (!['type', 'feather', 'opacity', 'invert'].includes(key)) invalid(`${command}: unknown mask field`);
      if (mask.type !== undefined && mask.type !== 'clip' && mask.type !== 'alpha') invalid(`${command}: mask type must be "clip" or "alpha"`);
      for (const name of ['feather', 'opacity']) if (mask[name] !== undefined && !finite(mask[name], 0, 100)) invalid(`${command}: mask ${name} must be a number from 0 to 100`);
      if (mask.invert !== undefined && typeof mask.invert !== 'boolean') invalid(`${command}: mask invert must be a boolean`);
      const type = mask.type ?? 'clip';
      Object.assign(shape, { isMask: true, blendMode: 'normal', maskType: type, maskFeather: mask.feather ?? (type === 'alpha' ? 10 : 0), maskOpacity: mask.opacity ?? 100, maskInvert: mask.invert ?? false, pathClosed: true });
    }
    if (payload.style !== undefined) shape = styledShape(command, payload.style, shape);
    const transform = { x: 0, y: 0, width: side, height: side, rotation: 0, opacity: 1, aspectRatioLocked: !isPath };
    if (payload.transform !== undefined) {
      const box = payload.transform;
      if (!plainRecord(box)) invalid(`${command}: transform must be an object`);
      const checks = { x: finite, y: finite, width: (n) => finite(n) && n > 0, height: (n) => finite(n) && n > 0, rotation: between(0, 360).check, opacity: between(0, 1).check, aspectRatioLocked: bool.check };
      for (const key of Object.keys(box)) if (!Object.hasOwn(checks, key)) invalid(`${command}: unknown transform field "${key}"`);
      for (const [key, check] of Object.entries(checks)) {
        if (box[key] === undefined) continue;
        if (!check(box[key])) invalid(`${command}: transform.${key} is outside its type or range`);
        transform[key] = box[key];
      }
    }
    shape.transform = transform;
    if (track) {
      if (track.locked) failed(`${command}: the track is locked`);
      // The place, as for a title (14.3.1).
      let start = from;
      for (const other of state.items.filter((item) => item.trackId === track.id).sort((a, b) => a.from - b.from)) {
        if (end(other) <= start) continue;
        if (other.from >= start + length) break;
        start = end(other);
      }
      state.items.push({ ...shape, from: start });
      return;
    }
    // A new layer above every video track.
    const byOrder = state.tracks.toSorted((a, b) => a.order - b.order);
    const kindOf = (candidate) => candidate.kind ?? (/^V\d+$/i.test(candidate.name) ? 'video' : /^A\d+$/i.test(candidate.name) ? 'audio' : null);
    const anchor = byOrder.find((candidate) => kindOf(candidate) === 'video') ?? byOrder.find((candidate) => kindOf(candidate) === 'audio');
    const layer = newTrack(state, 'video', anchor ? anchor.order - 1 : 0, draw);
    state.tracks = writeTracks([...state.tracks, layer]);
    state.items.push({ ...shape, trackId: layer.id });
  },

  /* 17.5 */
  'shape.setStyle'(state, payload) {
    const command = 'shape.setStyle';
    for (const key of Object.keys(payload)) if (key !== 'clipId' && key !== 'style') invalid(`${command}: unknown field`);
    const clipId = text(payload, 'clipId');
    const clip = state.items.find((entry) => entry.id === clipId) ?? invalid(`clipId: clip "${clipId}" does not exist`);
    if (clip.type !== 'shape') invalid(`${command} requires a shape clip`);
    if (!plainRecord(payload.style)) invalid(`${command}: style must be an object`);
    refuseLocked(state, [clip.id], command);
    replace(state, styledShape(command, payload.style, clip));
  },

  /* 14.3.4 */
  'title.setStyle'(state, payload) {
    const command = 'title.setStyle';
    for (const key of Object.keys(payload)) if (!['clipId', 'style', 'spans', 'spanLayout'].includes(key)) invalid(`${command}: unknown field`);
    const clipId = text(payload, 'clipId');
    const clip = state.items.find((entry) => entry.id === clipId) ?? invalid(`clipId: clip "${clipId}" does not exist`);
    if (clip.type !== 'text') invalid(`${command} requires a title`);
    const { style, spans, spanLayout } = payload;
    if (!plainRecord(style)) invalid(`${command}: style must be an object`);
    refuseLocked(state, [clip.id], command);
    for (const key of Object.keys(style)) {
      if (key !== 'textStyleScale' && ![...TITLE_FIELDS, ...TITLE_OBJECTS].some(([name]) => name === key)) invalid(`${command}: unknown style field "${key}"`);
    }
    let next = { ...clip };
    if (style.textStyleScale !== undefined) {
      if (!finite(style.textStyleScale, 0.5, 6)) invalid(`${command}: style.textStyleScale must be a number from 0.5 to 6`);
      if (!clip.textStylePresetId) invalid(`${command}: style.textStyleScale needs a title with a style preset`);
      const { set, remove } = scaledStyle(state, clip.textStylePresetId, style.textStyleScale);
      next = { ...without(next, ...remove), ...set };
    }
    for (const [name, { check, expects }, clearable = true] of TITLE_FIELDS) {
      const given = style[name];
      if (given === undefined) continue;
      if (given === null) {
        if (!clearable) invalid(`${command}: style.${name} cannot be cleared`);
        next = without(next, name);
      } else {
        if (!check(given)) invalid(`${command}: style.${name} must be ${expects}`);
        next[name] = given;
      }
    }
    for (const [name, fields] of TITLE_OBJECTS) {
      const given = style[name];
      if (given === undefined) continue;
      if (given === null) {
        next = without(next, name);
        continue;
      }
      if (!plainRecord(given)) invalid(`${command}: style.${name} must be an object or null`);
      for (const key of Object.keys(given)) if (!fields.some(([field]) => field === key)) invalid(`${command}: unknown style.${name} field "${key}"`);
      const written = {};
      for (const [field, { check, expects }] of fields) {
        if (!check(given[field])) invalid(`${command}: style.${name}.${field} must be ${expects}`);
        written[field] = given[field];
      }
      next[name] = written;
    }
    if (spans === null) {
      next = without(next, 'textSpans');
    } else if (spans !== undefined) {
      if (!Array.isArray(spans) || spans.length < 1 || spans.length > 64) invalid(`${command}: spans must be null or 1 to 64 spans`);
      const written = spans.map((span) => {
        if (!plainRecord(span)) invalid(`${command}: a span must be an object`);
        for (const key of Object.keys(span)) if (key !== 'text' && !SPAN_FIELDS.some(([name]) => name === key)) invalid(`${command}: unknown span field "${key}"`);
        if (typeof span.text !== 'string') invalid(`${command}: a span needs text`);
        const entry = { text: span.text };
        for (const [name, { check, expects }] of SPAN_FIELDS) {
          if (span[name] === undefined) continue;
          if (!check(span[name])) invalid(`${command}: span ${name} must be ${expects}`);
          entry[name] = span[name];
        }
        return entry;
      });
      const words = written.map((span) => span.text).join('\n');
      Object.assign(next, { textSpans: written, text: words, label: words.split('\n')[0].trim() || 'Text' });
    }
    if (spanLayout === null) {
      next = without(next, 'spanLayout');
    } else if (spanLayout !== undefined) {
      if (spanLayout !== 'stack' && spanLayout !== 'inline') invalid(`${command}: spanLayout must be "stack", "inline" or null`);
      next.spanLayout = spanLayout;
    }
    replace(state, next);
  },

  'title.add'(state, payload, draw) {
    const words = text(payload, 'text');
    const from = time(state, payload, 'at');
    const length = payload.duration === undefined ? framesOf({ num: 3, den: 1 }, state.rate) : time(state, payload, 'duration');
    if (length < 1) invalid('duration must be at least one frame');
    const track = state.tracks.find((candidate) => !candidate.isGroup && (candidate.kind ?? 'video') === 'video') ?? invalid('title.add: the project has no video track');
    for (const field of ['style', 'position', 'animation']) {
      if (payload[field] !== undefined && typeof payload[field] !== 'string') invalid(`${field} must be a string`);
    }
    let title = { id: draw(), type: 'text', trackId: track.id, from, durationInFrames: length, label: words.slice(0, 64), text: words, color: '#ffffff', fontSize: 80 };
    if (payload.style) title = withStyle(state, title, payload.style);
    if (payload.position) title = { ...title, ...titlePosition(payload.position) };
    if (payload.animation) title = { ...title, textMotion: titleMotion(payload.animation) };
    // A place that is taken: the title starts where the clips in its way end.
    let start = Math.max(0, from);
    for (const other of state.items.filter((item) => item.trackId === track.id).sort((a, b) => a.from - b.from)) {
      if (end(other) <= start) continue;
      if (other.from >= start + length) break;
      start = end(other);
    }
    state.items.push({ ...title, from: start });
  },

  /* 14.7 */
  'project.setMasterAudio'(state, payload) {
    for (const key of Object.keys(payload)) {
      if (!['gainDb', 'muted', 'ducking', 'gainEnvelope'].includes(key)) invalid(`project.setMasterAudio: unknown field "${key}"`);
    }
    const gainDb = payload.gainDb;
    if (gainDb !== undefined && !finite(gainDb)) invalid('gainDb must be a number');
    if (gainDb !== undefined && (gainDb < -60 || gainDb > 12)) invalid('gainDb must be between -60 and 12 dB');
    if (payload.muted !== undefined && typeof payload.muted !== 'boolean') invalid('muted must be a boolean');
    if (payload.ducking !== undefined) {
      if (typeof payload.ducking !== 'boolean') invalid('ducking must be a boolean');
      throw new Refusal('not-implemented', 'ducking: the engine has no project-wide ducking switch');
    }
    let points;
    if (payload.gainEnvelope !== undefined) {
      if (!Array.isArray(payload.gainEnvelope) || payload.gainEnvelope.length > 4096) invalid('Invalid gainEnvelope');
      const ids = new Set(), frames = new Set();
      points = payload.gainEnvelope.map(point => {
        if (!point || typeof point !== 'object' || Array.isArray(point) || Object.keys(point).some(key => !['id','at','gainDb'].includes(key))) invalid('Invalid gainEnvelope');
        const id=text(point,'id'), frame=time(state,point,'at'), db=point.gainDb;
        if ([...id].length>128 || ids.has(id) || frames.has(frame) || !finite(db) || db < -60 || db > 12) invalid('Invalid gainEnvelope');
        ids.add(id);frames.add(frame);
        return {id,frame,gainDb:db};
      }).sort((a,b)=>a.frame-b.frame);
    }
    if (gainDb === undefined && payload.muted === undefined && points === undefined) invalid('project.setMasterAudio needs gainDb or muted');
    if (gainDb !== undefined) state.timeline.masterBusDb = gainDb;
    if (payload.muted !== undefined) state.timeline.masterBusMuted = payload.muted;
    if (points !== undefined) {
      if (points.length) state.timeline.masterGainEnvelope=points;
      else delete state.timeline.masterGainEnvelope;
    }
  },

  /* 14.6.1 */
  'sequence.setSettings'(state, payload) {
    const sequenceId = text(payload, 'sequenceId');
    let rate;
    if (payload.fps !== undefined) {
      const { fps } = payload;
      const exact = isRational(fps) && fps.num > 0 ? exactRate(fps.num / fps.den) : null;
      const matches = exact && exact.num * fps.den === fps.num * exact.den;
      const offered = exact && (exact.den === 1 ? catalogue.project.rates.includes(exact.num) : catalogue.project.ntscRates.some((entry) => entry.num === exact.num));
      if (!matches || !offered) invalid('fps must be a project frame rate');
      rate = exact;
    }
    const side = (name, least, most) => {
      const value = payload[name];
      if (value === undefined) return undefined;
      if (!Number.isSafeInteger(value) || value < least || value > most) invalid(`${name} must be a whole number of pixels from ${least} to ${most}`);
      return value;
    };
    const settings = { rate, width: side('width', 320, 7680), height: side('height', 240, 4320) };
    if (!rate && settings.width === undefined && settings.height === undefined) invalid('sequence.setSettings needs fps, width or height');
    applySettings(state, sequenceId, settings, timingOf(payload));
  },

  /* 14.6.2 */
  'project.applyTemplate'(state, payload) {
    const templateId = text(payload, 'templateId');
    const template = catalogue.project.templates.find((entry) => entry.id === templateId) ?? invalid(`templateId: template "${templateId}" does not exist`);
    applySettings(state, 'main', { rate: exactRate(template.fps), width: template.width, height: template.height }, timingOf(payload));
  },
});

/**
 * Apply a batch of envelopes to a graph in normal form, as section 7.2 says: all or nothing,
 * with the first failing envelope's index and reason.
 */
export function applyBatch(graph, envelopes, media = []) {
  const state = open(graph, media);
  for (const [index, envelope] of envelopes.entries()) {
    const command = commands[envelope.id];
    if (!command) return { status: 'rejected', index, reason: 'not-implemented', detail: `${envelope.id} is not an engine command` };
    const before = lastFrame(state);
    try {
      command(state, envelope.payload ?? {}, uuidStream(`${envelope.idempotencyKey}:${index}`), envelope.id);
    } catch (error) {
      if (error instanceof Refusal) return { status: 'rejected', index, reason: error.reason, detail: error.message };
      throw error;
    }
    // 12.2.7: when the last frame of the timeline moved, the in and out points are clamped to it.
    if (lastFrame(state) !== before) clamp(state);
  }
  return { status: 'applied', graph: close(graph, state) };
}
