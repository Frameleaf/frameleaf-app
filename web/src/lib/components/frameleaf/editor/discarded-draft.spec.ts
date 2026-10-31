import { readEditorContinuity } from '$lib/frameleaf/editor-continuity';
import { TOAST_ACTION_TIMEOUT_MS } from '$lib/frameleaf/toast';
import { discardWithUndo, hasDiscardedDraft, resetDiscardedDrafts, type DiscardedDraft } from './discarded-draft';

const toast = vi.hoisted(() => ({ undo: undefined as (() => unknown) | undefined, message: '' }));
vi.mock('$lib/frameleaf/toast', () => ({
  TOAST_ACTION_TIMEOUT_MS: 8000,
  toastUndo: (message: string, onUndo: () => unknown) => {
    toast.message = message;
    toast.undo = onUndo;
  },
}));

const record = (assetId = 'asset'): DiscardedDraft => ({
  assetId,
  kind: 'photo',
  draft: { recipe: { contrast: 40 } },
  base: 'base',
  tool: 'adjust',
  playhead: { num: 0, den: 1 },
});

describe('discardWithUndo', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    sessionStorage.clear();
    resetDiscardedDrafts();
  });
  afterEach(() => vi.useRealTimers());

  it('keeps the draft out of the tab store until Undo, then hands it back and reopens', () => {
    const reopen = vi.fn();
    discardWithUndo(record(), 'Edits discarded', reopen);
    expect(toast.message).toBe('Edits discarded');
    expect(hasDiscardedDraft('asset')).toBe(true);
    expect(readEditorContinuity('asset')).toBeNull();

    toast.undo!();
    expect(reopen).toHaveBeenCalledExactlyOnceWith('asset');
    expect(readEditorContinuity('asset')).toMatchObject({ kind: 'photo', tool: 'adjust' });
    expect(hasDiscardedDraft('asset')).toBe(false);
  });

  it('lets the draft go when the toast does', () => {
    const reopen = vi.fn();
    discardWithUndo(record(), 'Edits discarded', reopen);
    vi.advanceTimersByTime(TOAST_ACTION_TIMEOUT_MS + 1500);
    expect(hasDiscardedDraft('asset')).toBe(false);
    toast.undo!();
    expect(reopen).not.toHaveBeenCalled();
    expect(readEditorContinuity('asset')).toBeNull();
  });

  it('only the latest discard of an item can be undone', () => {
    const reopen = vi.fn();
    discardWithUndo(record(), 'Edits discarded', reopen);
    const firstUndo = toast.undo!;
    discardWithUndo(record(), 'Edits discarded', reopen);
    firstUndo();
    expect(reopen).not.toHaveBeenCalled();
    toast.undo!();
    expect(reopen).toHaveBeenCalledOnce();
  });
});
