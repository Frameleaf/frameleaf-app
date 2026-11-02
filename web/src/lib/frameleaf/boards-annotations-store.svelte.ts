/**
 * Boards annotations save state, one per picture (FL-652). Every view of a picture (the details
 * panel's preview, its Annotations list and the Boards viewer) shares the same state from a
 * module-level registry, keyed by asset id: the items shown, the change waiting to save with the
 * revision it was built on, the save in flight, and whether the last save failed.
 *
 * Closing a view never owns or drops edits. A change that couldn't be saved stays registered for
 * its picture and shows as "not saved" with Retry whenever that picture is shown again; it is only
 * ever sent for that picture, through the server's revision check. A read keeps a waiting change
 * built on the revision it returns, and drops one built on any other revision: those positions
 * were drawn on a picture that has since changed. Saving replaces the annotation document only;
 * the file is never touched.
 */
import { getAssetAnnotations, replaceAssetAnnotations, type AssetAnnotationItem } from '@frameleaf/sdk';
import { toStored } from '$lib/frameleaf/boards-annotations';
import { authManager } from '$lib/managers/auth-manager.svelte';

const SAVE_DELAY = 600;

const isConflict = (error: unknown) =>
  typeof error === 'object' && error !== null && (error as { status?: unknown }).status === 409;

type Pending = { items: AssetAnnotationItem[]; revision: string };

export class BoardsAnnotationsState {
  items = $state<AssetAnnotationItem[]>([]);
  canEdit = $state(false);
  status = $state<'loading' | 'ready' | 'failed'>('loading');
  /** The last save failed; the change is still waiting, and Retry sends it again. */
  saveFailed = $state(false);
  /** The picture changed after its annotations were read: they were read again and the last change wasn't kept. */
  reloaded = $state(false);
  /** Goes up each time the annotations are read, so the viewer starts its undo history again. */
  generation = $state(0);
  /** The annotation chosen in the list or on the picture; it shows in accent green. */
  selected = $state<string | null>(null);

  /** The picture revision the shown positions were drawn on. */
  #sourceRevision = '';
  /** The change waiting to save, with the revision it was built on: it is only ever sent with that one. */
  #pending: Pending | null = null;
  #timer: ReturnType<typeof setTimeout> | undefined;
  /** Saves and reads run one after another on this chain, so none lands out of order. */
  #queue: Promise<void> = Promise.resolve();
  /** How many open views show this picture. */
  views = 0;

  constructor(readonly assetId: string) {}

  /** Whether anything is still unsaved or on its way, so the state must stay registered. */
  get busy() {
    return this.#pending !== null;
  }

  /** Reads the annotations, after any save of this picture still on its way. */
  load(): Promise<void> {
    if (this.status !== 'ready') {
      this.status = 'loading';
    }
    this.#queue = this.#queue.then(async () => {
      await this.#read();
    });
    return this.#queue;
  }

  /** Whether the annotations were read. */
  async #read(): Promise<boolean> {
    try {
      const document = await getAssetAnnotations({ ...authManager.params, id: this.assetId });
      this.#apply(document);
      return true;
    } catch {
      if (this.status !== 'ready') {
        this.status = 'failed';
      }
      return false;
    }
  }

  #apply(document: { sourceRevision: string; items: AssetAnnotationItem[]; canEdit: boolean }) {
    this.#sourceRevision = document.sourceRevision;
    this.canEdit = document.canEdit;
    const kept = this.#pending?.revision === document.sourceRevision ? this.#pending : null;
    if (this.#pending && !kept) {
      // the waiting change was drawn on a picture that has since changed: never send it
      clearTimeout(this.#timer);
      this.#pending = null;
      this.saveFailed = false;
      this.reloaded = true;
    }
    // an unsaved change for this revision stays on screen, still waiting to be sent
    this.items = kept ? kept.items : document.items;
    if (this.selected && this.items.every(({ id }) => id !== this.selected)) {
      this.selected = null;
    }
    this.generation++;
    this.status = 'ready';
  }

  /** Shows the change at once and saves it shortly after; typing in a note saves once it pauses. */
  change(next: AssetAnnotationItem[]) {
    this.items = next;
    this.reloaded = false;
    if (this.selected && next.every(({ id }) => id !== this.selected)) {
      this.selected = null;
    }
    if (!this.canEdit) {
      return;
    }
    this.#pending = { items: next, revision: this.#pending?.revision ?? this.#sourceRevision };
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => void this.flush(), SAVE_DELAY);
  }

  /** Saves the waiting change now. Each save takes the latest change when it starts. */
  flush(): Promise<void> {
    clearTimeout(this.#timer);
    this.#queue = this.#queue.then(() => this.#send());
    return this.#queue;
  }

  async #send() {
    const next = this.#pending;
    if (!next) {
      return;
    }
    try {
      const saved = await replaceAssetAnnotations({
        id: this.assetId,
        assetAnnotationsUpdateDto: { version: 1, sourceRevision: next.revision, items: toStored(next.items) },
      });
      this.saveFailed = false;
      if (this.#pending === next) {
        this.#pending = null;
      } else if (this.#pending?.revision === next.revision) {
        // a later change was made on top of what was just saved, so it carries the saved revision
        this.#pending = { ...this.#pending, revision: saved.sourceRevision };
      }
      if (this.#sourceRevision === next.revision) {
        this.#sourceRevision = saved.sourceRevision;
      }
    } catch (error) {
      if (isConflict(error)) {
        // The picture changed after these positions were read, so they may not fit it any more.
        // Nothing was saved: read again, which drops changes built on the old revision, and say so.
        // If that read fails too, the change is still waiting: show it as not saved, with Retry.
        if (await this.#read()) {
          this.reloaded = true;
        } else {
          this.saveFailed = true;
        }
        return;
      }
      // the change stays waiting for Retry, unless a newer one has replaced it
      this.saveFailed = true;
    }
  }

  retry() {
    this.#pending ??= { items: this.items, revision: this.#sourceRevision };
    void this.flush();
  }
}

const registry = new Map<string, BoardsAnnotationsState>();

/** The shared annotations of a picture for a view that opens; pair each call with `releaseAnnotations`. */
export const acquireAnnotations = (assetId: string): BoardsAnnotationsState => {
  let state = registry.get(assetId);
  if (!state) {
    state = new BoardsAnnotationsState(assetId);
    registry.set(assetId, state);
  }
  state.views++;
  return state;
};

/**
 * A view of the picture closed. Its waiting change is saved; the state leaves the registry only
 * once no view shows the picture and nothing is left unsaved. A failed save keeps it registered.
 */
export const releaseAnnotations = async (state: BoardsAnnotationsState): Promise<void> => {
  state.views = Math.max(0, state.views - 1);
  await state.flush();
  if (state.views === 0 && !state.busy && registry.get(state.assetId) === state) {
    registry.delete(state.assetId);
  }
};

/** For tests: forget every registered picture. */
export const resetAnnotationsRegistry = () => registry.clear();
