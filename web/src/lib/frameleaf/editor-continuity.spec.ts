import { describe, expect, it } from 'vitest';
import {
  STUDIO_CONTINUITY_TTL_MS,
  clearEditorContinuity,
  continuityBase,
  readEditorContinuity,
  reportStudioPlayhead,
  resumeEditorContinuity,
  saveEditorContinuity,
  secondsToRational,
  type ContinuityStorage,
} from './editor-continuity';

const store = (): ContinuityStorage & { map: Map<string, string> } => {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key),
  };
};

const base = continuityBase({ exposure: 0 });
const record = {
  assetId: 'asset-1',
  kind: 'video' as const,
  draft: { edit: { start: 1 }, undo: [{ start: 0 }], redo: [] },
  base,
  tool: 'trim',
  playhead: secondsToRational(2.5),
};

describe('quick editor ↔ Studio continuity (FL-113)', () => {
  it('gives the draft, its history, the tool and the playhead back once', () => {
    const storage = store();
    saveEditorContinuity(record, storage, 1000);
    expect(resumeEditorContinuity('asset-1', base, storage, 2000)).toEqual({
      status: 'resumed',
      draft: record.draft,
      tool: 'trim',
      playhead: 2.5,
    });
    // Picked up: it belongs to the editor now, not to a later open.
    expect(resumeEditorContinuity('asset-1', base, storage, 2000)).toEqual({ status: 'none' });
  });

  it('prefers Studio’s playhead when the person comes back from Studio', () => {
    const storage = store();
    saveEditorContinuity(record, storage, 1000);
    reportStudioPlayhead('asset-1', { num: 7, den: 2 }, storage, 1500);
    expect(resumeEditorContinuity('asset-1', base, storage, 2000)).toMatchObject({ status: 'resumed', playhead: 3.5 });
  });

  it('never replays a draft over a saved state that moved on', () => {
    const storage = store();
    saveEditorContinuity(record, storage, 1000);
    expect(resumeEditorContinuity('asset-1', continuityBase({ exposure: 0.5 }), storage, 2000)).toEqual({
      status: 'stale',
    });
    expect(readEditorContinuity('asset-1', storage, 2000)).toBeNull();
  });

  it('ignores an expired, malformed or foreign record', () => {
    const storage = store();
    saveEditorContinuity(record, storage, 1000);
    expect(readEditorContinuity('asset-1', storage, 1000 + STUDIO_CONTINUITY_TTL_MS + 1)).toBeNull();
    storage.setItem('frameleaf.editor.continuity.asset-2', '{not json');
    expect(readEditorContinuity('asset-2', storage)).toBeNull();
    storage.setItem(
      'frameleaf.editor.continuity.asset-3',
      JSON.stringify({ ...record, assetId: 'asset-3', playhead: 1.5 }),
    );
    expect(readEditorContinuity('asset-3', storage)).toBeNull();
  });

  it('is cleared by a save or a cancel', () => {
    const storage = store();
    saveEditorContinuity(record, storage);
    clearEditorContinuity('asset-1', storage);
    expect(storage.map.size).toBe(0);
  });

  it('keeps playheads exact', () => {
    expect(secondsToRational(12.5)).toEqual({ num: 25, den: 2 });
    expect(secondsToRational(0)).toEqual({ num: 0, den: 1 });
    expect(secondsToRational(1.001)).toEqual({ num: 1001, den: 1000 });
  });
});
