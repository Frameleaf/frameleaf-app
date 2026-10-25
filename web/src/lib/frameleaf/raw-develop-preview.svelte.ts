/**
 * Server previews for the RAW develop editor (FL-420). Every slider change asks the server to develop
 * the recipe at preview size (`POST /assets/:id/develop/preview`), debounced and cancellable; the last
 * good preview stays on screen while the next one renders. Recent previews are kept, so holding the
 * original, undoing or going back to a photo shows them again at once.
 */
import { PREVIEW_DEBOUNCE_MS, requestDevelopPreview, type PreviewResult } from '$lib/frameleaf/develop-api';
import type { NativeRecipe } from '$lib/frameleaf/native-develop';

const CACHE_SIZE = 16;

export class DevelopPreviewLoader {
  /** The preview on screen, and the request it answers. */
  url = $state<string | null>(null);
  key = $state<string | null>(null);
  busy = $state(false);
  error = $state<unknown>(null);

  constructor(private readonly onPreview?: (assetId: string, sourceVersion?: string, refreshed?: boolean) => void) {}

  #cache = new Map<string, PreviewResult>();
  #timer: ReturnType<typeof setTimeout> | undefined;
  #abort: AbortController | undefined;
  #wanted: string | null = null;

  /** Shows the preview for this request, rendering it first unless it was rendered recently. */
  request(assetId: string, recipe: NativeRecipe, size: number, refresh = false) {
    const key = `${assetId}:${size}:${JSON.stringify(recipe)}`;
    if (key === this.#wanted && !refresh) {
      return;
    }
    this.#wanted = key;
    clearTimeout(this.#timer);
    this.#abort?.abort();
    const cached = refresh ? undefined : this.#cache.get(key);
    if (cached) {
      // Most recently used last.
      this.#cache.delete(key);
      this.#cache.set(key, cached);
      this.#show(assetId, key, cached);
      this.busy = false;
      return;
    }
    const controller = new AbortController();
    this.#abort = controller;
    this.busy = true;
    this.#timer = setTimeout(() => {
      void (async () => {
        try {
          const result = await requestDevelopPreview(assetId, recipe, size, controller.signal);
          if (!result || controller.signal.aborted) {
            result?.revoke();
            return;
          }
          if (refresh) {
            // All settings cached for this photo may use the old original.
            for (const [cachedKey, entry] of this.#cache) {
              if (cachedKey.startsWith(`${assetId}:`)) {
                entry.revoke();
                this.#cache.delete(cachedKey);
              }
            }
          }
          this.#remember(key, result);
          if (this.#wanted === key) {
            this.#show(assetId, key, result, refresh);
            this.error = null;
          }
        } catch (error) {
          if (!controller.signal.aborted) {
            this.error = error;
          }
        } finally {
          if (!controller.signal.aborted) {
            this.busy = false;
          }
        }
      })();
    }, PREVIEW_DEBOUNCE_MS);
  }

  /** The preview of another photo must never stand in for this one. */
  forget(assetId: string) {
    if (this.key && !this.key.startsWith(`${assetId}:`)) {
      this.url = null;
      this.key = null;
    }
  }

  #show(assetId: string, key: string, result: PreviewResult, refreshed = false) {
    this.onPreview?.(assetId, result.sourceVersion, refreshed);
    this.url = result.url;
    this.key = key;
  }

  #remember(key: string, result: PreviewResult) {
    this.#cache.set(key, result);
    while (this.#cache.size > CACHE_SIZE) {
      const [oldest, entry] = this.#cache.entries().next().value!;
      if (oldest === this.key) {
        // Keep what is on screen; drop the next oldest instead.
        this.#cache.delete(oldest);
        this.#cache.set(oldest, entry);
        continue;
      }
      entry.revoke();
      this.#cache.delete(oldest);
    }
  }

  dispose() {
    clearTimeout(this.#timer);
    this.#abort?.abort();
    for (const entry of this.#cache.values()) {
      entry.revoke();
    }
    this.#cache.clear();
  }
}
