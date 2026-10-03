import { describe, expect, it } from 'vitest';
import {
  STORAGE_MIGRATION_SKIPPED_SHOWN,
  advanceStorageMigrationStage,
  createStorageMigrationState,
  needsGettingReady,
  parseStorageMigrationState,
  recordStorageMigrationBatch,
  storageMigrationStatus,
} from 'src/utils/storage-migration.js';

const at = (seconds: number) => new Date(Date.UTC(2026, 9, 3, 12, 0, seconds));

describe('storage migration state', () => {
  it('a library without assets has nothing to combine and never shows Getting Ready', () => {
    const state = createStorageMigrationState({ total: 0, now: at(0) });
    expect(state.stage).toBe('done');
    expect(state.required).toBe(false);
    expect(needsGettingReady(state)).toBe(false);
  });

  it('a library with assets starts at checking and shows Getting Ready until done', () => {
    const state = createStorageMigrationState({ total: 1200, now: at(0) });
    expect(state.stage).toBe('checking');
    expect(state.required).toBe(true);
    expect(needsGettingReady(state)).toBe(true);
    expect(needsGettingReady({ ...state, background: true })).toBe(false);
    expect(needsGettingReady({ ...state, stage: 'done' })).toBe(false);
  });

  it('stages advance in order and end at done', () => {
    expect(advanceStorageMigrationStage('checking')).toBe('relinking');
    expect(advanceStorageMigrationStage('relinking')).toBe('linking');
    expect(advanceStorageMigrationStage('linking')).toBe('trashing');
    expect(advanceStorageMigrationStage('trashing')).toBe('done');
    expect(advanceStorageMigrationStage('done')).toBe('done');
  });

  it('a batch moves the cursor and counters forward and measures the rate', () => {
    const state = createStorageMigrationState({ total: 1000, now: at(0) });
    const next = recordStorageMigrationBatch(state, {
      patch: { cursor: 'a-500', checked: 500 },
      units: 500,
      startedAt: at(0),
      now: at(10),
    });
    expect(next.cursor).toBe('a-500');
    expect(next.checked).toBe(500);
    expect(next.rate).toBe(50);
    expect(next.updatedAt).toBe(at(10).toISOString());
  });

  it('keeps every counter monotonic when a resumed batch reports less (Review Focus 5)', () => {
    const state = {
      ...createStorageMigrationState({ total: 1000, now: at(0) }),
      checked: 500,
      groupsTotal: 40,
      groupsLinked: 30,
      trashed: 20,
      trashTotal: 25,
      bytesFreed: 2048,
      relinked: 3,
      toReview: 2,
    };
    const next = recordStorageMigrationBatch(state, {
      patch: {
        checked: 400,
        groupsTotal: 38,
        groupsLinked: 10,
        trashed: 5,
        trashTotal: 20,
        bytesFreed: 1024,
        relinked: 1,
        toReview: 1,
      },
      units: 0,
      startedAt: at(0),
      now: at(1),
    });
    expect(next).toMatchObject({
      checked: 500,
      groupsTotal: 40,
      groupsLinked: 30,
      trashed: 20,
      trashTotal: 25,
      bytesFreed: 2048,
      relinked: 3,
      toReview: 2,
    });
  });

  it('never reports more done than the total', () => {
    const state = createStorageMigrationState({ total: 10, now: at(0) });
    const next = recordStorageMigrationBatch(state, {
      patch: { checked: 12 },
      units: 12,
      startedAt: at(0),
      now: at(1),
    });
    expect(next.total).toBe(12);
  });

  it('keeps a bounded list of skipped files without repeating one', () => {
    let state = createStorageMigrationState({ total: 1000, now: at(0) });
    const ids = Array.from({ length: STORAGE_MIGRATION_SKIPPED_SHOWN + 5 }, (_, index) => `asset-${index}`);
    state = recordStorageMigrationBatch(state, {
      patch: {},
      skipped: [...ids.slice(0, 3), ...ids.slice(0, 3)],
      units: 0,
      startedAt: at(0),
      now: at(1),
    });
    expect(state.skipped).toBe(3);
    state = recordStorageMigrationBatch(state, { patch: {}, skipped: ids, units: 0, startedAt: at(1), now: at(2) });
    expect(state.skipped).toBe(ids.length);
    expect(state.skippedAssetIds).toHaveLength(STORAGE_MIGRATION_SKIPPED_SHOWN);
  });

  it('parses a stored state and rejects anything else', () => {
    const state = createStorageMigrationState({ total: 5, now: at(0) });
    expect(parseStorageMigrationState(JSON.parse(JSON.stringify(state)))).toEqual(state);
    expect(parseStorageMigrationState(undefined)).toBeUndefined();
    expect(parseStorageMigrationState({ version: 2 })).toBeUndefined();
    expect(parseStorageMigrationState({ version: 1, stage: 'sideways' })).toBeUndefined();
  });
});

