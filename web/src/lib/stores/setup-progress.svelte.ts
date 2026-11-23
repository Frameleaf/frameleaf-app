import type { LibrarySetupProgressDto, LibrarySetupStageId } from '@frameleaf/sdk';
import { eventManager } from '$lib/managers/event-manager.svelte';

/**
 * FL-1178: the setup bar's last answer, kept across pages. TopBar mounts on each page, and a bar that started empty
 * hid, then came back a moment later and pushed the page down by its height.
 */
class SetupProgressStore {
  progress = $state<LibrarySetupProgressDto | null>(null);
  height = $state(0);
  /** The first reading of the current stage, for the time-left estimate. */
  since = $state<{ id: LibrarySetupStageId; at: number; done: number } | null>(null);
  /** The newest request asked, and the newest shown, so a page that has gone cannot undo the next page's answer. */
  requested = 0;
  applied = 0;

  constructor() {
    // Signing out keeps this document: the next account must not start from this one's progress.
    eventManager.on({ AuthLogout: () => this.reset() });
  }

  /** The next bar starts from nothing; an answer still on its way from before this is never shown. */
  reset() {
    this.progress = null;
    this.height = 0;
    this.since = null;
    this.applied = this.requested;
  }
}

export const setupProgress = new SetupProgressStore();
