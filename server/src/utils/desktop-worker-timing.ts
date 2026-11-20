/** How long one desktop lease lasts; each heartbeat extends it by this much. */
export const DESKTOP_LEASE_SECONDS = 120;
/**
 * A desktop counts as online for this long after its last request. It is the lease plus a margin, so a
 * desktop that holds a valid lease is never treated as gone before that lease ends.
 */
export const DESKTOP_PRESENCE_SECONDS = DESKTOP_LEASE_SECONDS + 30;
/** Failures in a row, for one model, after which a desktop loses that model and must qualify again. */
export const DESKTOP_FAILURES_BEFORE_WITHDRAWAL = 3;
/**
 * Tasks handed back (`cancelled`) for one model from one desktop: this many hand-backs within the window are
 * a person pausing and stopping. Each one after that counts as a failure, so a desktop that only ever hands
 * work back loses the model like one that fails it. Tasks handed back together (a stop with several in hand)
 * are one hand-back.
 */
export const DESKTOP_CANCELS_BEFORE_FAILURE = 5;
export const DESKTOP_CANCEL_WINDOW_SECONDS = 600;
/** One task may be handed back this many times; a hand-back after that is a failed attempt of the task. */
export const DESKTOP_CANCELS_PER_TASK = 5;
/** How long a desktop that lost a model waits before it can qualify for it again. */
export const DESKTOP_REQUALIFY_HOLD_SECONDS = 300;
