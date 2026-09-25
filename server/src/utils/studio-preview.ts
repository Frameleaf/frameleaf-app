/**
 * Revision-bound remote preview rules (FL-96, `STU-402`).
 *
 * A preview frame is only ever meaningful with respect to *one exact project revision*. The
 * whole point of this module is that the binding is a value, not a convention: the cache key,
 * the ETag and the staleness decision are all derived from the same five inputs, so a frame
 * rendered for revision A can never be handed back to somebody asking about revision B, and a
 * browser holding a cached frame cannot revalidate its way into being served one either.
 *
 * Framework-free on purpose, like `media-policy.ts`: the service, the repository and the tests
 * all import the same rules rather than restating them, and none of it needs a database.
 *
 * ## Typed seams
 *
 * - **Rational time (FL-93 / `VID-102`).** {@link PreviewTime} is FL-93's `Rational`, imported
 *   from `src/utils/rational-time.ts`. A floating `seconds` is never accepted anywhere: a
 *   preview at 1001/30000 must address the same frame the export does.
 * - **Worker admission (FL-95 / `STU-401`).** Nothing here admits, claims or talks to a worker.
 *   A preview request becomes a durable media operation row and stops; FL-95 owns claiming it.
 * - **Authorized manifest (FL-90 / `STU-203`).** The enumerated, revision-bound read grant is
 *   `StudioResourceService`'s. This module never resolves a resource and never sees a graph; it
 *   only compares the manifest digest a frame was bound to against the current one.
 */

import { createHash } from 'node:crypto';
import { type Rational, formatRational } from 'src/utils/rational-time.js';

/* ------------------------------------------------------------------ */
/* Rational time (FL-93)                                                */
/* ------------------------------------------------------------------ */

/**
 * An exact point on the sequence timeline, in seconds. FL-93's reduced rational.
 *
 * Reduction is what makes the cache key honest: `2002/60000` and `1001/30000` are the same
 * instant, so `rational()` gives them the same pair and therefore the same key, instead of the
 * store quietly rendering one frame twice under two names.
 */
export type PreviewTime = Rational;

/** Canonical text form, e.g. `1001/30000`. Used in the store key and in the ETag. */
export const previewTimeKey = (time: PreviewTime): string => formatRational(time);

/* ------------------------------------------------------------------ */
/* The binding                                                          */
/* ------------------------------------------------------------------ */

/**
 * Everything that identifies one preview frame.
 *
 * The viewport is part of the identity, not a rendering hint: a 480-wide frame is not a
 * 1920-wide frame scaled down, and serving one for the other would make scopes and pixel
 * inspection lie. The store is described as keyed by project, revision, time and quality; the
 * viewport is the next component of that same key, and the owner scopes all of it.
 */
export type PreviewBinding = {
  /**
   * The account the frame is rendered for. Part of the identity so two accounts can never share
   * a row: two accounts can resolve the same project and revision, and a key without the owner
   * would let one account address another's frame.
   */
  ownerId: string;
  projectId: string;
  /**
   * The binding digest: FL-90's authorized manifest digest for the stored revision. Opaque to
   * this module; never parsed, never ordered.
   */
  revisionDigest: string;
  time: PreviewTime;
  quality: string;
  viewportWidth: number;
  viewportHeight: number;
};

/**
 * The store key. A digest rather than a concatenation so an arbitrarily long project id or
 * revision digest still fits an indexed column, and so the separator can never be forged by a
 * value containing it.
 */
export const previewCacheKey = (binding: PreviewBinding): string =>
  createHash('sha256')
    .update(
      [
        'fl96',
        binding.ownerId,
        binding.projectId,
        binding.revisionDigest,
        previewTimeKey(binding.time),
        binding.quality,
        String(binding.viewportWidth),
        String(binding.viewportHeight),
      ].join('\u{0}'),
    )
    .digest('hex');

/**
 * The entity tag for a delivered frame.
 *
 * It contains the revision digest verbatim, which is the behaviour this story is named for:
 * a conditional request carrying an ETag from an earlier revision cannot match the current
 * one, so the cached frame is never revalidated into being served. It is a strong validator —
 * these bytes are the frame or they are not.
 */
export const previewETag = (binding: PreviewBinding): string =>
  `"rev-${binding.revisionDigest}-${previewCacheKey(binding).slice(0, 32)}"`;

/** Whether a request's `If-None-Match` names exactly this frame. `*` matches any existing one. */
export const previewETagMatches = (header: string | undefined, etag: string): boolean => {
  if (!header) {
    return false;
  }

  return header
    .split(',')
    .map((candidate) => candidate.trim())
    .some((candidate) => ['*', etag, `W/${etag}`].includes(candidate));
};

