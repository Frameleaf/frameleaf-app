import { getUtilitiesSummary } from '@frameleaf/sdk';
import { authManager } from '$lib/managers/auth-manager.svelte';
import { eventManager } from '$lib/managers/event-manager.svelte';

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
  /** Bumped when the account changes or someone signs out; a read only applies within its own session. */
  #session = 0;

  constructor() {
    // Signing out forgets the reader, so an answer still in flight is dropped and the next sign-in reads again.
    eventManager.on({ AuthLogout: () => this.reset() });
  }

  get isOwner() {
    return this.totals !== null;
  }

  /** Reads it for this account, once. An account that is not an administrator never asks. */
  load(userId: string, isAdmin: boolean): Promise<void> {
    if (this.#userId !== userId) {
      this.#userId = userId;
      this.#session++;
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
    // An answer that arrives after the account changed or someone signed out (even back in as the same
    // account) belongs to an earlier session: dropped.
    const session = this.#session;
    try {
      const summary = await getUtilitiesSummary();
      if (this.#session === session) {
        this.totals =
          summary.unusedFiles === null ? null : { files: summary.unusedFiles, bytes: summary.unusedBytes ?? 0 };
      }
    } catch {
      if (this.#session === session) {
        this.totals = null;
      }
    } finally {
      if (this.#session === session) {
        this.loaded = true;
      }
    }
  }

  /** Forgets the reader: on sign-out, and in tests. */
  reset() {
    this.#session++;
    this.#reading = undefined;
    this.#userId = undefined;
    this.totals = null;
    this.loaded = false;
  }
}

export const unusedFilesAccess = new UnusedFilesAccess();
