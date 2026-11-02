<script lang="ts">
  /**
   * FL-708 (UI review item 1): "Restore from a backup" on setup's one welcome. It used to sit on a
   * separate "Welcome · Getting Started" page in front of setup; it restarts the server in
   * maintenance mode, where a database backup is chosen and restored.
   */
  import { websocketStore } from '$lib/stores/websocket';
  import { handleError } from '$lib/utils/handle-error';
  import { waitForOnboardingMaintenance } from '$lib/utils/onboarding-maintenance';
  import { startDatabaseRestoreFlow } from '@frameleaf/sdk';
  import { onDestroy } from 'svelte';
  import { t } from 'svelte-i18n';

  let restart = $state<AbortController>();
  onDestroy(() => restart?.abort());

  const switchToMaintenance = async () => {
    if (restart) {
      return;
    }
    const owner = new AbortController();
    restart = owner;
    try {
      await startDatabaseRestoreFlow({ signal: owner.signal });
      owner.signal.throwIfAborted();
      websocketStore.serverRestarting.set({ isMaintenanceMode: true });
      await waitForOnboardingMaintenance(owner.signal);
    } catch (error) {
      if (owner.signal.aborted) {
        return;
      }
      websocketStore.serverRestarting.set(undefined);
      handleError(error, $t('admin.maintenance_start_error'));
    } finally {
      restart = undefined;
    }
  };
</script>

<button
  type="button"
  class="auth-link frs-restore"
  disabled={!!restart}
  aria-busy={restart ? true : undefined}
  onclick={() => void switchToMaintenance()}
>
  {$t('frameleaf_maintenance_restore_from_backup')}
</button>
