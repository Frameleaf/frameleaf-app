/**
 * A reference implementation of part 2 of the Studio graph protocol v1 (FL-307), written from
 * section 12 of `docs/docs/developer/studio-graph-protocol-v1.md` alone, without the engine.
 *
 * `graph-protocol.test.mjs` replays the part 2 conformance fixtures through it: if the prose is
 * not enough to reproduce the engine's graphs, ids and refusals, a fixture fails here. It is what a
 * native client implements, in the smallest form that passes; it is not shipped anywhere.
 *
 * Not covered, because the prose defers them to parts 3 and 4: title styles and animations
 * (`clip.update`), poses of animated or already-parented clips (`clip.setTransformParent`),
 * keyframe rescaling and keyframe limits, and commands of other parts inside a batch.
 */
import {
  applyMarkerCommand,
  applyTrackCommand,
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
/** Raised for what parts 3 and 4 specify: the caller skips the case. */
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

/** The working state of one batch: the parts of the graph part 2 commands read and write. */
function open(graph, media) {
  const timeline = structuredClone(graph.timeline);
  return {
    fps: graph.metadata.fps,
    rate: graph.metadata.frameRate,
    canvas: { width: graph.metadata.width, height: graph.metadata.height },
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
  const { transitions, keyframes, markers, inPoint, outPoint, ...rest } = state.timeline;
  const timeline = { ...rest, tracks: state.tracks, items: state.items };
  if (state.transitions.length > 0) timeline.transitions = state.transitions;
  if (state.keyframes.length > 0) timeline.keyframes = state.keyframes;
  if (state.markers.length > 0) timeline.markers = state.markers;
  if (state.inPoint !== undefined) timeline.inPoint = state.inPoint;
  if (state.outPoint !== undefined) timeline.outPoint = state.outPoint;
  return { ...graph, timeline };
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
  state.keyframes = state.keyframes.filter((entry) => !gone.has(entry.itemId));
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
    if (state.keyframes.some((entry) => retimed.some((member) => member.id === entry.itemId))) throw new Unspecified('keyframe rescaling');
    for (const member of retimed) {
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
    for (const trackId of new Set(edit.trackIds)) {
      const overlapping = state.items
        .filter((item) => item.trackId === trackId && item.from < stop && end(item) > start)
        .map((item) => item.id);
      for (const id of overlapping) {
        let covered = clipOf(state, id);
        if (covered.from < start) covered = cut(state, covered, start, draw).right;
        if (end(covered) > stop) covered = cut(state, clipOf(state, covered.id), stop, draw).left;
        removeClips(state, linkedSet(state, [covered.id], false));
      }
    }
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
      state.keyframes = state.keyframes.filter((entry) => entry.itemId !== right.id);
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
    if (patch.style !== undefined) throw new Unspecified('title styles are part 4');
    if (patch.position !== undefined) {
      const match = typeof patch.position === 'string' ? /^([tmb])([lcr])$/.exec(patch.position) : null;
      if (!match) invalid('position: unknown title position');
      next.verticalAlign = { t: 'top', m: 'middle', b: 'bottom' }[match[1]];
      next.textAlign = { l: 'left', c: 'center', r: 'right' }[match[2]];
    }
    if (patch.animation !== undefined) throw new Unspecified('title animations are part 4');
    if (patch.volume !== undefined) {
      if (clip.type !== 'video' && clip.type !== 'audio') invalid('patch.volume applies to video and audio clips');
      if (typeof patch.volume !== 'number' || !Number.isFinite(patch.volume)) invalid('volume must be a number');
      next.volume = patch.volume;
    }
    if (patch.muted !== undefined) throw new Refusal('not-implemented', 'patch.muted: clips have no mute');
    replace(state, next);
    if (patch.transform !== undefined) {
      if (!patch.transform || typeof patch.transform !== 'object') invalid('patch.transform must be an object');
      setTransform(state, next, patch.transform);
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
      state.keyframes.some((entry) => [child.id, parent?.id].includes(entry.itemId))
    ) {
      throw new Unspecified('poses of animated or already-parented clips are part 3');
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
      refuseLocked(
        state,
        linkedSet(
          state,
          onTrack().map((item) => item.id),
        ),
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
      for (const entry of moves) move(state, entry.id, entry.from);
      repair(
        state,
        moves.map((entry) => entry.id),
      );
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
    for (const item of later) move(state, item.id, item.from - (b - a));
    const affected = removeIntervals(state, new Set([track.id]), [{ start: a, end: b }], draw);
    repair(state, [...later.map((item) => item.id), ...affected]);
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

/**
 * Apply a batch of part 2 envelopes to a graph in normal form, as section 7.2 says: all or nothing,
 * with the first failing envelope's index and reason.
 */
export function applyBatch(graph, envelopes, media = []) {
  const state = open(graph, media);
  for (const [index, envelope] of envelopes.entries()) {
    const command = commands[envelope.id];
    if (!command) throw new Unspecified(`${envelope.id} is not a part 2 command`);
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
