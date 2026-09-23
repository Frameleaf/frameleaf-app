import {
  activeFilterCount,
  activeFilterSections,
  discoveryChipFields,
  discoveryPageSummary,
  discoveryPaging,
  fieldsInFilterSection,
  filterSectionForField,
  isDiscoveryFilterActive,
  withoutDiscoveryFilter,
  withoutDiscoveryFilters,
  type DiscoveryDestination,
  type DiscoveryFilterSection,
  type DiscoveryQuery,
} from '$lib/components/discovery/query';
import {
  createLibrarySession,
  fromStoredLibrarySession,
  libraryPreferenceKey,
  parseLibraryView,
  reduceLibrarySession,
  toStoredLibrarySession,
  writeLibraryView,
  type LibraryLayout,
  type LibrarySession,
  type LibrarySessionAction,
  type LibraryViewProblem,
  type LibraryViewState,
} from '$lib/frameleaf/library-session';

/**
 * The live library session: one reactive holder around the pure reducer FL-31 landed, so Timeline,
 * Browse and Work are three presentations of the same state rather than three pages that each
 * rebuild it (FL-33).
 *
 * Everything that decides what is on the page — scope, query, sort, grouping, view, filter section
 * and the cumulative page count — lives here. A layout switch only writes `layout`, so the query,
 * the selection, the open asset, the playhead and the scroll anchor all survive it by construction.
 *
 * The store never fetches. Callers hand it results and it answers with the revision those results
 * must still match; a response from a superseded query is dropped rather than applied.
 */
export type LibrarySessionStoreOptions = {
  /** The authenticated user's id. Stored state is keyed by it; sessions are never shared. */
  userId?: string;
  /** Items per page for the cumulative Show more summary. */
  pageSize?: number;
  /** Where the results are already shown, so chips never restate the destination. */
  destination?: DiscoveryDestination;
  /** Storage; injected in tests, and absent during server rendering. */
  storage?: Pick<Storage, 'getItem' | 'setItem'> | null;
};

const safeStorage = (storage?: Pick<Storage, 'getItem' | 'setItem'> | null) => {
  if (storage !== undefined) {
    return storage;
  }
  try {
    return globalThis.localStorage ?? null;
  } catch {
    // Private windows and blocked site data throw on access rather than returning null.
    return null;
  }
};

export class LibrarySessionStore {
  /**
   * Raw, not deeply proxied: the reducer never mutates a session in place, it returns a new one, so
   * reassignment is the only change to track. A deep `$state` proxy would also reach the pure
   * helpers, whose `structuredClone` cannot clone a proxy (persisting and removing a filter threw).
   */
  #session: LibrarySession = $state.raw(createLibrarySession());
  #pageSize: number | undefined;
  #destination: DiscoveryDestination | undefined = $state();
  #userId: string | undefined;
  #storage: Pick<Storage, 'getItem' | 'setItem'> | null;
  /** Total matches for the current revision, or null while the server has not counted. */
  #total: number | null = $state(null);
  #totalRevision = -1;
  /** FL-48: why the URL's view state was refused on restore, or null when it was not. */
  #refusedView: LibraryViewProblem | null = $state(null);
  /** The state the page fell back to after a refusal; the link is kept until it changes. */
  #refusedAt: string | null = null;

  constructor(options: LibrarySessionStoreOptions = {}) {
    this.#pageSize = options.pageSize && options.pageSize > 0 ? options.pageSize : undefined;
    this.#destination = options.destination;
    this.#userId = options.userId;
    this.#storage = safeStorage(options.storage);
  }

  get session() {
    return this.#session;
  }

  get layout(): LibraryLayout {
    return this.#session.layout;
  }

  get state(): LibraryViewState {
    return this.#session.state;
  }

  get query(): DiscoveryQuery {
    return this.#session.state.query;
  }

  get selection(): string[] {
    return this.#session.selection;
  }

  get openAssetId(): string | undefined {
    return this.#session.openAssetId;
  }

  get playbackPosition(): number {
    return this.#session.playbackPosition;
  }

  get revision(): number {
    return this.#session.revision;
  }

  get destination() {
    return this.#destination;
  }

