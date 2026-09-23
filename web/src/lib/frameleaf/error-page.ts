/**
 * What an error page says, in words a person can act on (FL-55).
 *
 * Customers never see a server's message, an HTTP explanation or a stack trace: those are for the
 * logs. A page that fails says, plainly, which of three things happened — the thing is not there,
 * it is not yours to see, or something went wrong on our side — and offers a way on. The status
 * code is still shown, small, so a person reporting a problem can quote it.
 */

export type ErrorKind = 'not-found' | 'forbidden' | 'server';

export type ErrorPageAction = {
  label: string;
  /** A link. Exactly one of `href` and `onclick` is expected. */
  href?: string;
  onclick?: () => void;
  /** The one action the page leads with. */
  primary?: boolean;
};

const toStatus = (value: unknown): number | undefined => {
  const status = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return typeof status === 'number' && Number.isSafeInteger(status) && status >= 400 && status <= 599
    ? status
    : undefined;
};

/**
 * The status to explain.
 *
 * An API failure that reaches SvelteKit unhandled is reported with page status 500 even when the
 * server said 400 or 404; the client error hook records the server's own status as the error's
 * `code`, so that wins. A plain API error object (the root layout's start-up failure) carries it as
 * `status`. Anything without a usable status is a failure on our side.
 */
export const errorStatus = (status: number | undefined | null, error?: unknown): number => {
  const detail = error && typeof error === 'object' ? (error as { code?: unknown; status?: unknown }) : undefined;
  return toStatus(detail?.code) ?? toStatus(detail?.status) ?? toStatus(status) ?? 500;
};

/**
 * Which of the three explanations a status gets.
 *
 * The server answers "not found or no access" with 400 for an id the caller cannot read, so 400 is
 * explained as not found: saying "forbidden" there would confirm that something exists.
 */
export const errorKind = (status: number): ErrorKind => {
  if ([400, 404, 410].includes(status)) {
    return 'not-found';
  }
  if (status === 401 || status === 403) {
    return 'forbidden';
  }
  return 'server';
};

/** The translation keys for each explanation. Literal, so the formatter checks they exist. */
export const ERROR_COPY = {
  'not-found': { title: 'frameleaf_error_not_found_title', body: 'frameleaf_error_not_found_body' },
  forbidden: { title: 'frameleaf_error_forbidden_title', body: 'frameleaf_error_forbidden_body' },
  server: { title: 'frameleaf_error_server_title', body: 'frameleaf_error_server_body' },
} as const satisfies Record<ErrorKind, { title: string; body: string }>;

/**
 * Whether a shared space request failed because the space is not one this person may open: it does
 * not exist, it is not a space, or they are not (or no longer) a member. The server says 400 for an
 * id the caller has no access to, 403 when a rule refuses them and 404 when there is nothing there.
 */
export const isSpaceUnavailableStatus = (status: number | undefined | null): boolean =>
  typeof status === 'number' && [400, 403, 404, 410].includes(status);

/** What a shared space's error page explains: that the space cannot be opened, or that loading it failed. */
export const spaceErrorKind = (status: number): 'unavailable' | 'failed' =>
  isSpaceUnavailableStatus(status) ? 'unavailable' : 'failed';
