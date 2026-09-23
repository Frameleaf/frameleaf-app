/**
 * Studio handoff contract (FL-62).
 *
 * "Make a movie" in the memory player hands its asset list to Studio. Studio itself
 * (Workstream C, wave three) has not landed in this checkout yet: there is no
 * `/studio` route, and `design/frameleaf/template/src/studio-project.mjs` describes a
 * full multitrack project model this story does not implement or attempt to guess at.
 *
 * Rather than invent a fake destination, this module defines the narrow contract a
 * future Studio entry point can rely on: a small, versioned, defensively-parsed
 * staging record written to browser storage, holding only what a "make a movie"
 * action can honestly provide today - which assets, where they came from, and a
 * starting title. It is intentionally not the `frameleaf:studio:v1` project schema
 * key that `studio-project.mjs` reserves; that key is for the real project once
 * Studio exists, and this module must never collide with it.
 *
 * Contract for the future Studio entry point:
 *  - On mount, call `readStudioHandoff()`. A non-null result means a caller (today:
 *    only the memory player) asked to start a new project from this asset list.
 *  - After seeding a new project from it, call `clearStudioHandoff()` so a stale
 *    handoff never re-seeds a later, unrelated visit to Studio.
 *  - The record expires after `HANDOFF_TTL_MS`; an expired or malformed record reads
 *    back as `null` and is treated as if nothing were queued.
 */

export const studioHandoffKey = 'frameleaf:studio-handoff:v1';

/** A handoff older than this is treated as stale and ignored/cleared. */
export const HANDOFF_TTL_MS = 30 * 60 * 1000;

const MAX_ASSET_IDS = 2000;
const MAX_TEXT = 200;

export type StudioHandoffSource = 'memory';

export interface StudioHandoff {
  version: 1;
  /** Where the asset list came from; only "memory" exists today. */
  source: StudioHandoffSource;
  /** The id of the thing the assets were pulled from (a memory id today). */
  sourceId: string;
  /** A starting title for the new project, e.g. the memory's title. */
  title: string;
  /** The ordered asset ids Studio should seed a new project from. */
  assetIds: string[];
  /** Epoch milliseconds when the handoff was written. */
  createdAt: number;
}

const isNonEmptyString = (value: unknown, limit = MAX_TEXT): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= limit;

const cleanAssetIds = (value: unknown): string[] => {
  if (!Array.isArray(value)) {
    return [];
  }
  const seen = new Set<string>();
  const result: string[] = [];
  for (const entry of value) {
    if (isNonEmptyString(entry, 64) && !seen.has(entry)) {
      seen.add(entry);
      result.push(entry);
    }
    if (result.length >= MAX_ASSET_IDS) {
      break;
    }
  }
  return result;
};

/** Defensively parses a raw storage value into a handoff, or null if it is invalid/expired. */
export function parseStudioHandoff(raw: string | null | undefined, now = Date.now()): StudioHandoff | null {
  if (!raw) {
    return null;
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return null;
  }
  const candidate = data as Record<string, unknown>;
  if (candidate.version !== 1 || candidate.source !== 'memory') {
    return null;
  }
  if (!isNonEmptyString(candidate.sourceId, 200) || !isNonEmptyString(candidate.title)) {
    return null;
  }
  const assetIds = cleanAssetIds(candidate.assetIds);
  if (assetIds.length === 0) {
    return null;
  }
  const createdAt = typeof candidate.createdAt === 'number' ? candidate.createdAt : 0;
  if (!Number.isFinite(createdAt) || now - createdAt > HANDOFF_TTL_MS) {
    return null;
  }
  return {
    version: 1,
    source: 'memory',
    sourceId: candidate.sourceId,
    title: candidate.title,
    assetIds,
    createdAt,
  };
}

/**
 * Queues an asset list for Studio to pick up. Storage failures (private mode, quota)
 * are swallowed: the handoff is best-effort, and the caller still shows its own
 * confirmation regardless of whether the browser could persist it.
 */
export function writeStudioHandoff(
  input: { source: StudioHandoffSource; sourceId: string; title: string; assetIds: string[] },
  storage: Storage | undefined = globalThis.localStorage,
): StudioHandoff {
  const handoff: StudioHandoff = {
    version: 1,
    source: input.source,
    sourceId: input.sourceId.slice(0, 200),
    title: input.title.slice(0, MAX_TEXT),
    assetIds: cleanAssetIds(input.assetIds),
    createdAt: Date.now(),
  };
  try {
    storage?.setItem(studioHandoffKey, JSON.stringify(handoff));
  } catch {
    // Storage unavailable; the caller's own confirmation still stands.
  }
  return handoff;
}

/** Reads and validates the queued handoff, if any. Does not clear it. */
export function readStudioHandoff(storage: Storage | undefined = globalThis.localStorage): StudioHandoff | null {
  try {
    return parseStudioHandoff(storage?.getItem(studioHandoffKey) ?? null);
  } catch {
    return null;
  }
}

/** Drops the queued handoff. Studio must call this once it has seeded a project from it. */
export function clearStudioHandoff(storage: Storage | undefined = globalThis.localStorage): void {
  try {
    storage?.removeItem(studioHandoffKey);
  } catch {
    // Storage unavailable; nothing to clear.
  }
}