  set destination(value: DiscoveryDestination | undefined) {
    this.#destination = value;
  }

  /* ---------------------------------------------------------------------- */
  /* Restore and persist                                                     */
  /* ---------------------------------------------------------------------- */

  /**
   * Restore the session. Portable state from the URL wins over what was stored, so a shared link
   * opens what it describes; layout is device-local and comes from storage alone. Selection is
   * never restored.
   */
  restore(url?: URL, userId = this.#userId) {
    this.#userId = userId;
    const parsed = url ? parseLibraryView(url) : null;
    const incoming = parsed?.ok ? parsed.state : null;
    let stored: string | null = null;
    if (userId) {
      try {
        stored = this.#storage?.getItem(libraryPreferenceKey(userId)) ?? null;
      } catch {
        stored = null;
      }
    }
    this.#session = fromStoredLibrarySession(stored, incoming);
    this.#total = null;
    this.#totalRevision = -1;
    this.#refusedView = parsed && !parsed.ok ? parsed.problem : null;
    this.#refusedAt = this.#refusedView ? JSON.stringify(this.#session.state) : null;
    return this.#session;
  }

  /**
   * Why the link's view state could not be opened (FL-48): a newer format, or a damaged value. The
   * page opened on the stored view instead, and says so.
   */
  get refusedView(): LibraryViewProblem | null {
    return this.#refusedView;
  }

  /** Write the device-local part of the session back to storage. Selection is deliberately absent. */
  persist(userId = this.#userId) {
    if (!userId || !this.#storage) {
      return false;
    }
    try {
      this.#storage.setItem(libraryPreferenceKey(userId), JSON.stringify(toStoredLibrarySession(this.#session)));
      return true;
    } catch {
      // A full or blocked store must not break the page; the session keeps working in memory.
      return false;
    }
  }

