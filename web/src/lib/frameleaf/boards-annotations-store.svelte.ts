/**
 * One picture's Boards annotations while its details panel is open (FL-652): read from the server,
 * shared by the panel's preview, its Annotations list and the Boards viewer, and saved back a moment
 * after each change. Saving replaces the annotation document only; the file is never touched.
 */
import { getAssetAnnotations, replaceAssetAnnotations, type AssetAnnotationItem } from '@frameleaf/sdk';
import { toStored } from '$lib/frameleaf/boards-annotations';
import { authManager } from '$lib/managers/auth-manager.svelte';

const SAVE_DELAY = 600;

/**
 * The last save of each picture whose panel closed. Opening the picture again reads its annotations
 * only after that save has landed, so the read never returns the document from before it.
 */
const closing = new Map<string, Promise<void>>();

const isConflict = (error: unknown) =>
  typeof error === 'object' && error !== null && (error as { status?: unknown }).status === 409;

export class BoardsAnnotationsState {
  items = $state<AssetAnnotationItem[]>([]);
  canEdit = $state(false);
  status = $state<'loading' | 'ready' | 'failed'>('loading');
  saveFailed = $state(false);
  /** Set when the picture changed after its annotations were read: they were read again and the last change wasn't kept. */
  reloaded = $state(false);
  /** Goes up each time the annotations are read, so the viewer starts its undo history again. */
  generation = $state(0);
  /** The annotation chosen in the list or on the picture; it shows in accent green. */
  selected = $state<string | null>(null);

  /** The picture revision the positions were drawn on, sent with each save so a stale list is refused. */
  #sourceRevision = '';
  #timer: ReturnType<typeof setTimeout> | undefined;
  #pending: AssetAnnotationItem[] | null = null;
  #closed = false;
  #saving: Promise<void> = Promise.resolve();

  constructor(readonly assetId: string) {}

  async load() {
    this.status = 'loading';
    await closing.get(this.assetId);
    try {
      const document = await getAssetAnnotations({ ...authManager.params, id: this.assetId });
      if (this.#closed) {
        return;
      }
      this.#sourceRevision = document.sourceRevision;
      this.items = document.items;
      this.canEdit = document.canEdit;
      if (this.selected && document.items.every(({ id }) => id !== this.selected)) {
        this.selected = null;
      }
      this.generation++;
      this.status = 'ready';
    } catch {
      if (!this.#closed) {
        this.status = 'failed';
      }
    }
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
    this.#pending = next;
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => void this.flush(), SAVE_DELAY);
  }

  /**
   * Saves a waiting change now: when the viewer closes or the panel moves to another item. Saves run
   * one after another, each taking the latest change when it starts, so an older list can never land
   * after a newer one or come back through Retry.
   */
  flush(): Promise<void> {
    clearTimeout(this.#timer);
    this.#saving = this.#saving.then(() => this.#send());
    return this.#saving;
  }

  async #send() {
    const next = this.#pending;
    this.#pending = null;
    if (!next) {
      return;
    }
    try {
      const saved = await replaceAssetAnnotations({
        id: this.assetId,
        assetAnnotationsUpdateDto: { version: 1, sourceRevision: this.#sourceRevision, items: toStored(next) },
      });
      this.#sourceRevision = saved.sourceRevision;
      this.saveFailed = false;
    } catch (error) {
      if (isConflict(error)) {
        // The picture changed after these positions were read, so they may not fit it any more.
        // Nothing was saved: read the annotations again and say so, rather than retrying stale ones.
        this.#pending = null;
        this.saveFailed = false;
        this.reloaded = true;
        if (!this.#closed) {
          await this.load();
        }
        return;
      }
      this.saveFailed = true;
      // keep the change so Retry can send it again, unless a newer one is already waiting
      this.#pending ??= next;
    }
  }

  retry() {
    this.#pending ??= this.items;
    void this.flush();
  }

  /** Saves any waiting change; reading this picture again waits for it, and for any earlier close. */
  close(): Promise<void> {
    this.#closed = true;
    const previous = closing.get(this.assetId) ?? Promise.resolve();
    const done = previous.then(() => this.flush());
    closing.set(this.assetId, done);
    void done.finally(() => {
      if (closing.get(this.assetId) === done) {
        closing.delete(this.assetId);
      }
    });
    return done;
  }
}
