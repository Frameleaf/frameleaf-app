/**
 * Loading the months a timeline group checkbox reaches before selecting the group.
 *
 * The prototype (`TimelineLibrary.jsx` group header, `App.jsx` selectGroupIds) holds the whole
 * library in memory, so a year or "All" checkbox selects every item at once. Production loads the
 * library a month bucket at a time, so the months the group covers that are not loaded yet are
 * loaded first. They are loaded one at a time, as `LibraryView` `selectAllLoaded` does, so a large
 * library never has hundreds of bucket requests in flight; each load stays cancellable by the
 * manager. Whatever the loads return is dropped when the view moved on meanwhile (another scope,
 * query or sort, or a newer group click), so a slow load can never put another view's ids into the
 * current selection.
 */

export type GroupLoadOutcome = 'done' | 'stale' | 'incomplete';

export type GroupLoadOptions<M> = {
  isLoaded: (month: M) => boolean;
  /** Load one month. A rejection counts as a load that did not finish. */
  load: (month: M) => Promise<unknown>;
  /** Whether the request is still the one to act on. */
  isCurrent: () => boolean;
  /** Tries per month; a load the manager cancels (it scrolled out of reach) is tried again. */
  attempts?: number;
};

/** Load `months` in order, one at a time; stop as soon as the request is no longer current. */
export const loadMonthsInOrder = async <M>(
  months: readonly M[],
  { isLoaded, load, isCurrent, attempts = 2 }: GroupLoadOptions<M>,
): Promise<GroupLoadOutcome> => {
  for (const month of months) {
    for (let attempt = 0; attempt < attempts && !isLoaded(month); attempt++) {
      if (!isCurrent()) {
        return 'stale';
      }
      try {
        await load(month);
      } catch {
        // Counted below: the month is still not loaded.
      }
    }
    if (!isCurrent()) {
      return 'stale';
    }
    if (!isLoaded(month)) {
      return 'incomplete';
    }
  }
  return isCurrent() ? 'done' : 'stale';
};

type GroupSession = {
  readonly revision: number;
  selectGroup: (ids: string[], checked: boolean) => unknown;
};

/**
 * Collect ids one page at a time before its assets can be evicted. Clearing also reads missing
 * pages: previously selected ids can outlive their loaded assets.
 */
export const selectGroupAfterLoading = async <M>(
  session: GroupSession,
  {
    months,
    checked,
    idsOf,
    isLatest = () => true,
    ...options
  }: Omit<GroupLoadOptions<M>, 'isCurrent'> & {
    months: readonly M[];
    checked: boolean;
    /** One page's ids, read immediately after that page loads. */
    idsOf: (month: M) => string[];
    /** Whether no newer group click superseded this one. */
    isLatest?: () => boolean;
  },
): Promise<GroupLoadOutcome> => {
  const revision = session.revision;
  const ids = new Set<string>();
  for (const month of months) {
    const outcome = await loadMonthsInOrder([month], {
      ...options,
      isCurrent: () => session.revision === revision && isLatest(),
    });
    if (outcome !== 'done') {
      return outcome;
    }
    for (const id of idsOf(month)) {
      ids.add(id);
    }
  }
  if (session.revision !== revision || !isLatest()) {
    return 'stale';
  }
  session.selectGroup([...ids], checked);
  return 'done';
};
