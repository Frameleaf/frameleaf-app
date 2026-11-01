/**
 * FL-721 (spec §7.6, §8): a Locked view or action the server refused with 423
 * `locked_key_unavailable` asks for what opens the key, in place: the passphrase (Advanced Security,
 * after a restart or the ask-again time) or the PIN. A partner's item waiting on its owner ("not
 * ready") is said, not asked. One prompt at a time: refusals that arrive together share it.
 */
import { getLockedEncryption, LockedEncryptionMode, LockedEncryptionState } from '@frameleaf/sdk';
import { modalManager, toastManager } from '@frameleaf/ui';
import { t } from 'svelte-i18n';
import { get } from 'svelte/store';
import { lockedKeyNeedOf, type LockedKeyNeed } from '$lib/frameleaf/locked-encryption';

let open: Promise<boolean> | undefined;

/** Opens the passphrase (or PIN) prompt for the person's own key; resolves whether it opened. */
export const promptForOwnLockedKey = (): Promise<boolean> => {
  open ??= (async () => {
    try {
      const status = await getLockedEncryption();
      if (!status.enabled || status.keyLoaded) {
        return status.keyLoaded;
      }
      const { default: PassphraseModal } =
        await import('$lib/components/frameleaf/settings/security/locked-encryption/PassphraseModal.svelte');
      const unlocked = await modalManager.show(PassphraseModal, {
        kind: 'own',
        mode: status.mode ?? LockedEncryptionMode.Advanced,
        finishing: status.status === LockedEncryptionState.Decrypting,
        askAgainHours: status.askAgainHours,
      });
      return !!unlocked;
    } catch {
      return false;
    } finally {
      open = undefined;
    }
  })();
  return open;
};

/** What to do about a refused Locked read: prompt for the person's own key, or say a partner's isn't ready. */
export const answerLockedKeyNeed = (need: LockedKeyNeed) => {
  const $t = get(t);
  if (need.reason === 'not-ready') {
    toastManager.info($t('frameleaf_le_partner_not_ready_toast'));
    return;
  }
  if (need.reason === 'owner-passphrase') {
    // Only the item itself knows whose passphrase it needs; its viewer asks for it.
    toastManager.info($t('frameleaf_le_partner_open_item_toast'));
    return;
  }
  void promptForOwnLockedKey();
};

/** For `handleError`: whether this error was the Locked key's 423, now answered. */
export const handledLockedKeyError = (error: unknown) => {
  const need = lockedKeyNeedOf(error);
  if (!need) {
    return false;
  }
  answerLockedKeyNeed(need);
  return true;
};