/* ------------------------------------------------------------------ */
/* Delivery decision                                                    */
/* ------------------------------------------------------------------ */

/** The store states a preview row can be in. Mirrors `StudioPreviewStatus` in `enum.ts`. */
export type PreviewStatusValue = 'pending' | 'rendering' | 'ready' | 'superseded' | 'failed' | 'evicted';

export type PreviewDeliveryInput = {
  status: PreviewStatusValue;
  /** The revision this stored frame was rendered for. */
  revisionDigest: string;
  /**
   * The binding the project is on now, as the revision authority reports it. Null when the
   * stored project revision itself has moved past the frame's, which nothing can match.
   */
  currentRevisionDigest: string | null;
  /** Null until a worker has published a validated frame. */
  framePath: string | null;
  /** Retention boundary; null means no expiry was set. */
  expiresAt: Date | null;
  now: Date;
  /** The caller's `If-None-Match`, if any. */
  ifNoneMatch?: string;
  etag: string;
};

export type PreviewDeliveryDecision =
  | { deliver: true }
  | { deliver: false; outcome: 'not-modified' }
  | {
      deliver: false;
      outcome: 'stale-revision' | 'expired' | 'evicted' | 'not-ready' | 'failed';
      code: string;
    };

/**
 * Whether a stored frame may be handed to the caller.
 *
 * Order matters and is the point of the function:
 *
 * 1. **Revision first.** A frame for a superseded revision is refused before anything else,
 *    including before the conditional-request check, so no combination of caching headers can
 *    produce a `304` that leaves a stale picture on screen. The project having advanced is
 *    never a reason to serve the old frame "for now".
 * 2. **Retention.** An expired or evicted entry is gone; it is reported as gone rather than
 *    resurrected from a path that may no longer exist.
 * 3. **Readiness.** A row with no published frame is `not-ready`, which is an honest answer the
 *    client turns into "rendering", not a 404 that looks like a mistake.
 * 4. **Conditional request.** Only once the frame is genuinely deliverable does an `ETag` match
 *    turn into `304`.
 */
export const decidePreviewDelivery = (input: PreviewDeliveryInput): PreviewDeliveryDecision => {
  if (input.status === 'superseded' || input.revisionDigest !== input.currentRevisionDigest) {
    return { deliver: false, outcome: 'stale-revision', code: 'studio_preview_stale_revision' };
  }

  if (input.status === 'evicted') {
    return { deliver: false, outcome: 'evicted', code: 'studio_preview_evicted' };
  }

  if (input.expiresAt && input.expiresAt.getTime() <= input.now.getTime()) {
    return { deliver: false, outcome: 'expired', code: 'studio_preview_expired' };
  }

  if (input.status === 'failed') {
    return { deliver: false, outcome: 'failed', code: 'studio_preview_failed' };
  }

  if (input.status !== 'ready' || !input.framePath) {
    return { deliver: false, outcome: 'not-ready', code: 'studio_preview_not_ready' };
  }

  if (previewETagMatches(input.ifNoneMatch, input.etag)) {
    return { deliver: false, outcome: 'not-modified' };
  }

  return { deliver: true };
};

/* ------------------------------------------------------------------ */
/* Retention and eviction                                              */
/* ------------------------------------------------------------------ */

/** How long a ready preview frame is worth keeping. Scrubbing reuses frames within seconds. */
export const PREVIEW_RETENTION_MS = 10 * 60 * 1000;

/** Frames kept per project revision before the least recently used ones are evicted. */
export const PREVIEW_FRAMES_PER_REVISION = 120;

/** Revisions kept per project. Older revisions are unreachable the moment one supersedes them. */
export const PREVIEW_REVISIONS_PER_PROJECT = 2;

export const previewExpiry = (now: Date, retentionMs: number = PREVIEW_RETENTION_MS): Date =>
  new Date(now.getTime() + retentionMs);

/** How often the retention sweep removes the files of expired, superseded and failed frames. */
export const PREVIEW_SWEEP_MS = 60 * 1000;

/** How long an evicted row stays as a tombstone, so a client holding its id hears "gone". */
export const PREVIEW_TOMBSTONE_MS = 24 * 60 * 60 * 1000;

/** What a worker may publish as a preview frame. */
export const PREVIEW_CONTENT_TYPES: readonly string[] = ['image/png', 'image/jpeg', 'image/webp'];

export type EvictionCandidate = {
  id: string;
  revisionDigest: string;
  status: PreviewStatusValue;
  lastAccessedAt: Date;
  expiresAt: Date | null;
};

