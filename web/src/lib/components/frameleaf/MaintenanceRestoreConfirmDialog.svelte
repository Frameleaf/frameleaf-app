<script lang="ts">
  /**
   * Frameleaf redesign of the design template's restore confirmation dialog
   * (`RestoreDialog` in design/frameleaf/template/src/Maintenance.jsx): the primary action
   * stays disabled until the administrator types RESTORE, because this is a destructive
   * recovery surface (FL-81 risk note) that wipes the current database. Confirming calls
   * the real `restoreDatabaseBackup`, which hits the same `setMaintenanceMode` endpoint the
   * legacy shell's one-click confirm dialog already uses.
   *
   * As the template: the backup's summary, what a restore changes, its steps, and "Create a safety
   * backup of the current database first" (off by default). The server always takes that backup,
   * because it rolls back to it if the restore fails; the checkbox decides whether it is kept after
   * a successful restore (`keepSafetyBackup`). A failed restore always keeps it.
   */
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import { restoreDatabaseBackup } from '$lib/services/database-backups.service';
  import { t } from 'svelte-i18n';

  type Props = {
    filename: string;
    /** When the backup was made, already formatted; omitted when the filename carries no date. */
    date?: string;
    size?: string;
    open: boolean;
    onClose: () => void;
  };

  let { filename, date, size, open = $bindable(false), onClose }: Props = $props();

  let confirmText = $state('');
  let restoring = $state(false);
  let backupFirst = $state(false);

  const consequences = [
    'admin.frameleaf_maintenance_restore_consequence_data',
    'admin.frameleaf_maintenance_restore_consequence_later',
    'admin.frameleaf_maintenance_restore_consequence_originals',
    'admin.frameleaf_maintenance_restore_consequence_signed_out',
  ] as const;

  // The template's backup kinds; production only knows a restore's own safety backup by its name.
  const summary = $derived.by(() => {
    if (!date || !size) {
      return null;
    }
    return filename.startsWith('restore-point-')
      ? $t('admin.frameleaf_maintenance_restore_summary', {
          values: { kind: $t('admin.frameleaf_maintenance_restore_kind_pre_restore'), date, size },
        })
      : $t('admin.frameleaf_maintenance_restore_summary_plain', { values: { date, size } });
  });

  const CONFIRM_WORD = 'RESTORE';

  $effect(() => {
    if (open) {
      return;
    }

    confirmText = '';
    restoring = false;
    backupFirst = false;
  });

  const confirm = async () => {
    if (confirmText !== CONFIRM_WORD || restoring) {
      return;
    }
    restoring = true;
    try {
      await restoreDatabaseBackup(filename, { keepSafetyBackup: backupFirst });
    } finally {
      restoring = false;
      onClose();
    }
  };
</script>

<Dialog title={$t('admin.frameleaf_maintenance_restore_confirm_title')} closeLabel={$t('close')} bind:open>
  <div class="body">
    {#if summary}
      <p class="summary"><strong>{summary}</strong></p>
    {/if}
    <p class="filename"><code>{filename}</code></p>
    <ul class="consequences">
      {#each consequences as key (key)}
        <li>{$t(key)}</li>
      {/each}
    </ul>
    <p class="steps">{$t('admin.frameleaf_maintenance_restore_steps')}</p>
    <label class="backup-first">
      <input type="checkbox" bind:checked={backupFirst} disabled={restoring} />
      {$t('admin.frameleaf_maintenance_restore_backup_first')}
    </label>
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
  /* The template's `.mt-consequences` and `.mt-dialog-check` (maintenance.css). */
  .consequences {
    margin: 12px 0;
    padding-left: 18px;
    list-style: disc;
    color: var(--fl-text);
    font-size: var(--fl-font-small);
    line-height: 1.7;
  }
  .body .steps {
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  .backup-first {
    display: flex;
    align-items: center;
    gap: 10px;
    margin: 8px 0 0;
    color: var(--fl-text);
    font-size: var(--fl-font-small);
  }
  .backup-first input {
    margin: 0;
    accent-color: var(--fl-accent);
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
