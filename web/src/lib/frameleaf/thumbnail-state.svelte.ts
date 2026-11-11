import { getProcessingFailures, ProcessingFailureStep } from '@frameleaf/sdk';
import { SvelteSet } from 'svelte/reactivity';
import { authManager } from '$lib/managers/auth-manager.svelte';

/**
 * FL-1409 (M5): a photo with no thumbnail is either still waiting for one or can't be shown. The Library tells them
 * apart from what it is already sent:
 *
 * - `thumbhash` is null until the thumbnail job has made the picture, so a tile without one is not ready;
 * - `isOffline` says the file is missing from its external library (Library care lists it as missing);
 * - the processing-failures list (the one Library care's "Couldn't process" reads) names every photo whose
 *   thumbnail step failed, was set aside, was kept as it is or was stopped ("Stop trying").
 *
 * Offline or listed: "Can't show this photo". Anything else without a thumbhash: "Getting this photo ready".
 */

/** The server's page limit. */
const PAGE = 200;
/**
 * ponytail: 2,000 photos at most; past that the newest failures are known and older ones read as getting ready.
 * A per-photo flag on the timeline answer is the upgrade if a library ever has that many broken files.
 */
const MAX_PAGES = 10;
/** The list is read again at most this often, and only while a tile without a thumbnail asks. */
const REFRESH_MS = 60_000;
/** After a read that failed (a restart, a dropped connection) the next tile to ask may try again this soon. */
const RETRY_MS = 10_000;

class ThumbnailFailures {
  /** Photos whose thumbnail can't be made, as the server last listed them. */
  readonly ids = new SvelteSet<string>();
  #readAt = 0;
  #reading = false;

  /** A tile's thumbnail did not load: read the list unless it was read in the last minute. */
  check(now = Date.now()) {
    // A shared link's visitor may not read the list; their tiles stay "getting ready".
    if (this.#reading || now - this.#readAt < REFRESH_MS || !authManager.authenticated || authManager.isSharedLink) {
      return;
    }
    this.#reading = true;
    void this.#read()
      .catch(() => false)
      .then((read) => {
        this.#reading = false;
        this.#readAt = Date.now() - (read ? 0 : REFRESH_MS - RETRY_MS);
      });
  }

  /** Whether the list was read. */
  async #read() {
    const found = new Set<string>();
    try {
      for (let page = 0; page < MAX_PAGES; page++) {
        const rows = await getProcessingFailures({
          step: ProcessingFailureStep.AssetGenerateThumbnails,
          includeDismissed: true,
          take: PAGE,
          skip: page * PAGE,
        });
        for (const row of rows) {
          found.add(row.assetId);
        }
        if (rows.length < PAGE) {
          break;
        }
      }
    } catch {
      // A restart or a dropped connection: keep the last answer, and ask again soon.
      return false;
    }
    for (const id of this.ids) {
      if (!found.has(id)) {
        this.ids.delete(id);
      }
    }
    for (const id of found) {
      this.ids.add(id);
    }
    return true;
  }
}

export const thumbnailFailures = new ThumbnailFailures();

/** The photo's thumbnail will not come by itself: its file is missing, or making it failed or was stopped. */
export const cantShowPhoto = (asset: { id: string; isOffline?: boolean }) =>
  !!asset.isOffline || thumbnailFailures.ids.has(asset.id);

/** Still waiting for its thumbnail: no picture yet, and nothing says it can't be made. */
export const isGettingReady = (asset: { id: string; thumbhash: string | null; isOffline?: boolean }) =>
  !asset.thumbhash && !cantShowPhoto(asset);
