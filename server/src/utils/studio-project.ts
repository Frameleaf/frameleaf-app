/**
 * Studio project envelope, digest, lease and rational-time rules (FL-89, `STU-202`).
 *
 * Pure functions only: no database, no Nest, no request. The service and the repository both
 * depend on these, and the specs exercise them directly, so the rules that decide whether a save
 * is accepted are readable in one place.
 *
 * Three things live here and they are deliberately separate:
 *
 * - **The envelope.** `{ schemaVersion, engine, engineRevision, graph }` is Freecut's document
 *   wrapped in four fields the fork owns. The `graph` is opaque: this module measures it, digests
 *   it and never reads inside it. A graph field the server has never heard of survives a save and
 *   a reload byte for byte, which is the whole point of storing it rather than modelling it.
 * - **The digest.** A stable, key-sorted SHA-256 over the whole envelope. It is what makes an
 *   idempotent retry answerable: the same request key carrying the same digest is the same save,
 *   and the same key carrying a different digest is a client bug that must be reported, not
 *   silently applied over somebody's work.
 * - **The lease.** One 90-second writer lease. The numbers and the expiry arithmetic are here so
 *   that the repository's `WHERE` clauses and the client's renewal timer cannot drift apart.
 */

import { createHash } from 'node:crypto';
import { STUDIO_MAX_GRAPH_BYTES, measureStudioGraph } from 'src/utils/studio-resources.js';

/* ------------------------------------------------------------------ */
/* The envelope                                                         */
/* ------------------------------------------------------------------ */

/** The only engine this fork stores a graph for. Recorded so a future engine is a new value. */
export const STUDIO_ENGINE = 'freecut';

/** The envelope shape version. Bumping it is a migration, never a silent reinterpretation. */
export const STUDIO_ENVELOPE_SCHEMA_VERSION = 1;

/**
 * The project document exactly as it is stored.
 *
 * `graph` is `unknown` on purpose. Typing it would invite code that reads it, and the moment
 * something reads it the round trip stops being lossless.
 */
export type StudioProjectEnvelope = {
  schemaVersion: number;
  engine: string;
  /** The pinned engine revision the editor that produced this graph was built from. */
  engineRevision: string;
  graph: unknown;
};

export type StudioEnvelopeProblem =
  | 'not-an-object'
  | 'schema-version'
  | 'engine'
  | 'engine-revision'
  | 'graph-missing'
  | 'graph-too-large'
  | 'not-serializable';

export type StudioEnvelopeCheck =
  | { ok: true; envelope: StudioProjectEnvelope; graphBytes: number }
  | { ok: false; problem: StudioEnvelopeProblem; detail: string };

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

/**
 * Validate the four fields the fork owns and measure the graph. Nothing inside the graph is
 * inspected beyond its serialized size — FL-90's resource resolver is what walks it, and it runs
 * against a stored revision rather than against an unvalidated request body.
 */
export const checkStudioEnvelope = (candidate: unknown): StudioEnvelopeCheck => {
  if (!isPlainObject(candidate)) {
    return { ok: false, problem: 'not-an-object', detail: 'The envelope must be a JSON object' };
  }

  if (candidate.schemaVersion !== STUDIO_ENVELOPE_SCHEMA_VERSION) {
    return {
      ok: false,
      problem: 'schema-version',
      detail: `Unsupported envelope schemaVersion: ${String(candidate.schemaVersion)}`,
    };
  }

  if (candidate.engine !== STUDIO_ENGINE) {
    return { ok: false, problem: 'engine', detail: `Unsupported engine: ${String(candidate.engine)}` };
  }

  const engineRevision = candidate.engineRevision;
  if (typeof engineRevision !== 'string' || engineRevision.length === 0 || engineRevision.length > 200) {
    return { ok: false, problem: 'engine-revision', detail: 'engineRevision must be a non-empty string' };
  }

  if (!('graph' in candidate) || candidate.graph === undefined) {
    return { ok: false, problem: 'graph-missing', detail: 'The envelope must carry a graph' };
  }

  let graphBytes: number;
  try {
    graphBytes = measureStudioGraph(candidate.graph);
  } catch {
    // A graph with a cycle or a BigInt in it cannot be stored, and pretending otherwise would
    // lose work at the next reload rather than at the save the person can still react to.
    return { ok: false, problem: 'not-serializable', detail: 'The graph is not JSON-serializable' };
  }

  if (graphBytes > STUDIO_MAX_GRAPH_BYTES) {
    return {
      ok: false,
      problem: 'graph-too-large',
      detail: `Graph is ${graphBytes} bytes; the limit is ${STUDIO_MAX_GRAPH_BYTES}`,
    };
  }

  return {
    ok: true,
    // Rebuilt from the four known fields plus the untouched graph: an extra top-level key a
    // client invented is dropped here rather than stored, while everything inside the graph is
    // preserved exactly.
    envelope: {
      schemaVersion: STUDIO_ENVELOPE_SCHEMA_VERSION,
      engine: STUDIO_ENGINE,
      engineRevision,
      graph: candidate.graph,
    },
    graphBytes,
  };
};

/* ------------------------------------------------------------------ */
/* The digest                                                           */
/* ------------------------------------------------------------------ */

