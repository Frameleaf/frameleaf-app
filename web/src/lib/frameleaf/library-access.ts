import { eventManager } from '$lib/managers/event-manager.svelte';

export type LibraryAccessChange = 'restricted' | 'expanded' | 'account' | 'revoked';

/** All library consumers use the same access boundary; a routine profile refresh is not an account switch. */
export const onLibraryAccessChange = (listener: (change: LibraryAccessChange) => void, owner?: string) => {
  return eventManager.on({
    SessionLocked: () => listener('restricted'),
    SessionAccessChanged: ({ isElevated }) => listener(isElevated ? 'expanded' : 'restricted'),
    UserPinCodeReset: () => listener('restricted'),
    AuthLogout: () => {
      owner = undefined;
      listener('revoked');
    },
    SessionDelete: () => listener('revoked'),
    AuthUserLoaded: ({ id }) => {
      if (owner === id) {
        return;
      }
      owner = id;
      listener('account');
    },
  });
};
