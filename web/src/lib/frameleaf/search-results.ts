/**
 * FL-1393 (UI review 11-10, B4): what the search results page shows above and around the grid.
 * Pure, so the rules are tested without mounting the page.
 */

/**
 * Close matches first, looser ones after: the split of a ranked result list, or null for one
 * undivided grid. There is no split when the server gave no count (a text search), when nothing
 * is a close match, or when everything is.
 */
export const searchSplit = <T>(results: T[], closeMatches: number | null | undefined) =>
  closeMatches && closeMatches > 0 && closeMatches < results.length
    ? { best: results.slice(0, closeMatches), rest: results.slice(closeMatches) }
    : null;
