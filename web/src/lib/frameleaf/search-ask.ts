/** Why an Ask could not answer (FL-31): the server has it turned off, or the request failed. */
export type SearchAskProblem = 'disabled' | 'failed';

/**
 * Plain-language questions the server's Ask planner understands (dates, favorites, videos, receipts,
 * screenshots). They only start a search; the answers always come from the library.
 */
export const SEARCH_ASK_EXAMPLES = [
  'favorite videos since 2020',
  'photos from last summer',
  'receipts from last year',
  'screenshots from last month',
] as const;
