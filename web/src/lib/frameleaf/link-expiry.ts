/**
 * FL-922: how long a new shared link lasts by default. A person's own choice wins over the server's;
 * no choice of their own (null) follows the server's, and with neither a link never expires.
 */

/** The choices the two settings offer, in days. */
export const LINK_EXPIRY_DAYS = [1, 7, 30, 90, 365] as const;

/** The value of the "no choice" option in a select. */
export const LINK_EXPIRY_NONE = 'none';

/** The days a select value stands for; null for "no choice". */
export const linkExpiryFromValue = (value: string): number | null =>
  value === LINK_EXPIRY_NONE ? null : Math.trunc(Number(value));

export const linkExpiryValue = (days: number | null | undefined): string =>
  typeof days === 'number' ? String(days) : LINK_EXPIRY_NONE;

/** The offered choices plus a stored value that isn't one of them (set through the API), in order. */
export const linkExpiryChoices = (stored: number | null | undefined): number[] =>
  typeof stored === 'number' && !LINK_EXPIRY_DAYS.includes(stored as (typeof LINK_EXPIRY_DAYS)[number])
    ? [...LINK_EXPIRY_DAYS, stored].sort((a, b) => a - b)
    : [...LINK_EXPIRY_DAYS];

/** What a new link uses: the person's own default, else the server's, else nothing. */
export const effectiveLinkExpiryDays = (own: number | null | undefined, server: number | null | undefined) =>
  own ?? server ?? null;
