<script lang="ts">
  /**
   * Restore from backup, step 2 (FL-80): the Frameleaf backup list (FL-81) inside the maintenance
   * page's card, in place of the upstream `@immich/ui` layout and legacy `MaintenanceBackupsList`.
   */
  import MaintenanceBackupList from '$lib/components/frameleaf/MaintenanceBackupList.svelte';
  import { Icon } from '@immich/ui';
  import { mdiArrowLeft } from '@mdi/js';
  import { t } from 'svelte-i18n';

  type Props = {
    previous: () => void;
    end: () => void;
    expectedVersion: string;
  };

  const { previous, end, expectedVersion }: Props = $props();
</script>

<div class="auth-card">
  <div class="auth-heading"><h1>{$t('maintenance_restore_from_backup')}</h1></div>
  <div class="backups">
    <MaintenanceBackupList {expectedVersion} />
  </div>
  <div class="maint-actions">
    <button type="button" class="button" onclick={end}>{$t('cancel')}</button>
    <button type="button" class="button" onclick={previous}>
      <Icon icon={mdiArrowLeft} size="18" aria-hidden={true} />
      {$t('back')}
    </button>
  </div>
</div>

<style>
  .backups {
    max-height: 30rem;
    overflow: auto;
  }
  .button {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
</style>
