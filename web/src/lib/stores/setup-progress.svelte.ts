import type { LibrarySetupProgressDto, LibrarySetupStageId } from '@frameleaf/sdk';

/**
 * FL-1178: the setup bar's last answer, kept across pages. TopBar mounts on each page, and a bar that started empty
 * hid, then came back a moment later and pushed the page down by its height.
 */
class SetupProgressStore {
  progress = $state<LibrarySetupProgressDto | null>(null);
  height = $state(0);
  /** The first reading of the current stage, for the time-left estimate. */
  since = $state<{ id: LibrarySetupStageId; at: number; done: number } | null>(null);

  /** The next bar starts from nothing. */
  reset() {
    this.progress = null;
    this.height = 0;
    this.since = null;
  }
}

export const setupProgress = new SetupProgressStore();
