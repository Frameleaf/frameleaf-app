/**
 * FL-721 (spec §7.6, §8): a Locked view or action the server refused with 423
 * `locked_key_unavailable` asks for what opens the key, in place: the passphrase (Advanced Security,
 * after a restart or the ask-again time) or the PIN. A partner's item waiting on its owner ("not
 * ready") is said, not asked. One prompt at a time: refusals that arrive together share it.
 *
 * A 423 is never silent. The refused action isn't retried (it has too many callers); once the key
 * opens, the person is told to try again. If the prompt is dismissed, can't be shown, or wasn't needed
 * after all, the caller's own error message is shown instead.
 */
import { getLockedEncryption, LockedEncryptionMode, LockedEncryptionState } from '@frameleaf/sdk';
import { modalManager, toastManager } from '@frameleaf/ui';
import { t } from 'svelte-i18n';
import { get } from 'svelte/store';
import { lockedKeyNeedOf, type LockedKeyNeed } from '$lib/frameleaf/locked-encryption';

let open: Promise<boolean> | undefined;

/**
 * Opens the passphrase (or PIN) prompt for the person's own key. Resolves true only when the prompt
 * opened the key; false when it was dismissed, its status couldn't be read, or nothing needed asking.
 */
export const promptForOwnLockedKey = (): Promise<boolean> => {
  open ??= (async () => {
    try {
      const status = await getLockedEncryption();
      if (!status.enabled || status.keyLoaded) {
        return false;
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

/**
 * What to do about a refused Locked read or action. A partner's item that isn't ready, or needs its
 * owner's passphrase (only the item's viewer knows whose), is said. The person's own key is asked
 * for: opened, they are told to try again; otherwise `fallback` shows the caller's own error.
 */
export const answerLockedKeyNeed = async (need: LockedKeyNeed, fallback: () => void): Promise<void> => {
  const $t = get(t);
  if (need.reason === 'not-ready') {
    toastManager.info($t('frameleaf_le_partner_not_ready_toast'));
    return;
  }
  if (need.reason === 'owner-passphrase') {
    toastManager.info($t('frameleaf_le_partner_open_item_toast'));
    return;
  }
  if (await promptForOwnLockedKey()) {
    toastManager.primary($t('frameleaf_le_unlocked_try_again'));
  } else {
    fallback();
  }
};

/**
 * For `handleError` and bulk runs: whether this error was the Locked key's 423. If it was, it is
 * answered (in the background) and `fallback` runs when the key didn't open.
 */
export const handledLockedKeyError = (error: unknown, fallback: () => void = () => {}) => {
  const need = lockedKeyNeedOf(error);
  if (!need) {
    return false;
  }
  void answerLockedKeyNeed(need, fallback);
  return true;
};