/**
 * Serialize with object keys sorted, recursively.
 *
 * Two clients that built the same graph in a different order must produce the same digest, or an
 * idempotent retry from a reconnected tab would look like a different save. Arrays keep their
 * order, because an array's order is data.
 */
export const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }

  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`);

  return `{${entries.join(',')}}`;
};

export const studioEnvelopeDigest = (envelope: StudioProjectEnvelope): string =>
  createHash('sha256').update(canonicalJson(envelope)).digest('hex');

/* ------------------------------------------------------------------ */
/* The lease                                                            */
/* ------------------------------------------------------------------ */

/**
 * One writer, ninety seconds.
 *
 * Short enough that a browser that crashed does not hold a project hostage for long, and long
 * enough that a renewal every thirty seconds tolerates two lost round trips before the lease
 * lapses. The client renews at `STUDIO_LEASE_RENEW_MS`; both numbers are here so they stay a
 * factor of three apart.
 */
export const STUDIO_LEASE_MS = 90_000;
export const STUDIO_LEASE_RENEW_MS = 30_000;

/** Autosave debounce. A pause in typing, not a timer that fights the person's edits. */
export const STUDIO_AUTOSAVE_DEBOUNCE_MS = 1500;

export type StudioLeaseView = {
  holderId: string | null;
  holderSessionId: string | null;
  expiresAt: Date | null;
};

/** A lease is held only while it has an unexpired expiry and a holder. */
export const isStudioLeaseHeld = (lease: StudioLeaseView, now: Date = new Date()): boolean =>
  !!lease.holderId && !!lease.expiresAt && lease.expiresAt.getTime() > now.getTime();

/**
 * Whether this session may write without taking anything away from anybody.
 *
 * A lapsed lease is free for the taking; a live lease held by another session is not, and needs
 * an explicit takeover the person asked for.
 */
export const canAcquireStudioLease = (
  lease: StudioLeaseView,
  sessionId: string,
  now: Date = new Date(),
): boolean => !isStudioLeaseHeld(lease, now) || lease.holderSessionId === sessionId;

/* ------------------------------------------------------------------ */
/* Rational time on a review comment                                    */
/* ------------------------------------------------------------------ */

/**
 * A comment's instant on the sequence timeline, in seconds, exactly (FL-93).
 *
 * A comment that says "hold the lake shot until 21.5" has to point at the same frame the editor
 * and the encoder agree on. Stored as a fraction so an NTSC boundary is the boundary, not a float
 * that rounds three different ways on the way to three different consumers.
 */
export type StudioRationalTime = { num: number; den: number };

const MAX_SAFE_TICKS = Number.MAX_SAFE_INTEGER;

const gcd = (a: number, b: number): number => {
  let x = Math.abs(a);
  let y = Math.abs(b);
  while (y !== 0) {
    [x, y] = [y, x % y];
  }
  return x || 1;
};

/**
 * Reduce to lowest terms with a positive denominator, or return null when the value cannot be an
 * exact instant. Negative times are refused: there is no timeline before zero.
 */
export const normalizeStudioTime = (value: unknown): StudioRationalTime | null => {
  if (!isPlainObject(value)) {
    return null;
  }

  const { num, den } = value as { num: unknown; den: unknown };
  if (
    typeof num !== 'number' ||
    typeof den !== 'number' ||
    !Number.isInteger(num) ||
    !Number.isInteger(den) ||
    den === 0 ||
    Math.abs(num) > MAX_SAFE_TICKS ||
    Math.abs(den) > MAX_SAFE_TICKS
  ) {
    return null;
  }

  const sign = den < 0 ? -1 : 1;
  const signedNum = num * sign;
  if (signedNum < 0) {
    return null;
  }

  const divisor = gcd(signedNum, den * sign);
  return { num: signedNum / divisor, den: (den * sign) / divisor };
};

export const formatStudioTime = (time: StudioRationalTime): string => `${time.num}/${time.den}`;

/* ------------------------------------------------------------------ */
/* Command batch summaries                                              */
/* ------------------------------------------------------------------ */

/**
 * What a revision says it contains.
 *
 * The server does not replay commands — the engine produced the graph and the graph is the truth.
 * The summary is history: it is what the history list shows instead of "revision 41", and what a
 * person reads when deciding which revision to restore. It is client-supplied and therefore
 * bounded and sanitized rather than trusted.
 */
export type StudioCommandSummary = {
  /** Command id to how many times it appeared in the batch. */
  counts: Record<string, number>;
  /** The batch size the client reported, used only for display. */
  total: number;
};

const MAX_SUMMARY_ROWS = 50;
const MAX_COMMAND_ID_LENGTH = 64;

export const normalizeCommandSummary = (value: unknown): StudioCommandSummary => {
  if (!isPlainObject(value)) {
    return { counts: {}, total: 0 };
  }

  const raw = isPlainObject(value.counts) ? value.counts : {};
  const counts: Record<string, number> = {};
  let total = 0;

  for (const [id, count] of Object.entries(raw).slice(0, MAX_SUMMARY_ROWS)) {
    if (typeof id !== 'string' || id.length === 0 || id.length > MAX_COMMAND_ID_LENGTH) {
      continue;
    }
    if (typeof count !== 'number' || !Number.isInteger(count) || count <= 0 || count > 100_000) {
      continue;
    }
    counts[id] = count;
    total += count;
  }

  return { counts, total };
};
