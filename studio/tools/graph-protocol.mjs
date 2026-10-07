/**
 * The computable rules of the Studio graph protocol v1 (FL-306, FL-307), implemented from
 * `docs/docs/developer/studio-graph-protocol-v1.md` alone, without the engine.
 *
 * `graph-protocol.test.mjs` checks this implementation against the engine-generated fixtures in
 * `studio/graph-conformance-v1.json`: if the prose and the engine disagree, one of them is wrong.
 * It runs in the Scripts unit tests, which have no engine workspace.
 */
import { createHash } from 'node:crypto';

/* Canonical serialisation (protocol section "Canonical serialisation and digests") */

const compareKeys = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry === undefined ? null : entry)).join(',')}]`;
  }
  const keys = Object.keys(value)
    .filter((key) => value[key] !== undefined)
    .sort(compareKeys);
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

export const sha256Hex = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

export const graphDigest = (graph) => sha256Hex(canonicalJson(graph));

export const envelopeDigest = (graph, engineRevision) =>
  sha256Hex(canonicalJson({ schemaVersion: 1, engine: 'freecut', engineRevision, graph }));

/* Time (protocol section "Time, duration and rate") */

/** Nearest frame to `time` seconds at `rate` frames per second, halves towards +infinity. */
export function framesOf(time, rate) {
  const numerator = BigInt(time.num) * BigInt(rate.num);
  const denominator = BigInt(time.den) * BigInt(rate.den);
  const doubled = 2n * numerator + denominator;
  const twice = 2n * denominator;
  const quotient = doubled >= 0n ? doubled / twice : -((-doubled + twice - 1n) / twice);
  const frames = Number(quotient);
  return Number.isSafeInteger(frames) ? frames : null;
}

/* Identities (protocol section "Ids") */

const u32 = (value) => value >>> 0;
const rotl = (value, bits) => u32((value << bits) | (value >>> (32 - bits)));

/** The 32-bit output stream for a seed string: step 1 (seed hash) and step 2 (generator). */
function stream(seed) {
  let h = u32(1779033703 ^ seed.length);
  for (let index = 0; index < seed.length; index++) {
    h = u32(Math.imul(h ^ seed.charCodeAt(index), 3432918353));
    h = rotl(h, 13);
  }
  const mix = () => {
    h = u32(Math.imul(h ^ (h >>> 16), 2246822507));
    h = u32(Math.imul(h ^ (h >>> 13), 3266489909));
    h = u32(h ^ (h >>> 16));
    return h;
  };
  let [a, b, c, d] = [mix(), mix(), mix(), mix()];
  return () => {
    let t = u32(a + b);
    a = u32(b ^ (b >>> 9));
    b = u32(c + u32(c << 3));
    c = rotl(c, 21);
    d = u32(d + 1);
    t = u32(t + d);
    c = u32(c + t);
    return t;
  };
}

/** The identity stream of `seed`: each id takes the high byte of 16 consecutive outputs. */
export function uuidStream(seed) {
  const next = stream(seed);
  return () => {
    const bytes = Array.from({ length: 16 }, () => next() >>> 24);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = bytes.map((byte) => byte.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  };
}

/* JSON Schema: the keyword subset `studio/graph-schema-v1.json` declares */

const typeOf = (value) =>
  value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value === 'number' && Number.isInteger(value) ? 'integer' : typeof value;

const matchesType = (value, type) =>
  type === 'number' ? typeof value === 'number' && Number.isFinite(value) : type === typeOf(value);

const SUPPORTED = new Set([
  '$schema', '$id', '$defs', 'title', 'description', 'type', 'const', 'enum', 'required', 'properties',
  'additionalProperties', 'items', 'minItems', 'maxItems', 'minimum', 'maximum', 'exclusiveMinimum',
  'minLength', 'maxLength', 'pattern', '$ref', 'allOf', 'anyOf', 'oneOf', 'if', 'then',
]);

export function validate(schema, value) {
  const resolve = (reference) => {
    if (!reference.startsWith('#/')) throw new Error(`Unsupported $ref ${reference}`);
    return reference.slice(2).split('/').reduce((node, key) => node?.[key], schema);
  };
  const errors = [];
  const check = (node, data, at) => {
    if (node === true) return true;
    if (node === false) return false;
    for (const keyword of Object.keys(node)) {
      if (!SUPPORTED.has(keyword)) throw new Error(`Unsupported schema keyword ${keyword} at ${at}`);
    }
    const local = [];
    const fail = (message) => local.push(`${at || '$'}: ${message}`);
    if (node.$ref && !check(resolve(node.$ref), data, at)) fail(`does not match ${node.$ref}`);
    if (node.type) {
      const types = [node.type].flat();
      if (!types.some((type) => matchesType(data, type))) fail(`is ${typeOf(data)}, not ${types.join('|')}`);
    }
    if ('const' in node && canonicalJson(node.const) !== canonicalJson(data)) fail(`must be ${JSON.stringify(node.const)}`);
    if (node.enum && !node.enum.some((option) => canonicalJson(option) === canonicalJson(data))) {
      fail(`must be one of ${node.enum.join(', ')}`);
    }
    if (typeof data === 'number') {
      if (node.minimum !== undefined && data < node.minimum) fail(`below ${node.minimum}`);
      if (node.maximum !== undefined && data > node.maximum) fail(`above ${node.maximum}`);
      if (node.exclusiveMinimum !== undefined && data <= node.exclusiveMinimum) fail(`not above ${node.exclusiveMinimum}`);
    }
    if (typeof data === 'string') {
      if (node.minLength !== undefined && [...data].length < node.minLength) fail('too short');
      if (node.maxLength !== undefined && [...data].length > node.maxLength) fail('too long');
      if (node.pattern && !new RegExp(node.pattern, 'u').test(data)) fail(`does not match ${node.pattern}`);
    }
    if (Array.isArray(data)) {
      if (node.minItems !== undefined && data.length < node.minItems) fail(`has fewer than ${node.minItems} items`);
      if (node.maxItems !== undefined && data.length > node.maxItems) fail(`has more than ${node.maxItems} items`);
      if (node.items) data.forEach((entry, index) => check(node.items, entry, `${at}[${index}]`) || fail(`[${index}] is invalid`));
    }
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      for (const key of node.required ?? []) if (!(key in data)) fail(`misses ${key}`);
      for (const [key, entry] of Object.entries(data)) {
        const declared = node.properties?.[key];
        const at2 = at ? `${at}.${key}` : key;
        if (declared !== undefined) {
          if (!check(declared, entry, at2)) fail(`${key} is invalid`);
        } else if (node.additionalProperties !== undefined && !check(node.additionalProperties, entry, at2)) {
          fail(`${key} is not allowed`);
        }
      }
    }
    for (const part of node.allOf ?? []) if (!check(part, data, at)) fail('fails allOf');
    if (node.anyOf && !node.anyOf.some((part) => quiet(part, data, at))) fail('matches no anyOf branch');
    if (node.oneOf && node.oneOf.filter((part) => quiet(part, data, at)).length !== 1) fail('matches not exactly one oneOf branch');
    if (node.if && quiet(node.if, data, at) && node.then && !check(node.then, data, at)) fail('fails then');
    errors.push(...local);
    return local.length === 0;
  };
  const quiet = (node, data, at) => {
    const before = errors.length;
    const ok = check(node, data, at);
    errors.length = before;
    return ok;
  };
  check(schema, value, '');
  return errors;
}

/* Part 2 (protocol section 12): rules that can be computed from a graph and a payload alone */

/** Section 3.2, step 2: the exact reading of a rate stored as a number, or null when it has none. */
export function exactRate(fps) {
  if (!Number.isFinite(fps) || fps <= 0) return null;
  if (Number.isInteger(fps)) return { num: fps, den: 1 };
  for (const num of [24000, 30000, 48000, 60000, 120000]) {
    const exact = num / 1001;
    if (Math.abs(fps - exact) < 1e-9 || fps === Math.round(exact * 1000) / 1000) return { num, den: 1001 };
  }
  return null;
}

/**
 * 14.5.1: `frame` counted at `from` frames per second, as a frame at `to`: the nearest frame, exact
 * halves away from zero. Not the rule of section 3.3, which sends a negative half up.
 */
export function carryFrame(frame, from, to) {
  const [a, b] = [exactRate(from), exactRate(to)];
  if (!a || !b) return null;
  const numerator = BigInt(b.num) * BigInt(a.den);
  const denominator = BigInt(b.den) * BigInt(a.num);
  const scaled = (2n * BigInt(Math.abs(frame)) * numerator + denominator) / (2n * denominator);
  // The sign is put back by multiplying, so a count that rounds to nothing is 0 or -0 as the engine has it.
  return Number((frame < 0 ? -1n : 1n) * scaled);
}

/**
 * 14.2.3: what one load makes of a graph that settles on load. Every track of a composition has a
 * sync lock, and a track of the main timeline lists no items.
 */
export function settle(graph) {
  const { timeline } = graph;
  if (!timeline) return graph;
  return {
    ...graph,
    timeline: {
      ...timeline,
      tracks: timeline.tracks.map((track) => ((track.items?.length ?? 0) > 0 ? { ...track, items: [] } : track)),
      ...(timeline.compositions
        ? {
            compositions: timeline.compositions.map((composition) => ({
              ...composition,
              tracks: composition.tracks.map((track) => (track.syncLock === undefined ? { ...track, syncLock: true } : track)),
            })),
          }
        : {}),
    },
  };
}

/** 12.2.4: timeline frames to source frames, in doubles, in the order written. */
export const toSource = (frames, fps, sourceFps = fps, speed = 1) => Math.floor((frames / fps) * sourceFps * speed + 0.5);

/** 12.2.4: source frames to timeline frames, in doubles, in the order written. */
export const toTimeline = (frames, fps, sourceFps = fps, speed = 1) => Math.floor(((frames / sourceFps) * fps) / speed);

const MEDIA = new Set(['video', 'audio', 'composition']);
export const isMediaClip = (item) => MEDIA.has(item.type);
const endOf = (item) => item.from + item.durationInFrames;

/** 12.2.5: the source windows of the two halves of a media clip split after `left` of its frames. */
export function splitSource(item, left, fps) {
  const start = item.sourceStart ?? 0;
  const cut = start + toSource(left, fps, item.sourceFps ?? fps, item.speed ?? 1);
  const end = start + toSource(item.durationInFrames, fps, item.sourceFps ?? fps, item.speed ?? 1);
  return { left: { sourceStart: start, sourceEnd: cut }, right: { sourceStart: cut, sourceEnd: end } };
}

/** 12.2.4: a clip after its start is trimmed by `amount` frames (positive shortens). */
export function trimStart(item, amount, fps) {
  const next = { ...item, from: item.from + amount, durationInFrames: item.durationInFrames - amount };
  if (isMediaClip(item)) {
    next.sourceStart = (item.sourceStart ?? 0) + toSource(amount, fps, item.sourceFps ?? fps, item.speed ?? 1);
  }
  return next;
}

/** 12.2.4: a clip after its end is trimmed by `amount` frames (positive lengthens). */
export function trimEnd(item, amount, fps) {
  const next = { ...item, durationInFrames: item.durationInFrames + amount };
  if (isMediaClip(item)) {
    const start = item.sourceStart ?? 0;
    const frames = (count) => toSource(count, fps, item.sourceFps ?? fps, item.speed ?? 1);
    // A clip with no sourceEnd gets one from its new length; otherwise the end moves with the trim.
    const moved = Math.max(start + 1, item.sourceEnd === undefined ? start + frames(next.durationInFrames) : item.sourceEnd + frames(amount));
    next.sourceEnd = item.sourceDuration === undefined ? moved : Math.min(item.sourceDuration, moved);
  }
  return next;
}

/** 12.4.5: the length and stored speed of a clip retimed to `speed` (a rational), or null when its rate is inexact. */
export function retime(item, speed, metadata) {
  const span = item.sourceEnd - (item.sourceStart ?? 0);
  const source = exactRate(item.sourceFps ?? metadata.fps);
  if (!source) return null;
  const project = metadata.frameRate;
  // span / sourceRate / speed * projectRate, to the nearest frame, halves up, in exact integers.
  const numerator = BigInt(span) * BigInt(source.den) * BigInt(speed.den) * BigInt(project.num);
  const denominator = BigInt(source.num) * BigInt(speed.num) * BigInt(project.den);
  const durationInFrames = Number((2n * numerator + denominator) / (2n * denominator));
  const derived = (span * metadata.fps) / (durationInFrames * (item.sourceFps ?? metadata.fps));
  return { durationInFrames, speed: Math.max(0.1, Math.min(16, derived)) };
}

/** Section 5: every pair of clips on one track that share a frame and that no transition joins. */
export function overlapsOf(graph) {
  const joined = new Set();
  for (const transition of graph.timeline.transitions ?? []) {
    joined.add(`${transition.leftClipId}|${transition.rightClipId}`);
    joined.add(`${transition.rightClipId}|${transition.leftClipId}`);
  }
  const found = [];
  for (const [trackId, items] of Map.groupBy(graph.timeline.items ?? [], (item) => item.trackId)) {
    const sorted = items.toSorted((a, b) => a.from - b.from);
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length && sorted[j].from < endOf(sorted[i]); j++) {
        if (!joined.has(`${sorted[i].id}|${sorted[j].id}`)) found.push(`${trackId}: ${sorted[i].id} and ${sorted[j].id}`);
      }
    }
  }
  return found;
}

/** 12.2.8: the name each track with a classic name must have, by position. */
export function classicNames(tracks) {
  const names = new Map();
  const classic = (kind, pattern) => tracks.filter((track) => track.kind === kind && pattern.test(track.name));
  classic('video', /^V\d+$/i)
    .toSorted((a, b) => b.order - a.order)
    .forEach((track, index) => names.set(track.id, `V${index + 1}`));
  classic('audio', /^A\d+$/i)
    .toSorted((a, b) => a.order - b.order)
    .forEach((track, index) => names.set(track.id, `A${index + 1}`));
  return names;
}

/** 12.2.8: a track list as a command writes it: ascending order (ties keep their order), classic names renumbered. */
export function writeTracks(tracks) {
  const list = tracks
    .map((track, index) => ({ track, index }))
    .sort((a, b) => a.track.order - b.track.order || a.index - b.index)
    .map(({ track }) => track);
  const names = classicNames(list);
  return list.map((track) => (names.has(track.id) ? { ...track, name: names.get(track.id) } : track));
}

/** 12.2.8: the first name of a track a command creates. */
export function firstTrackName(tracks, kind) {
  const [letter, pattern] = kind === 'video' ? ['V', /^V\d+$/i] : ['A', /^A\d+$/i];
  const used = new Set(
    tracks.filter((track) => track.kind === kind && pattern.test(track.name)).map((track) => Number(track.name.slice(1))),
  );
  let next = 1;
  while (used.has(next)) next++;
  return `${letter}${next}`;
}

/** 12.2.7: in and out points clamped to an extent whose last frame is `last`. */
export function clampInOut(inPoint, outPoint, last, fps) {
  const max = Math.max(last, Math.floor(10 * fps), 1);
  let a = inPoint === undefined ? undefined : Math.max(0, Math.min(max, inPoint));
  let b = outPoint === undefined ? undefined : Math.max(1, Math.min(max, outPoint));
  if (a !== undefined && b !== undefined && a >= b) {
    if (a >= max) [a, b] = [Math.max(0, max - 1), max];
    else b = Math.min(max, a + 1);
  }
  return { inPoint: a, outPoint: b };
}

/** 12.2.6, rules 1 to 4: whether repair keeps a transition, before any change of its length. */
export function transitionKept(transition, graph) {
  const items = new Map((graph.timeline.items ?? []).map((item) => [item.id, item]));
  const left = items.get(transition.leftClipId);
  const right = items.get(transition.rightClipId);
  if (!left || !right) return false;
  if (left.trackId !== right.trackId) return false;
  if (right.from > endOf(left) + 1) return false;
  return [left, right].every((item) => ['video', 'image', 'composition'].includes(item.type));
}

/* Part 2 reference replays: commands whose whole effect a few lines of the prose give */

/** 12.8: the marker list after a marker command; `draw` yields the envelope's next id. */
export function applyMarkerCommand(markers, envelope, rate, draw) {
  const { id, payload } = envelope;
  if (id === 'marker.add') {
    const marker = { id: draw(), frame: framesOf(payload.at, rate), color: payload.colour ?? '#3B82F6' };
    if (payload.name) marker.label = payload.name;
    return [...markers, marker];
  }
  if (id === 'marker.remove') return markers.filter((marker) => marker.id !== payload.markerId);
  if (id === 'marker.update') {
    return markers.map((marker) => {
      if (marker.id !== payload.markerId) return marker;
      const next = { ...marker };
      if (payload.patch.name !== undefined) {
        if (payload.patch.name) next.label = payload.patch.name;
        else delete next.label;
      }
      if (payload.patch.colour !== undefined) next.color = payload.patch.colour;
      if (payload.patch.at !== undefined) next.frame = framesOf(payload.patch.at, rate);
      return next;
    });
  }
  throw new Error(`not a marker command: ${id}`);
}

/** 12.7.1 to 12.7.4: the track list after a track command (not `track.closeGap`); `draw` yields the next id. */
export function applyTrackCommand(tracks, envelope, draw) {
  const { id, payload } = envelope;
  const sorted = tracks.toSorted((a, b) => a.order - b.order);
  if (id === 'track.add') {
    const orders = tracks.map((track) => track.order);
    const { index, kind } = payload;
    const order =
      index === undefined
        ? kind === 'video'
          ? Math.min(0, ...orders) - 1
          : Math.max(0, ...orders) + 1
        : index === 0
          ? (sorted[0]?.order ?? 0) - 1
          : index >= sorted.length
            ? (sorted.at(-1)?.order ?? 0) + 1
            : (sorted[index - 1].order + sorted[index].order) / 2;
    const created = {
      id: `track-${draw()}`,
      name: payload.name || firstTrackName(tracks, kind),
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
    return writeTracks([...tracks, created]);
  }
  if (id === 'track.remove') return writeTracks(tracks.filter((track) => track.id !== payload.trackId));
  if (id === 'track.reorder') {
    const moved = sorted.find((track) => track.id === payload.trackId);
    const next = sorted.filter((track) => track !== moved);
    next.splice(payload.index, 0, moved);
    const orders = sorted.map((track) => track.order);
    const order = new Map(next.map((track, position) => [track.id, orders[position]]));
    return writeTracks(tracks.map((track) => ({ ...track, order: order.get(track.id) })));
  }
  if (id === 'track.set') {
    const { gain, ...rest } = payload.patch;
    return writeTracks(
      tracks.map((track) =>
        track.id === payload.trackId ? { ...track, ...rest, ...(gain === undefined ? {} : { volume: gain }) } : track,
      ),
    );
  }
  throw new Error(`not a track list command: ${id}`);
}
