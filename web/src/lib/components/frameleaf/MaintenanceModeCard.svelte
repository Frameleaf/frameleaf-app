<script lang="ts">
  /**
   * Frameleaf redesign of the "Maintenance mode" section of the design template's
   * `Maintenance.jsx` (design/frameleaf/template/src/Maintenance.jsx), wired to the real
   * `setMaintenanceMode` endpoint via `handleSetMaintenanceMode` instead of the template's
   * timer-simulated `startMaintenance`/`endMaintenance` reducers.
   *
   * This page can only be reached while maintenance mode is off (a live server in
   * maintenance mode serves only `/maintenance` and the admin bypass to non-maintenance
   * routes does not exist yet), so unlike the template there is no "on" state to render
   * here — starting maintenance mode restarts the app process and every browser gets
   * redirected to the `/maintenance` splash by the websocket status event. The action is
   * still gated behind an explicit confirmation dialog: it signs every other session out
   * and pauses uploads and mobile backups immediately.
   */
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import Pane from '$lib/components/frameleaf/Pane.svelte';
  import { handleSetMaintenanceMode } from '$lib/services/maintenance.service';
  import { MaintenanceAction } from '@immich/sdk';
  import { Icon } from '@immich/ui';
  import { mdiWrenchOutline } from '@mdi/js';
  import { t } from 'svelte-i18n';

  let confirmOpen = $state(false);
  let starting = $state(false);

  const start = async () => {
    starting = true;
    try {
      await handleSetMaintenanceMode({ action: MaintenanceAction.Start });
    } finally {
      starting = false;
      confirmOpen = false;
    }
  };
</script>

<Pane label={$t('admin.frameleaf_maintenance_mode_card_label')}>
  <div class="mode-card">
    <div class="mode-copy">
      <h2>{$t('admin.maintenance_settings')}</h2>
      <p>{$t('admin.maintenance_settings_description')}</p>
    </div>
    <Button variant="primary" onclick={() => (confirmOpen = true)}>
      <Icon icon={mdiWrenchOutline} size="1em" aria-hidden={true} />
      {$t('admin.maintenance_start')}
    </Button>
  </div>
</Pane>

<Dialog title={$t('admin.frameleaf_maintenance_start_confirm_title')} closeLabel={$t('close')} bind:open={confirmOpen}>
  <div class="dialog-body">
    <p>{$t('admin.frameleaf_maintenance_start_confirm_body')}</p>
    <div class="actions">
      <Button onclick={() => (confirmOpen = false)} disabled={starting}>{$t('cancel')}</Button>
      <Button variant="primary" onclick={start} disabled={starting}>
        {$t('admin.frameleaf_maintenance_start_confirm_action')}
      </Button>
    </div>
  </div>
</Dialog>

<style>
  .mode-card {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    flex-wrap: wrap;
  }
  .mode-copy h2 {
    font-size: var(--fl-font-size);
    margin: 0 0 0.25rem;
  }
  .mode-copy p {
    margin: 0;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
    max-width: 40rem;
  }
  .dialog-body p {
    margin: 0 0 1rem;
    color: var(--fl-text);
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
  }
</style>
