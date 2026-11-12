import type { AccountActivityResponseDto } from '@frameleaf/sdk';
import type { ActivityEvent } from '$lib/frameleaf/account-activity';

/**
 * The rows an activity page has loaded (FL-824): the first page, then earlier pages on the server's
 * cursor (`before` is the last row's id). An answer that arrives after the list was reloaded (a
 * retry, or another person chosen in the household log) is dropped.
 */
export class ActivityFeed {
  /** Newest first; null while the first page loads. */
  events = $state<ActivityEvent[] | null>(null);
  hasMore = $state(false);
  /** The first page could not be read. */
  failed = $state(false);
  loadingMore = $state(false);
  /** An earlier page could not be read; the rows already shown stay. */
  moreFailed = $state(false);
  /** How many earlier pages have been read since the list was last read from its start. */
  pages = $state(0);
  #run = 0;
  #fetchPage: (before?: string) => Promise<AccountActivityResponseDto>;

  constructor(fetchPage: (before?: string) => Promise<AccountActivityResponseDto>) {
    this.#fetchPage = fetchPage;
  }

  /** Reads the list from its start. */
  async load() {
    const run = ++this.#run;
    this.events = null;
    this.hasMore = false;
    this.failed = false;
    this.loadingMore = false;
    this.moreFailed = false;
    this.pages = 0;
    try {
      const page = await this.#fetchPage();
      if (run === this.#run) {
        this.events = page.events;
        this.hasMore = page.hasMore;
      }
    } catch {
      if (run === this.#run) {
        this.failed = true;
      }
    }
  }

  /** Reads the next earlier page, unless one is already on its way or there is none. */
  async more() {
    const last = this.events?.at(-1);
    if (!last || !this.hasMore || this.loadingMore) {
      return;
    }
    const run = this.#run;
    this.loadingMore = true;
    this.moreFailed = false;
    try {
      const page = await this.#fetchPage(last.id);
      if (run === this.#run) {
        const known = new Set(this.events?.map((event) => event.id));
        this.events = [...(this.events ?? []), ...page.events.filter((event) => !known.has(event.id))];
        this.hasMore = page.hasMore;
        this.pages++;
      }
    } catch {
      if (run === this.#run) {
        this.moreFailed = true;
      }
    } finally {
      if (run === this.#run) {
        this.loadingMore = false;
      }
    }
  }
}
