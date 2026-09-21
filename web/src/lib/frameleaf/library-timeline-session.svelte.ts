import { TimelineManager } from '$lib/managers/timeline-manager/timeline-manager.svelte';
import { libraryTimelineOptions, type LibraryTimelineQuery } from './library-session';

/** Route-owned, bounded paged data. The route destroys this owner; presentations only borrow it. */
export class LibraryTimelineSession {
  readonly timeline = new TimelineManager();
  constructor(private readQuery: () => LibraryTimelineQuery) {}

  get query() {
    return this.readQuery();
  }

  get options() {
    return libraryTimelineOptions(this.query);
  }

  destroy() {
    this.timeline.destroy();
  }
}
