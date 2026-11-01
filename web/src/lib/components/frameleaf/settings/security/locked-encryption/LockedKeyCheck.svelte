<script lang="ts">
  /**
   * FL-721 (spec §7.6): opening Locked after a restart, or after the ask-again time, while the key
   * isn't open asks for the passphrase at once (prototype `AfterRestart`), instead of showing photos
   * that can't load. Turning off that waits for the key asks for it too (spec §4.3). Once it is typed
   * the page loads again, so its photos come in.
   */
  import { promptForOwnLockedKey } from '$lib/frameleaf/locked-key-prompt';
  import { getLockedEncryption, LockedEncryptionMode, LockedEncryptionState } from '@frameleaf/sdk';
  import { onMount } from 'svelte';

  let { onUnlocked = () => location.reload() }: { onUnlocked?: () => void } = $props();

  onMount(async () => {
    try {
      const status = await getLockedEncryption();
      const waiting =
        status.enabled &&
        !status.keyLoaded &&
        (status.mode === LockedEncryptionMode.Advanced || status.status === LockedEncryptionState.Decrypting);
      if (waiting && (await promptForOwnLockedKey())) {
        onUnlocked();
      }
    } catch {
      // the photos say for themselves that they can't load; nothing to add here
    }
  });
</script>
