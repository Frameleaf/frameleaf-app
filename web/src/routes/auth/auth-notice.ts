/**
 * A one-time note carried from one sign-in screen to the next: after a forced password change the
 * session ends, and the sign-in page says why and fills the email in. Kept in memory only (never in
 * the address or in browser storage, which signing out clears), so it lasts for one in-app hand-over.
 */
export type AuthNotice = { kind: 'password-changed'; email: string };

let pending: AuthNotice | null = null;

export const setAuthNotice = (notice: AuthNotice) => {
  pending = notice;
};

/** Returns the pending note once; later calls get nothing. */
export const takeAuthNotice = (): AuthNotice | null => {
  const notice = pending;
  pending = null;
  return notice;
};
