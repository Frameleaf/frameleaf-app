import type { AssetLedgerItemDto } from '@frameleaf/sdk';
import { addedKey, inLibrary, ledgerMonth, ledgerRow, ledgerWhen } from '$lib/frameleaf/nothing-lost';
import en from '../../../../i18n/en.json';

/** Nothing lost in plain words (FL-940): every state and reason the server writes has its own sentence. */
const item = (overrides: Partial<AssetLedgerItemDto>): AssetLedgerItemDto => ({
  assetId: 'a1',
  checksum: 'c',
  originalFileName: 'IMG_4410.HEIC',
  addedAt: '2026-11-02T18:20:00.000Z',
  addedVia: 'upload',
  state: 'removed' as AssetLedgerItemDto['state'],
  stateAt: '2026-11-13T20:42:00.000Z',
  stateBy: null,
  reason: null,
  ...overrides,
});
const viewer = { me: 'taylor', names: new Map([['morgan', 'Morgan']]) };
const key = (overrides: Partial<AssetLedgerItemDto>) => ledgerRow(item(overrides), viewer).key;

describe('nothing-lost', () => {
  it('says who did it: the reader, a named person, someone it can’t name, or Frameleaf', () => {
    expect(key({ reason: 'deleted', stateBy: 'taylor' })).toBe('frameleaf_ledger_deleted_you');
    expect(ledgerRow(item({ reason: 'deleted', stateBy: 'morgan' }), viewer)).toMatchObject({
      key: 'frameleaf_ledger_deleted_by',
      name: 'Morgan',
    });
    expect(ledgerRow(item({ reason: 'deleted', stateBy: 'gone' }), viewer)).toMatchObject({
      key: 'frameleaf_ledger_deleted_by',
      name: '',
    });
    expect(key({ reason: 'deleted' })).toBe('frameleaf_ledger_deleted');
  });

  it('has a sentence in the catalogue for every state and reason, and a plain one for a reason it never heard of', () => {
    const keys = [
      key({ reason: 'trash-expired' }),
      key({ reason: 'account-removed', stateBy: 'taylor' }),
      key({ reason: 'library-removed' }),
      key({ reason: 'removed', stateBy: 'morgan' }),
      key({ reason: 'something-new' }),
      key({ state: 'trashed' as never, stateBy: 'taylor' }),
      key({ state: 'trashed' as never }),
      key({ state: 'merged' as never, reason: 'identical-file' }),
      key({ state: 'missing' as never, reason: 'not-found' }),
      key({ state: 'kept' as never, reason: 'found' }),
      key({ state: 'kept' as never }),
    ];
    expect(keys).toEqual([
      'frameleaf_ledger_trash_expired',
      'frameleaf_ledger_account_removed_you',
      'frameleaf_ledger_library_removed',
      'frameleaf_ledger_library_removed_by',
      'frameleaf_ledger_removed',
      'frameleaf_ledger_trashed_you',
      'frameleaf_ledger_trashed',
      'frameleaf_ledger_merged',
      'frameleaf_ledger_missing',
      'frameleaf_ledger_found',
      'frameleaf_ledger_state_kept',
    ]);
    for (const name of keys) {
      expect(en).toHaveProperty(name);
    }
    expect(ledgerRow(item({ state: 'missing' as never }), viewer).warn).toBe(true);
  });

  it('says how it arrived, "Added" for a way it never heard of', () => {
    expect(addedKey('library-scan')).toBe('frameleaf_ledger_via_library_scan');
    expect(addedKey('partner-copy')).toBe('frameleaf_ledger_via_partner_copy');
    expect(addedKey('teleport')).toBe('frameleaf_ledger_via_unknown');
    for (const via of ['upload', 'library-scan', 'import', 'partner-copy', 'studio', 'recovered', 'unknown']) {
      expect(en).toHaveProperty(addedKey(via));
    }
  });

  it('counts a photo that is stored once as in the library, and writes dates plainly', () => {
    expect(inLibrary({ kept: 10, merged: 2, trashed: 1, removed: 1, missing: 0 })).toBe(12);
    expect(ledgerMonth('2026-11', 'en')).toBe('November 2026');
    const now = new Date(2026, 10, 15);
    expect(ledgerWhen('2026-11-13T20:42:00', 'en', { now })).toMatch(/^Nov 13, 8:42\sPM$/);
    expect(ledgerWhen('2026-11-13T20:42:00', 'en', { now, time: false })).toBe('Nov 13');
    expect(ledgerWhen('2024-03-03T12:00:00', 'en', { now })).toBe('Mar 3, 2024');
  });
});
