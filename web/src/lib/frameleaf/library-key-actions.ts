import type { Translations } from 'svelte-i18n';
import { bulkActions, type BulkActionContext, type BulkActionId, type BulkAsset } from '$lib/frameleaf/bulk-actions';
import type { BulkPayload } from '$lib/frameleaf/bulk-operations';
import type { LibraryShortcut } from '$lib/frameleaf/library-shortcuts';

/**
 * The action half of the library key map (FL-33, T-5), as a pure plan.
 *
 * Ported from the prototype's library keydown (`App.jsx`, `shortcuts.mjs` "actions"): a key acts on
 * the selection when there is one, else on the item in focus. Every bulk action is offered exactly
 * as the selection bar would offer it for those items (`bulkActions`): a key never does what the
 * bar would refuse — nothing on the Locked page is favorited, stacked or archived, and nobody
 * else's items change. `LibraryView` carries the plan out.
 */
export type KeyItem = BulkAsset & {
  /** A still the owner may rate, edit and tag faces on. */
  isImage?: boolean;
};

export type KeyActionInput = {
  /** The selected items (resolved), or empty. */
  selection: readonly KeyItem[];
  /** A "select everything matching" snapshot: its items are not resolved, so no key acts on it. */
  snapshot?: boolean;
  /** The tile that holds keyboard focus. The scroll anchor is not a focus. */
  focused: KeyItem | null;
  /** The page's bulk context: trash, Locked, album, shared link, read-only. */
  context: Omit<BulkActionContext, 'assets' | 'count' | 'snapshot'>;
  /** Ratings are switched on in the account's preferences. */
  ratingsEnabled: boolean;
  /** The page has a viewer (the quick editor and the face tagger live there). */
  hasViewer: boolean;
};

export type KeyActionPlan =
  | { kind: 'none' }
  /** Run a bulk action on these items without selecting them. */
  | { kind: 'run'; action: BulkActionId; ids: string[]; payload?: BulkPayload }
  /** Hand the action to the selection bar, which opens its dialog or confirmation (selecting first if needed). */
  | { kind: 'bar'; action: BulkActionId; ids: string[] }
  | { kind: 'rate'; id: string; value: number }
  | { kind: 'edit'; id: string }
  | { kind: 'tag-people'; id: string }
  /** Prototype T: the item joins the selection and the bar's Tag does the rest. */
  | { kind: 'select-hint'; id: string | null; hint: Translations }
  | { kind: 'toast'; message: Translations };

const NONE: KeyActionPlan = { kind: 'none' };

/** Whether the bar would offer this action for these items, on this page. */
export const barOffers = (
  action: BulkActionId,
  items: readonly KeyItem[],
  context: KeyActionInput['context'],
): boolean => {
  if (items.length === 0) {
    return false;
  }
  // A Locked item is Locked wherever it shows (an unlocked session's timeline, an album): the bar's
  // Locked rules apply to it, not the ordinary library's.
  const locked = !!context.locked || items.some((item) => item.isLocked);
  return bulkActions({ ...context, locked, assets: [...items], count: items.length }).some(
    (candidate) => candidate.id === action && candidate.available,
  );
};

const owned = (item: KeyItem | null, context: KeyActionInput['context']): item is KeyItem =>
  !!item && !!context.currentUserId && item.ownerId === context.currentUserId && !item.isTrashed && !context.trash;

