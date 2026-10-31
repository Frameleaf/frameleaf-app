import { getUtilitiesSummary } from '@frameleaf/sdk';
import { authManager } from '$lib/managers/auth-manager.svelte';

/** What Unused files holds: the files and their size. */
export type UnusedFilesTotals = { files: number; bytes: number };

/**
 * FL-416: Unused files belongs to the server owner alone, the first administrator. The server says so by
 * counting it only for them (`GET /utilities/summary`: `unusedFiles` is null for everyone else), and
 * refuses its API to anyone else. Every place that shows Unused files (its page, the Library care tool,
 * Storage & originals, Duplicates) reads this one answer, so a member or another administrator never
 * sees it.
 */
class UnusedFilesAccess {
  /** null until read, and while the reader is not the server owner. */
  totals = $state<UnusedFilesTotals | null>(null);
  /** Read once for this account; false until then. */
  loaded = $state(false);
  #reading: Promise<void> | undefined;
  #userId: string | undefined;

  get isOwner() {
    return this.totals !== null;
  }

  /** Reads it for this account, once. An account that is not an administrator never asks. */
  load(userId: string, isAdmin: boolean): Promise<void> {
    if (this.#userId !== userId) {
      this.#userId = userId;
      this.#reading = undefined;
      this.totals = null;
      this.loaded = false;
    }
    if (!isAdmin) {
      this.loaded = true;
      return Promise.resolve();
    }
    this.#reading ??= this.refresh();
    return this.#reading;
  }

  /** `load` for the signed-in account; nothing before someone is signed in. */
  loadForCurrentUser(): Promise<void> {
    if (!authManager.authenticated) {
      return Promise.resolve();
    }
    return this.load(authManager.user.id, authManager.user.isAdmin);
  }

  /** Reads the totals again, after something changed them (a restore, emptying it). */
  async refresh(): Promise<void> {
    // An answer that arrives after the account changed belongs to the previous account: dropped.
    const userId = this.#userId;
    try {
      const summary = await getUtilitiesSummary();
      if (this.#userId === userId) {
        this.totals =
          summary.unusedFiles === null ? null : { files: summary.unusedFiles, bytes: summary.unusedBytes ?? 0 };
      }
    } catch {
      if (this.#userId === userId) {
        this.totals = null;
      }
    } finally {
      if (this.#userId === userId) {
        this.loaded = true;
      }
    }
  }

  /** For tests. */
  reset() {
    this.#reading = undefined;
    this.#userId = undefined;
    this.totals = null;
    this.loaded = false;
  }
}

export const unusedFilesAccess = new UnusedFilesAccess();