  /** The URL carrying this session's portable view state. Layout and selection never travel. */
  viewUrl(url: URL): URL {
    // FL-48: a refused link stays in the address bar until the person changes the view, so a reload
    // or a copied link never silently turns into a narrower one this version could read.
    if (this.#refusedAt !== null) {
      if (JSON.stringify(this.#session.state) === this.#refusedAt) {
        return new URL(url);
      }
      this.#refusedAt = null;
    }
    return writeLibraryView(url, this.#session.state);
  }

  /* ---------------------------------------------------------------------- */
  /* Dispatch                                                                */
  /* ---------------------------------------------------------------------- */

  dispatch(action: LibrarySessionAction) {
    // Callers may hand over their own `$state` (a query being edited, a list of ids); the session
    // keeps a plain copy so nothing reactive from a component is shared with it.
    const next = reduceLibrarySession(this.#session, $state.snapshot(action) as LibrarySessionAction);
    if (next === this.#session) {
      return this.#session;
    }
    const revisionChanged = next.revision !== this.#session.revision;
    this.#session = next;
    if (revisionChanged) {
      // The result set changed: the old count no longer describes the page.
      this.#total = null;
      this.#totalRevision = -1;
    }
    return next;
  }

  /** Switch layout. Nothing else in the session is touched — that is the point of this story. */
  setLayout(layout: LibraryLayout) {
    return this.dispatch({ type: 'layout', layout });
  }

  setQuery(query: DiscoveryQuery) {
    return this.dispatch({ type: 'view', patch: { query } });
  }

  patchView(patch: Partial<Omit<LibraryViewState, 'version'>>) {
    return this.dispatch({ type: 'view', patch });
  }

  setScope(scope: LibraryViewState['scope']) {
    return this.dispatch({ type: 'scope', scope });
  }

  /* ---------------------------------------------------------------------- */
  /* Results                                                                 */
  /* ---------------------------------------------------------------------- */

  /**
   * Record the server's match count for a request issued at `revision`. A stale response — one
   * issued before the query changed — is dropped rather than applied.
   */
  applyTotal(total: number | null, revision: number) {
    if (revision !== this.#session.revision) {
      return false;
    }
    this.#total = Number.isSafeInteger(total) && (total as number) >= 0 ? total : null;
    this.#totalRevision = revision;
    return true;
  }

  /** True when a response issued at `revision` still describes the current result set. */
  isCurrent(revision: number) {
    return this.#session.revision === revision;
  }

  get total(): number | null {
    return this.#totalRevision === this.#session.revision ? this.#total : null;
  }

  get paging() {
    return discoveryPaging(this.#session.page, this.total, this.#pageSize);
  }

  /** The cumulative "Showing n of m" summary under the results. */
  get pageSummary() {
    return discoveryPageSummary(this.paging);
  }

  showMore() {
    return this.dispatch({ type: 'show-more' });
  }

  /**
   * Drop assets that are gone — trashed, deleted, or no longer accessible. Page state survives;
   * only references to the missing assets are cleared, including an open asset that was revoked.
   */
  mutated(removedIds: string[]) {
    return this.dispatch({ type: 'mutated', removedIds });
  }

  /* ---------------------------------------------------------------------- */
  /* The single Filter control                                               */
  /* ---------------------------------------------------------------------- */

  get filterCount() {
    return activeFilterCount(this.query);
  }

  get filterActive() {
    return isDiscoveryFilterActive(this.query);
  }

  get filterSections() {
    return activeFilterSections(this.query);
  }

  get filterSection() {
    return this.#session.filterSection;
  }

  /** The removable chips. Chips exist only while a filter is active and never restate the page. */
  get chipFields() {
    return discoveryChipFields(this.query, this.#destination);
  }

  fieldsInSection(section: DiscoveryFilterSection) {
    return fieldsInFilterSection(this.query, section);
  }

  sectionForField(field: string) {
    return filterSectionForField(field);
  }

  /** Open the filter panel at a section. `null` closes the deep link. */
  openFilterSection(section: DiscoveryFilterSection | null) {
    return this.dispatch({ type: 'filter-section', section });
  }

  removeFilter(field: string) {
    return this.setQuery(withoutDiscoveryFilter(this.query, field));
  }

  clearFilters() {
    return this.setQuery(withoutDiscoveryFilters(this.query));
  }

  /* ---------------------------------------------------------------------- */
  /* Selection                                                               */
  /* ---------------------------------------------------------------------- */

  isSelected(id: string) {
    return this.#session.selection.includes(id);
  }

  select(id: string, options: { additive?: boolean; range?: boolean; orderedIds?: string[] } = {}) {
    if (options.range) {
      return this.dispatch({ type: 'select-range', orderedIds: options.orderedIds ?? [], id });
    }
    return this.dispatch({ type: 'select', id, additive: options.additive });
  }

  selectGroup(ids: string[], checked: boolean) {
    return this.dispatch({ type: 'select-group', ids, checked });
  }

  selectAll(orderedIds: string[]) {
    return this.dispatch({ type: 'select-all', orderedIds });
  }

  clearSelection() {
    return this.dispatch({ type: 'clear-selection' });
  }

  /* ---------------------------------------------------------------------- */
  /* Open item and playback                                                  */
  /* ---------------------------------------------------------------------- */

  /** Open an asset in the viewer. Opening is not selecting; the multi-select state is untouched. */
  open(id: string, time?: number) {
    return this.dispatch({ type: 'open', id, time });
  }

  close() {
    return this.dispatch({ type: 'close' });
  }

  /**
   * Restore the playhead, clamped into the media's own length. A stored position from a longer
   * asset, a NaN, or a negative value all land at the start.
   */
  restorePlayback(durationInSeconds?: number | null) {
    const stored = this.#session.playbackPosition;
    const duration = Number(durationInSeconds);
    const limit = Number.isFinite(duration) && duration > 0 ? duration : Infinity;
    const clamped = Number.isFinite(stored) ? Math.min(Math.max(0, stored), limit) : 0;
    if (clamped !== stored) {
      this.dispatch({ type: 'playback', time: clamped });
    }
    return clamped;
  }

  setPlayback(time: number) {
    return this.dispatch({ type: 'playback', time });
  }

  setScrollAnchor(id: string) {
    return this.dispatch({ type: 'anchor', id });
  }
}

/** The process-wide library session. Views bind to this instance rather than creating their own. */
export const librarySession = new LibrarySessionStore();
