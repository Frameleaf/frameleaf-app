import type { ActionItem } from '@frameleaf/ui';
import { mdiLockOutline } from '@mdi/js';
import type { MessageFormatter } from 'svelte-i18n';
import { requestSessionLock } from '$lib/frameleaf/session-lock';

export const getUserActions = ($t: MessageFormatter) => {
  const LockSession: ActionItem = {
    title: $t('lock'),
    color: 'primary',
    icon: mdiLockOutline,
    onAction: () => handleLockSession(),
  };

  return { LockSession };
};

// FL-83: every lock is the one local lock operation: it waits for pending PIN unlocks, keeps the root
// shield up (with Retry, across reloads) until the server confirms, and closes private dialogs first.
const handleLockSession = () => requestSessionLock();
