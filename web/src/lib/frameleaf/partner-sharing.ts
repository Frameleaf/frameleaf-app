import {
  mdiAccountMultipleOutline,
  mdiImageAlbum,
  mdiImageMultipleOutline,
  mdiLockOutline,
  mdiMapMarkerOutline,
  mdiTagOutline,
} from '@mdi/js';

/**
 * Partner sharing v2 (prototype `design/frameleaf/template/src/partner-sharing.mjs`): a partner receives
 * their own copies of what you share. Copies follow your edits until the partner changes that detail.
 */

export type PartnerSharedItemId = 'assets' | 'albums' | 'tags' | 'people' | 'details' | 'locked';

/** What a partner receives, in the order the partner card lists it. Labels: `frameleaf_partner_sharing.shared_<id>`. */
export const PARTNER_SHARED_ITEMS: ReadonlyArray<{ id: PartnerSharedItemId; icon: string }> = [
  { id: 'assets', icon: mdiImageMultipleOutline },
  { id: 'albums', icon: mdiImageAlbum },
  { id: 'tags', icon: mdiTagOutline },
  { id: 'people', icon: mdiAccountMultipleOutline },
  { id: 'details', icon: mdiMapMarkerOutline },
  { id: 'locked', icon: mdiLockOutline },
];

export type BackfillState = 'queued' | 'running' | 'done' | 'stopped';
const BACKFILL_STATES: ReadonlySet<string> = new Set(['queued', 'running', 'done', 'stopped']);

export type BackfillInput = { state?: string | null; total?: number | null; done?: number | null } | null | undefined;
export type BackfillProgress = { state: BackfillState; percent: number; total: number; done: number };

const count = (value: number | null | undefined) =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;

/** The first copy into a partner's library, as the partner card shows it. */
export const backfillProgress = (backfill: BackfillInput): BackfillProgress | undefined => {
  if (!backfill) {
    return undefined;
  }
  // the server starts a backfill as `pending`; the card shows it as waiting (`queued`)
  const state = (BACKFILL_STATES.has(backfill.state ?? '') ? backfill.state : 'queued') as BackfillState;
  const total = count(backfill.total);
  let done = count(backfill.done);
  if (state === 'done') {
    done = Math.max(done, total);
    return { state, percent: 100, total: Math.max(done, total), done };
  }
  const percent = total ? Math.min(100, Math.floor((done / total) * 100)) : 0;
  return { state, percent, total, done };
};

/** The original owner's name for "From {name}'s library", or undefined for the viewer's own items. */
export const originOwnerName = (origin: { rootOwnerId?: string; rootOwnerName?: string | null } | null | undefined) =>
  origin?.rootOwnerName?.trim() || undefined;