export type EvictionPlan = {
  /** Rows whose retention has run out or whose revision is gone. Their files go with them. */
  evict: string[];
  /** Rows still being rendered for a superseded revision. Their operations must be cancelled. */
  cancel: string[];
};

const isInFlight = (status: PreviewStatusValue) => status === 'pending' || status === 'rendering';

/**
 * Decide what to drop for one project.
 *
 * Two independent reasons, applied in this order:
 *
 * 1. **The revision moved on.** Every entry for a revision that is neither current nor one of
 *    the recent ones kept for a fast undo is dead weight — nobody can ask for it again, because
 *    asking requires naming its revision, and {@link decidePreviewDelivery} would refuse. An
 *    entry still rendering when its revision is superseded is reported under `cancel` rather
 *    than `evict`: there is a worker on it, and the job must be told to stop rather than have
 *    its row deleted out from under it.
 * 2. **Ordinary retention.** Expired entries, then the least recently used beyond the per-
 *    revision cap. Recency, not creation order: a person scrubbing back and forth over one
 *    second of the timeline should keep those frames and lose the ones they passed through
 *    once.
 *
 * An in-flight entry on the *current* revision is never evicted for the cap: cancelling work
 * the person is waiting for to make room for work they are also waiting for helps nobody.
 */
export const planPreviewEviction = (
  candidates: readonly EvictionCandidate[],
  options: {
    currentRevisionDigest: string;
    now: Date;
    recentRevisionDigests?: readonly string[];
    framesPerRevision?: number;
  },
): EvictionPlan => {
  const keepRevisions = new Set<string>([options.currentRevisionDigest, ...(options.recentRevisionDigests ?? [])]);
  const framesPerRevision = options.framesPerRevision ?? PREVIEW_FRAMES_PER_REVISION;

  const evict = new Set<string>();
  const cancel = new Set<string>();
  const survivors: EvictionCandidate[] = [];

  for (const candidate of candidates) {
    if (!keepRevisions.has(candidate.revisionDigest)) {
      if (isInFlight(candidate.status)) {
        cancel.add(candidate.id);
      } else {
        evict.add(candidate.id);
      }
      continue;
    }

    if (
      candidate.expiresAt &&
      candidate.expiresAt.getTime() <= options.now.getTime() &&
      !isInFlight(candidate.status)
    ) {
      evict.add(candidate.id);
      continue;
    }

    survivors.push(candidate);
  }

  const byRevision = new Map<string, EvictionCandidate[]>();
  for (const survivor of survivors) {
    const bucket = byRevision.get(survivor.revisionDigest);
    if (bucket) {
      bucket.push(survivor);
    } else {
      byRevision.set(survivor.revisionDigest, [survivor]);
    }
  }

  for (const bucket of byRevision.values()) {
    const evictable = bucket
      .filter((candidate) => !isInFlight(candidate.status))
      .sort((a, b) => b.lastAccessedAt.getTime() - a.lastAccessedAt.getTime());

    // The cap counts the whole bucket, including in-flight rows, but only settled rows can be
    // given up to meet it.
    const excess = bucket.length - framesPerRevision;
    for (let index = 0; index < excess && index < evictable.length; index++) {
      evict.add(evictable[evictable.length - 1 - index].id);
    }
  }

  return { evict: [...evict], cancel: [...cancel] };
};

/* ------------------------------------------------------------------ */
/* Supersession                                                         */
/* ------------------------------------------------------------------ */

/**
 * Whether a request may proceed against the revision the authority reports.
 *
 * A request naming a revision that is not the current one is refused outright rather than
 * rendered: the answer would be obsolete before it arrived, and rendering it would spend a GPU
 * the person needs for the frame they are actually looking at.
 */
export const isPreviewRequestCurrent = (requestedRevisionDigest: string, currentRevisionDigest: string): boolean =>
  requestedRevisionDigest === currentRevisionDigest;

/**
 * Bound the viewport a client may ask for.
 *
 * Not a quality decision — a defence. The viewport comes from the browser, it is part of the
 * cache key, and an unbounded value would let one request allocate an arbitrary GPU surface and
 * mint unlimited distinct cache entries.
 */
export const PREVIEW_MIN_VIEWPORT = 16;
export const PREVIEW_MAX_VIEWPORT = 7680;

export const isValidPreviewViewport = (width: number, height: number): boolean =>
  Number.isSafeInteger(width) &&
  Number.isSafeInteger(height) &&
  width >= PREVIEW_MIN_VIEWPORT &&
  height >= PREVIEW_MIN_VIEWPORT &&
  width <= PREVIEW_MAX_VIEWPORT &&
  height <= PREVIEW_MAX_VIEWPORT;
