/**
 * One picture's Boards annotations while its details panel is open (FL-652): read from the server,
 * shared by the panel's preview, its Annotations list and the Boards viewer, and saved back a moment
 * after each change. Saving replaces the annotation document only; the file is never touched.
 */
import { getAssetAnnotations, replaceAssetAnnotations, type AssetAnnotationItem } from '@frameleaf/sdk';
import { toStored } from '$lib/frameleaf/boards-annotations';
import { authManager } from '$lib/managers/auth-manager.svelte';

const SAVE_DELAY = 600;

export class BoardsAnnotationsState {
  items = $state<AssetAnnotationItem[]>([]);
  canEdit = $state(false);
  status = $state<'loading' | 'ready' | 'failed'>('loading');
  saveFailed = $state(false);
  /** The annotation chosen in the list or on the picture; it shows in accent green. */
  selected = $state<string | null>(null);

  #timer: ReturnType<typeof setTimeout> | undefined;
  #pending: AssetAnnotationItem[] | null = null;
  #closed = false;
  #saving: Promise<void> = Promise.resolve();

  constructor(readonly assetId: string) {}

  async load() {
    this.status = 'loading';
    try {
      const document = await getAssetAnnotations({ ...authManager.params, id: this.assetId });
      if (this.#closed) {
        return;
      }
      this.items = document.items;
      this.canEdit = document.canEdit;
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
      await replaceAssetAnnotations({
        id: this.assetId,
        assetAnnotationsUpdateDto: { version: 1, items: toStored(next) },
      });
      this.saveFailed = false;
    } catch {
      this.saveFailed = true;
      // keep the change so Retry can send it again, unless a newer one is already waiting
      this.#pending ??= next;
    }
  }

  retry() {
    this.#pending ??= this.items;
    void this.flush();
  }

  close() {
    this.#closed = true;
    void this.flush();
  }
}