export const planKeyAction = (
  shortcut: Pick<LibraryShortcut, 'id' | 'value'>,
  input: KeyActionInput,
): KeyActionPlan => {
  const { selection, focused, context } = input;
  if (input.snapshot) {
    return NONE;
  }
  const targets = selection.length > 0 ? [...selection] : focused ? [focused] : [];
  const ids = targets.map((item) => item.id);
  /**
   * A change runs on the caller's own items only (a partner's photo shows in the library but is
   * theirs); a download takes everything shown. Nothing runs where the bar would not offer it.
   */
  const run = (action: BulkActionId, payload?: BulkPayload): KeyActionPlan => {
    const mine = action === 'download' ? targets : targets.filter((item) => owned(item, context));
    if (mine.length === 0 || !barOffers(action, mine, context)) {
      return NONE;
    }
    return { kind: 'run', action, ids: mine.map((item) => item.id), ...(payload && { payload }) };
  };
  // The single item a one-item key (rate, edit, tag people) acts on: the focused tile, else the one selected.
  const current = focused ?? (selection.length === 1 ? selection[0] : null);
  const editable = owned(current, context) && !current.isLocked && !context.locked && !context.readOnly;

  switch (shortcut.id) {
    case 'rate-1':
    case 'rate-2':
    case 'rate-3':
    case 'rate-4':
    case 'rate-5':
    case 'rate-clear': {
      return input.ratingsEnabled && editable && current && shortcut.value !== undefined
        ? { kind: 'rate', id: current.id, value: shortcut.value }
        : NONE;
    }
    case 'favorite': {
      const favorite = targets.length > 0 && targets.every((item) => item.isFavorite);
      return run(favorite ? 'unfavorite' : 'favorite');
    }
    case 'edit': {
      return input.hasViewer && editable && current ? { kind: 'edit', id: current.id } : NONE;
    }
    case 'tag-people': {
      return input.hasViewer && editable && current && current.isImage !== false && !current.isVideo
        ? { kind: 'tag-people', id: current.id }
        : NONE;
    }
    case 'stack': {
      if (targets.length < 2) {
        return { kind: 'toast', message: 'frameleaf_library_shortcut_stack_needs_two' };
      }
      const plan = run('stack');
      // Stacking needs two of the caller's own items; the first selected leads the stack.
      return plan.kind === 'run' && plan.ids.length >= 2 ? { ...plan, payload: { primaryId: plan.ids[0] } } : NONE;
    }
    case 'add-to-album': {
      return barOffers('add-to-album', targets, context) ? { kind: 'bar', action: 'add-to-album', ids } : NONE;
    }
    case 'tag': {
      if (!barOffers('tag', targets, context)) {
        return NONE;
      }
      return {
        kind: 'select-hint',
        id: selection.length > 0 ? null : (focused?.id ?? null),
        hint: 'frameleaf_library_shortcut_tag_hint',
      };
    }
    case 'archive': {
      const archived = targets.length > 0 && targets.every((item) => item.isArchived);
      return run(archived ? 'unarchive' : 'archive');
    }
    case 'download': {
      return run('download');
    }
    case 'delete': {
      // With a selection the bar's own Delete key acts. Alone, only a focused tile is deleted, and
      // through the bar, so the trash's and Locked's permanent deletion keep their confirmation.
      if (selection.length > 0 || !focused || !context.currentUserId || focused.ownerId !== context.currentUserId) {
        return NONE;
      }
      const permanent = !!context.trash || !!context.locked || !!focused.isLocked;
      const action: BulkActionId = permanent ? 'delete-permanently' : 'delete';
      return barOffers(action, [focused], context) ? { kind: 'bar', action, ids: [focused.id] } : NONE;
    }
    default: {
      return NONE;
    }
  }
};

/** Any open modal: a native dialog, or an ARIA modal (the upstream modals and the palettes). */
export const MODAL_SELECTOR = 'dialog[open], [role="dialog"][aria-modal="true"], [role="alertdialog"]';

/**
 * Whether the library may act on a key at all: not while the viewer has it, not while a dialog or
 * any modal owns the keyboard, not while typing, and not when another control already used it.
 */
export const libraryKeysActive = ({
  viewing,
  defaultPrevented,
  typing,
  root = document,
}: {
  viewing: boolean;
  defaultPrevented: boolean;
  typing: boolean;
  root?: Pick<Document, 'querySelector'>;
}) => !viewing && !defaultPrevented && !typing && !root?.querySelector(MODAL_SELECTOR);