describe('storageMigrationStatus', () => {
  it('reports each stage as X of Y and the review count', () => {
    const state = {
      ...createStorageMigrationState({ total: 1000, now: at(0) }),
      stage: 'linking' as const,
      checked: 1000,
      relinkTotal: 6,
      relinkDone: 6,
      relinked: 4,
      toReview: 2,
      groupsTotal: 100,
      groupsLinked: 25,
      bytesFreed: 0,
      rate: 10,
    };
    const status = storageMigrationStatus(state);
    expect(status.stage).toBe('linking');
    expect(status.stages).toEqual({
      checking: { done: 1000, total: 1000 },
      relinking: { done: 6, total: 6 },
      linking: { done: 25, total: 100 },
      trashing: { done: 0, total: 0 },
    });
    expect(status.relinked).toBe(4);
    expect(status.toReview).toBe(2);
    // 75 groups left at 10 a second
    expect(status.estimatedSecondsLeft).toBe(8);
  });

  it('has no estimate before a rate was measured, and none once done', () => {
    const state = createStorageMigrationState({ total: 1000, now: at(0) });
    expect(storageMigrationStatus(state).estimatedSecondsLeft).toBeNull();
    expect(storageMigrationStatus({ ...state, stage: 'done', rate: 5 }).estimatedSecondsLeft).toBeNull();
  });

  it('says whether Getting Ready should show it', () => {
    const state = createStorageMigrationState({ total: 10, now: at(0) });
    expect(storageMigrationStatus(state).showInGettingReady).toBe(true);
    expect(storageMigrationStatus({ ...state, background: true }).showInGettingReady).toBe(false);
  });

  it('reports a library with nothing to combine as done and not required', () => {
    expect(storageMigrationStatus(undefined)).toMatchObject({ stage: 'pending', showInGettingReady: false });
    const empty = createStorageMigrationState({ total: 0, now: at(0) });
    expect(storageMigrationStatus(empty)).toMatchObject({ stage: 'done', required: false, showInGettingReady: false });
  });
});

describe('finishing a stage', () => {
  it('makes what was done the stage total, so it reads complete', () => {
    const state = { ...createStorageMigrationState({ total: 1000, now: at(0) }), checked: 990 };
    const next = recordStorageMigrationBatch(state, {
      patch: { stage: 'relinking', cursor: null },
      units: 0,
      startedAt: at(0),
      now: at(1),
    });
    expect(next.stage).toBe('relinking');
    expect(storageMigrationStatus(next).stages.checking).toEqual({ done: 990, total: 990 });
  });

  it('records when the migration finished', () => {
    const state = { ...createStorageMigrationState({ total: 10, now: at(0) }), stage: 'trashing' as const };
    const next = recordStorageMigrationBatch(state, {
      patch: { stage: 'done' },
      units: 0,
      startedAt: at(0),
      now: at(5),
    });
    expect(next.finishedAt).toBe(at(5).toISOString());
  });
});
