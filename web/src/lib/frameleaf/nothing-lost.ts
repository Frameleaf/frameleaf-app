/**
 * Nothing lost in plain words (FL-940, after the approved prototype's `nothing-lost.mjs`). The server
 * keeps the record (FL-921); this turns its totals and rows into the message keys, icons and tones the
 * page shows. No page code here, so it can be tested on its own.
 */
import type { AssetLedgerCountsDto, AssetLedgerItemDto } from '@frameleaf/sdk';
import {
  mdiAccountRemoveOutline,
  mdiContentCopy,
  mdiDeleteOutline,
  mdiFileCheckOutline,
  mdiFileQuestionOutline,
  mdiFolderRemoveOutline,
  mdiImageMultipleOutline,
  mdiImageOutline,
  mdiTimerSandComplete,
  mdiTrashCanOutline,
} from '@mdi/js';
import { DateTime } from 'luxon';

export type LedgerState = keyof AssetLedgerCountsDto;

/** Where an original can be, in the order the page shows them. */
export const LEDGER_STATES: LedgerState[] = ['kept', 'merged', 'trashed', 'removed', 'missing'];

/** The states the list can be narrowed to (the server's `state` filter). */
export const LEDGER_CHIPS = ['removed', 'trashed', 'merged'] as const;
export type LedgerChip = (typeof LEDGER_CHIPS)[number];

export const LEDGER_STATE_ICONS: Record<LedgerState, string> = {
  kept: mdiImageMultipleOutline,
  merged: mdiContentCopy,
  trashed: mdiTrashCanOutline,
  removed: mdiDeleteOutline,
  missing: mdiFileQuestionOutline,
};

/** In the library, which is where a photo that is stored once still is. */
export const inLibrary = (states: AssetLedgerCountsDto) => states.kept + states.merged;

const ADDED_VIA = new Set(['upload', 'library-scan', 'import', 'partner-copy', 'studio', 'recovered']);
/** How it arrived, as a message that takes `{date}`. A way this page has never heard of says "Added". */
export const addedKey = (addedVia: string) =>
  `frameleaf_ledger_via_${ADDED_VIA.has(addedVia) ? addedVia.replace('-', '_') : 'unknown'}`;

export type LedgerViewer = { me: string; names: Map<string, string> };
export type LedgerRow = { icon: string; key: string; name?: string; warn: boolean };

/**
 * One row of the list: what happened and who did it. `key` is the sentence; with `name` it is the
 * `_by` form, said of that person, and `_you` is said of the reader. The plain key is for a change
 * Frameleaf made itself (`stateBy` is null). An account the reader can't see has an empty `name`, and
 * the page says "Someone".
 */
export function ledgerRow(item: AssetLedgerItemDto, { me, names }: LedgerViewer): LedgerRow {
  const row = (icon: string, base: string, warn = false): LedgerRow => {
    if (!item.stateBy) {
      return { icon, key: base, warn };
    }
    return item.stateBy === me
      ? { icon, key: `${base}_you`, warn }
      : { icon, key: `${base}_by`, name: names.get(item.stateBy) ?? '', warn };
  };
  const plain = (icon: string, key: string, warn = false): LedgerRow => ({ icon, key, warn });
  switch (item.state) {
    case 'removed': {
      switch (item.reason) {
        case 'deleted': {
          return row(mdiDeleteOutline, 'frameleaf_ledger_deleted');
        }
        case 'trash-expired': {
          return plain(mdiTimerSandComplete, 'frameleaf_ledger_trash_expired');
        }
        case 'account-removed': {
          return row(mdiAccountRemoveOutline, 'frameleaf_ledger_account_removed');
        }
        case 'library-removed':
        case 'removed': {
          return row(mdiFolderRemoveOutline, 'frameleaf_ledger_library_removed');
        }
        default: {
          return row(mdiDeleteOutline, 'frameleaf_ledger_removed');
        }
      }
    }
    case 'trashed': {
      return row(mdiTrashCanOutline, 'frameleaf_ledger_trashed');
    }
    case 'merged': {
      return plain(mdiContentCopy, 'frameleaf_ledger_merged');
    }
    case 'missing': {
      return plain(mdiFileQuestionOutline, 'frameleaf_ledger_missing', true);
    }
    default: {
      return item.reason === 'found'
        ? plain(mdiFileCheckOutline, 'frameleaf_ledger_found')
        : plain(mdiImageOutline, 'frameleaf_ledger_state_kept');
    }
  }
}

/** "13 Nov, 8:42 PM"; the year instead of the time for another year, or the day alone without `time`. */
export function ledgerWhen(iso: string, locale: string | undefined, { time = true, now = new Date() } = {}) {
  const date = DateTime.fromISO(iso).setLocale(locale ?? 'en');
  if (date.year !== now.getFullYear()) {
    return date.toLocaleString({ day: 'numeric', month: 'short', year: 'numeric' });
  }
  return date.toLocaleString(
    time ? { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' } : { day: 'numeric', month: 'short' },
  );
}

/** "November 2026" from the server's "2026-11". */
export const ledgerMonth = (month: string, locale: string | undefined) =>
  DateTime.fromFormat(month, 'yyyy-MM', { zone: 'utc' })
    .setLocale(locale ?? 'en')
    .toLocaleString({ month: 'long', year: 'numeric' });
