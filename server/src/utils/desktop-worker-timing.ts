/** How long one desktop lease lasts; each heartbeat extends it by this much. */
export const DESKTOP_LEASE_SECONDS = 120;
/**
 * A desktop counts as online for this long after its last request. It is the lease plus a margin, so a
 * desktop that holds a valid lease is never treated as gone before that lease ends.
 */
export const DESKTOP_PRESENCE_SECONDS = DESKTOP_LEASE_SECONDS + 30;
