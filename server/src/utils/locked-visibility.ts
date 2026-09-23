import type { AuthDto } from 'src/dtos/auth.dto.js';

/**
 * Repository option for album reads: the one owner whose Locked media the read may include.
 * Left out, an album read shows Timeline and Archive media only.
 */
export type LockedVisibilityOptions = {
  lockedOwnerId?: string;
};

/**
 * Owner decision, September 22, 2026: Locked media may be a member of any album and keeps its Locked
 * visibility there. An album read shows a Locked item to exactly one viewer — the item's owner, in an
 * elevated (PIN-unlocked) session. Every other read hides it: the owner's ordinary sessions, other
 * album members whatever their own elevation, partners, shared spaces and shared links.
 *
 * A shared link is never elevated, so a shared-link visitor gets no owner here even when the link's
 * creator has an unlocked session open somewhere else.
 */
export const getLockedOwnerId = (auth: AuthDto): string | undefined => {
  if (auth.sharedLink) {
    return undefined;
  }

  return auth.session?.hasElevatedPermission ? auth.user.id : undefined;
};

export const getLockedVisibilityOptions = (auth: AuthDto): LockedVisibilityOptions => {
  const lockedOwnerId = getLockedOwnerId(auth);
  return lockedOwnerId ? { lockedOwnerId } : {};
};
