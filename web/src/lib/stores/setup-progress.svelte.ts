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
  /** The newest request asked, and the newest shown, so a page that has gone cannot undo the next page's answer. */
  requested = 0;
  applied = 0;

  /** The next bar starts from nothing. */
  reset() {
    this.progress = null;
    this.height = 0;
    this.since = null;
    this.requested = 0;
    this.applied = 0;
  }
}

export const setupProgress = new SetupProgressStore();
