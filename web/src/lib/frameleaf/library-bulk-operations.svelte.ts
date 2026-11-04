import type { BulkOperationRecord } from '$lib/frameleaf/library-session';

/**
 * The library session's bulk operations, for the top-bar indicator. The session registers itself
 * here when its module loads, so the indicator reads them without importing the session (and the
 * discovery code it pulls in) on every page. Operations live in memory only, so a page that never
 * loaded the session has none to show.
 */
class LibraryBulkOperations {
  source: { readonly session: { readonly operations: BulkOperationRecord[] } } | null = $state.raw(null);

  get operations(): BulkOperationRecord[] {
    return this.source?.session.operations ?? [];
  }
}

export const libraryBulkOperations = new LibraryBulkOperations();
