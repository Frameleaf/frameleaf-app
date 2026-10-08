import { saveEditorContinuity, type EditorContinuity } from '$lib/frameleaf/editor-continuity';
import { TOAST_ACTION_TIMEOUT_MS, toastUndo } from '$lib/frameleaf/toast';

/**
 * Cancel and Escape close an editor at once, without a confirmation. So that one stray key press
 * cannot cost real work, the unsaved draft is set aside here for as long as the "Edits discarded"
 * toast offers Undo. Undo hands it back through the same continuity record a trip to Studio uses,
 * so the editor reopens exactly where it was. When the toast goes, so does the draft.
 *
 * The draft is held in memory only: it never outlives the page, and it is never applied by itself.
 */

export type DiscardedDraft = Omit<EditorContinuity, 'version' | 'savedAt'>;

/** A little longer than the toast, so a press as it fades still finds the draft. */
const GRACE_MS = 1000;

const parked = new Map<string, { record: DiscardedDraft; timer: ReturnType<typeof setTimeout> }>();

const forget = (assetId: string) => {
  const entry = parked.get(assetId);
  if (entry) {
    clearTimeout(entry.timer);
    parked.delete(assetId);
  }
};

/** Whether a discarded draft for this item can still be brought back. */
export const hasDiscardedDraft = (assetId: string): boolean => parked.has(assetId);

/**
 * Says the edits were discarded and offers Undo. `reopen` is called with the item's id after the
 * draft has been put back where the editor will find it.
 */
export const discardWithUndo = (record: DiscardedDraft, message: string, reopen: (assetId: string) => void): void => {
  const { assetId } = record;
  forget(assetId);
  parked.set(assetId, { record, timer: setTimeout(() => forget(assetId), TOAST_ACTION_TIMEOUT_MS + GRACE_MS) });
  toastUndo(message, () => {
    if (parked.get(assetId)?.record !== record) {
      return;
    }
    forget(assetId);
    saveEditorContinuity(record);
    reopen(assetId);
  });
};

/** Test helper: drop every held draft. */
export const resetDiscardedDrafts = (): void => {
  for (const assetId of parked.keys()) {
    forget(assetId);
  }
};
