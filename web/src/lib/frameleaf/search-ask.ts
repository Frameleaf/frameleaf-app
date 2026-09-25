/** Why an Ask could not answer (FL-31): the server has it turned off, or the request failed. */
export type SearchAskProblem = 'disabled' | 'failed';

/**
 * The i18n keys of the plain-language questions offered under "Try a search", which the server's Ask
 * planner understands (dates, favorites, videos, receipts, screenshots). They only start a search; the
 * answers always come from the library.
 */
export const SEARCH_ASK_EXAMPLES = [
  'frameleaf_search_ask_example_favorites',
  'frameleaf_search_ask_example_summer',
  'frameleaf_search_ask_example_receipts',
  'frameleaf_search_ask_example_screenshots',
] as const;
