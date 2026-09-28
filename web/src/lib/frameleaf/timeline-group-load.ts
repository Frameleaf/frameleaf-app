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
 * Select or clear a whole group. Clearing needs no loading: ids of months that were never loaded
 * cannot be in the selection. Selecting loads the missing months first and selects only when every
 * month loaded and the session is still on the revision the click was made in.
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
    /** The group's ids, read once its months are loaded. */
    idsOf: () => string[];
    /** Whether no newer group click superseded this one. */
    isLatest?: () => boolean;
  },
): Promise<GroupLoadOutcome> => {
  if (!checked) {
    session.selectGroup(idsOf(), false);
    return 'done';
  }
  const revision = session.revision;
  const outcome = await loadMonthsInOrder(months, {
    ...options,
    isCurrent: () => session.revision === revision && isLatest(),
  });
  if (outcome === 'done') {
    session.selectGroup(idsOf(), true);
  }
  return outcome;
};
