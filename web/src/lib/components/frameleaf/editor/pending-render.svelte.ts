import { SvelteMap } from 'svelte/reactivity';

/**
 * Edits being finished after "Save version" closed the editor, by item. The editor's follower
 * reports progress here so the viewer can say, on the photo, that an edit is on its way, and that
 * it has arrived. Nothing here is saved state: it only mirrors what the follower last heard.
 */

export type PendingRender = {
  /** 0 to 100 once the work has started; null while it waits its turn. */
  progress: number | null;
  /** The edit has arrived; shown briefly before the entry goes. */
  ready: boolean;
};

/** How long "Your edit is ready" stays on the photo. */
export const RENDER_READY_MS = 1600;

const renders = new SvelteMap<string, PendingRender>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();

const clearTimer = (assetId: string) => {
  const timer = timers.get(assetId);
  if (timer) {
    clearTimeout(timer);
    timers.delete(assetId);
  }
};

export const pendingRender = (assetId: string): PendingRender | undefined => renders.get(assetId);

export const setRenderProgress = (assetId: string, progress: number | null): void => {
  clearTimer(assetId);
  renders.set(assetId, { progress, ready: false });
};

/** The edit arrived: say so for a moment, then forget it. */
export const markRenderReady = (assetId: string): void => {
  clearTimer(assetId);
  renders.set(assetId, { progress: 100, ready: true });
  timers.set(
    assetId,
    setTimeout(() => clearRender(assetId), RENDER_READY_MS),
  );
};

/** The edit failed, was cancelled, or is no longer followed. */
export const clearRender = (assetId: string): void => {
  clearTimer(assetId);
  renders.delete(assetId);
};
