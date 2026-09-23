<script lang="ts">
  /**
   * Frameleaf redesign of the design template's restore confirmation dialog
   * (`RestoreDialog` in design/frameleaf/template/src/Maintenance.jsx): the primary action
   * stays disabled until the administrator types RESTORE, because this is a destructive
   * recovery surface (FL-81 risk note) that wipes the current database. Confirming calls
   * the real `restoreDatabaseBackup`, which hits the same `setMaintenanceMode` endpoint the
   * legacy shell's one-click confirm dialog already uses.
   */
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import { restoreDatabaseBackup } from '$lib/services/database-backups.service';
  import { t } from 'svelte-i18n';

  type Props = {
    filename: string;
    open: boolean;
    onClose: () => void;
  };

  let { filename, open = $bindable(false), onClose }: Props = $props();

  let confirmText = $state('');
  let restoring = $state(false);

  const CONFIRM_WORD = 'RESTORE';

  $effect(() => {
    if (open) {
      return;
    }

    confirmText = '';
    restoring = false;
  });

  const confirm = async () => {
    if (confirmText !== CONFIRM_WORD || restoring) {
      return;
    }
    restoring = true;
    try {
      await restoreDatabaseBackup(filename);
    } finally {
      restoring = false;
      onClose();
    }
  };
</script>

<Dialog title={$t('admin.frameleaf_maintenance_restore_confirm_title')} closeLabel={$t('close')} bind:open>
  <div class="body">
    <p>{$t('admin.maintenance_restore_backup_description')}</p>
    <p class="filename"><code>{filename}</code></p>
    <label class="confirm-field" for="frameleaf-maintenance-restore-confirm">
      {$t('admin.frameleaf_maintenance_restore_confirm_type_label')}
      <input
        id="frameleaf-maintenance-restore-confirm"
        type="text"
        autocomplete="off"
        spellcheck="false"
        value={confirmText}
        oninput={(event) => (confirmText = (event.currentTarget as HTMLInputElement).value.toUpperCase())}
      />
    </label>
    <div class="actions">
      <Button onclick={onClose} disabled={restoring}>{$t('cancel')}</Button>
      <Button variant="primary" disabled={confirmText !== CONFIRM_WORD || restoring} onclick={confirm}>
        {$t('admin.frameleaf_maintenance_restore_confirm_action')}
      </Button>
    </div>
  </div>
</Dialog>

<style>
  .body p {
    margin: 0 0 0.75rem;
    color: var(--fl-text);
  }
  .filename code {
    font-size: var(--fl-font-small);
    word-break: break-all;
  }
  .confirm-field {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
    font-size: var(--fl-font-small);
    color: var(--fl-muted);
    margin: 0.75rem 0 1rem;
  }
  .confirm-field input {
    padding: 0.4375rem 0.6875rem;
    color: var(--fl-text);
    background: var(--fl-canvas);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
    font-family: inherit;
    font-size: var(--fl-font-size);
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
  }
</style>
