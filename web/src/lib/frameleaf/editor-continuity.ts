/**
 * Quick editor ↔ Studio continuity (FL-113, `VID-105`).
 *
 * In the prototype the quick editor and Studio share one piece of state: the asset's edit draft,
 * its undo history and the playhead (`App.jsx` keeps `edit`, `undo`/`redo` and
 * `session.playbackPosition`; `openStudio` only switches screens, and choosing the clip in Studio
 * opens the editor on the same draft). Production has two routes, so the shared state is carried
 * here: the editor writes what the person had when they chose "Open in Studio", Studio reports the
 * playhead back, and the editor picks both up when it opens the same asset again.
 *
 * Rules:
 *
 * - **Recoverable, never silently applied to something else.** A record is bound to the state the
 *   draft was built on (`base`, a fingerprint of the saved edit or develop revision the editor
 *   opened with). When the asset's saved state moved on in between, the old draft is not replayed
 *   over the new one: it is dropped and the editor says so.
 * - **Per tab, short-lived.** Kept in `sessionStorage` (a tab's own storage, not the account's), and
 *   ignored after `STUDIO_CONTINUITY_TTL_MS`. Nothing here is a save: until the person saves a
 *   version, the draft exists only in this tab.
 * - **Cleared** when the editor saves, discards (Cancel), or picks the record up.
 */
import type { Rational } from '$lib/frameleaf/studio/rational-time';

export const EDITOR_CONTINUITY_VERSION = 1;
/** A draft left in this tab for longer than this is not offered back. */
export const STUDIO_CONTINUITY_TTL_MS = 12 * 60 * 60 * 1000;

const keyFor = (assetId: string) => `frameleaf.editor.continuity.${assetId}`;

export type EditorContinuityKind = 'photo' | 'video';

export interface EditorContinuity<Draft = unknown> {
  version: typeof EDITOR_CONTINUITY_VERSION;
  assetId: string;
  kind: EditorContinuityKind;
  /** The editor's draft, with its undo and redo history. */
  draft: Draft;
  /** Fingerprint of the saved state the draft was built on. */
  base: string;
  /** The quick editor tool that was open. */
  tool: string;
  /** Where the person was, as exact seconds on the source (FL-93). Stills keep 0. */
  playhead: Rational;
  /** Set by Studio when the person comes back: where its playhead was. */
  studioPlayhead?: Rational | null;
  savedAt: number;
}

export interface ContinuityStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const memory = new Map<string, string>();
const memoryStorage: ContinuityStorage = {
  getItem: (key) => memory.get(key) ?? null,
  setItem: (key, value) => void memory.set(key, value),
  removeItem: (key) => void memory.delete(key),
};

/** The tab's session storage, or memory when a private window refuses it. */
export const defaultContinuityStorage = (): ContinuityStorage => {
  try {
    const storage = sessionStorage;
    const probe = '__frameleaf_probe__';
    storage.setItem(probe, '1');
    storage.removeItem(probe);
    return storage;
  } catch {
    return memoryStorage;
  }
};

const isRational = (value: unknown): value is Rational =>
  !!value &&
  typeof value === 'object' &&
  Number.isSafeInteger((value as Rational).num) &&
  Number.isSafeInteger((value as Rational).den) &&
  (value as Rational).den > 0 &&
  (value as Rational).num >= 0;

/** Seconds as an exact millisecond rational, reduced. */
export const secondsToRational = (seconds: number): Rational => {
  const milliseconds = Math.max(0, Math.round((Number.isFinite(seconds) ? seconds : 0) * 1000));
  const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
  const divisor = gcd(milliseconds, 1000) || 1;
  return { num: milliseconds / divisor, den: 1000 / divisor };
};

export const rationalToSeconds = (value: Rational | null | undefined): number =>
  value && isRational(value) ? value.num / value.den : 0;

/** A stable fingerprint of a saved state, so a draft is only offered back over the state it was built on. */
export const continuityBase = (value: unknown): string => JSON.stringify(value ?? null);

export const saveEditorContinuity = <Draft>(
  record: Omit<EditorContinuity<Draft>, 'version' | 'savedAt'>,
  storage: ContinuityStorage = defaultContinuityStorage(),
  now: number = Date.now(),
): void => {
  try {
    storage.setItem(
      keyFor(record.assetId),
      JSON.stringify({ ...record, version: EDITOR_CONTINUITY_VERSION, savedAt: now } satisfies EditorContinuity<Draft>),
    );
  } catch {
    // A full or refused store only loses the carry-over, never the saved versions.
  }
};

export const readEditorContinuity = <Draft>(
  assetId: string,
  storage: ContinuityStorage = defaultContinuityStorage(),
  now: number = Date.now(),
): EditorContinuity<Draft> | null => {
  let parsed: unknown;
  try {
    const raw = storage.getItem(keyFor(assetId));
    if (!raw) {
      return null;
    }
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const record = parsed as Partial<EditorContinuity<Draft>> | null;
  if (
    !record ||
    record.version !== EDITOR_CONTINUITY_VERSION ||
    record.assetId !== assetId ||
    (record.kind !== 'photo' && record.kind !== 'video') ||
    typeof record.base !== 'string' ||
    typeof record.tool !== 'string' ||
    !isRational(record.playhead) ||
    typeof record.savedAt !== 'number' ||
    now - record.savedAt > STUDIO_CONTINUITY_TTL_MS ||
    record.draft === undefined
  ) {
    clearEditorContinuity(assetId, storage);
    return null;
  }
  return record as EditorContinuity<Draft>;
};

export const clearEditorContinuity = (
  assetId: string,
  storage: ContinuityStorage = defaultContinuityStorage(),
): void => {
  try {
    storage.removeItem(keyFor(assetId));
  } catch {
    // Nothing to clear.
  }
};

/** Studio reports where its playhead was when the person goes back to the quick editor. */
export const reportStudioPlayhead = (
  assetId: string,
  playhead: Rational | null,
  storage: ContinuityStorage = defaultContinuityStorage(),
  now: number = Date.now(),
): void => {
  const record = readEditorContinuity(assetId, storage, now);
  if (record) {
    saveEditorContinuity(
      { ...record, studioPlayhead: playhead && isRational(playhead) ? playhead : null },
      storage,
      record.savedAt,
    );
  }
};

export type ContinuityResume<Draft> =
  | { status: 'none' }
  /** The draft the person left, built on the state the editor has now. */
  | { status: 'resumed'; draft: Draft; tool: string; playhead: number }
  /** A draft existed, but the asset's saved state changed in between; it was not applied. */
  | { status: 'stale' };

/**
 * What the editor should open with. The record is consumed either way: a draft offered back once
 * belongs to the editor from then on, and a stale one is gone.
 */
export const resumeEditorContinuity = <Draft>(
  assetId: string,
  base: string,
  storage: ContinuityStorage = defaultContinuityStorage(),
  now: number = Date.now(),
): ContinuityResume<Draft> => {
  const record = readEditorContinuity<Draft>(assetId, storage, now);
  if (!record) {
    return { status: 'none' };
  }
  clearEditorContinuity(assetId, storage);
  if (record.base !== base) {
    return { status: 'stale' };
  }
  // Studio's playhead wins when the person comes back from it: that is where they were last.
  const playhead = rationalToSeconds(record.studioPlayhead ?? record.playhead);
  return { status: 'resumed', draft: record.draft, tool: record.tool, playhead };
};
