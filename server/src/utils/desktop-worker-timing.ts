/** How long one desktop lease lasts; each heartbeat extends it by this much. */
export const DESKTOP_LEASE_SECONDS = 120;
/**
 * A desktop counts as online for this long after its last request. It is the lease plus a margin, so a
 * desktop that holds a valid lease is never treated as gone before that lease ends.
 */
export const DESKTOP_PRESENCE_SECONDS = DESKTOP_LEASE_SECONDS + 30;
/** Failures in a row, for one model, after which a desktop loses that model and must qualify again. */
export const DESKTOP_FAILURES_BEFORE_WITHDRAWAL = 3;
/** How long a desktop that lost a model waits before it can qualify for it again. */
export const DESKTOP_REQUALIFY_HOLD_SECONDS = 300;
