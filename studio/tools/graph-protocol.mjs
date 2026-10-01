/**
 * The computable rules of the Studio graph protocol v1 (FL-306), implemented from
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
  'minLength', 'pattern', '$ref', 'allOf', 'anyOf', 'oneOf', 'if', 'then',
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
      if (node.minLength !== undefined && data.length < node.minLength) fail('too short');
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
