import { type Transaction } from 'kysely';
import type { DB } from 'src/schema/index.js';
import { AssetVisibility } from 'src/enum.js';
import { type DuplicateKeeperState } from 'src/repositories/duplicate-decision.repository.js';
import { restoreDuplicateUndoMetadata } from 'src/repositories/duplicate-undo-completion.js';
import { scriptedKysely } from 'test/scripted-kysely.js';

const state: DuplicateKeeperState = {
  isFavorite: false,
  visibility: AssetVisibility.Timeline,
  rating: null,
  description: '',
  latitude: 51,
  longitude: -115,
  albumIds: [],
  tagIds: [],
};

describe('recorded duplicate metadata location undo', () => {
  it.each([
    { before: { latitude: null, longitude: null }, newer: false, restores: true },
    { before: { latitude: 0, longitude: 0 }, newer: false, restores: true },
    { before: { latitude: null, longitude: null }, newer: true, restores: false },
    { before: { latitude: null, longitude: 0 }, newer: false, restores: false },
  ])('restores $before without replacing a newer edit=$newer', async ({ before, newer, restores }) => {
    const current = newer ? { ...state, latitude: 52, longitude: -114 } : state;
    const { db, queries } = scriptedKysely(({ sql }) => {
      if (sql.includes('from "duplicate_decision"'))
        return {
          rows: [
            {
              keepAssetIds: ['keeper'],
              state: { before: { keeper: { ...state, ...before } }, after: { keeper: state } },
            },
          ],
        };
      if (sql.includes('from "asset"')) return { rows: [{ id: 'keeper', ...current }] };
      return {};
    });
    try {
      const effects = await restoreDuplicateUndoMetadata(db as unknown as Transaction<DB>, 'owner', {
        operationId: 'operation',
        claimToken: 'token',
        decisionId: 'decision',
        duplicateId: 'group',
        memberIds: ['keeper', 'copy'],
      });
      const updates = queries.filter(({ sql }) => sql.startsWith('update "asset_exif"'));
      if (restores) {
        expect(updates[0].parameters.slice(0, 2)).toEqual([before.latitude, before.longitude]);
        expect(effects.edits).toEqual([{ assetId: 'keeper', fields: ['location'] }]);
        if (before.latitude === null) {
          const clearing = updates.find(({ sql }) => sql.includes('"city" ='));
          expect(clearing?.parameters.slice(0, 5)).toEqual([null, null, null, null, null]);
        }
      } else {
        expect(updates).toEqual([]);
        expect(effects.edits).toEqual([]);
      }
    } finally {
      await db.destroy();
    }
  });
});
