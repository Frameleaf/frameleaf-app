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
   *
   * Version compatibility (FL-81): the dialog says which server made the backup against the one
   * running. An older backup is migrated after the restore; a backup from a newer server cannot be
   * migrated down, so Restore stays disabled (the server refuses it too); an unreadable version is
   * stated, and the rollback covers a migration that fails.
   */
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import { backupVersionCompatibility } from '$lib/frameleaf/maintenance-page';
  import { restoreDatabaseBackup } from '$lib/services/database-backups.service';
  import { t } from 'svelte-i18n';

  type Props = {
    filename: string;
    /** When the backup was made, already formatted; omitted when the filename carries no date. */
    date?: string;
    size?: string;
    /** The server version recorded in the backup's name, when it has one. */
    version?: string;
    /** The running server's version (`0.0.0` when it could not be read). */
    expectedVersion: string;
    open: boolean;
    onClose: () => void;
  };

  let { filename, date, size, version, expectedVersion, open = $bindable(false), onClose }: Props = $props();

  const compatibility = $derived(backupVersionCompatibility(version, expectedVersion));
  const blocked = $derived(compatibility === 'newer');

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
    if (confirmText !== CONFIRM_WORD || restoring || blocked) {
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
    {#if compatibility !== 'same'}
      <p class="version-note" class:is-blocked={blocked} role={blocked ? 'alert' : undefined}>
        {#if compatibility === 'older'}
          {$t('admin.frameleaf_maintenance_restore_version_older', {
            values: { backup: version, server: expectedVersion },
          })}
        {:else if compatibility === 'newer'}
          {$t('admin.frameleaf_maintenance_restore_version_newer', {
            values: { backup: version, server: expectedVersion },
          })}
        {:else}
          {$t('admin.frameleaf_maintenance_restore_version_unknown')}
        {/if}
      </p>
    {/if}
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
      <Button variant="primary" disabled={confirmText !== CONFIRM_WORD || restoring || blocked} onclick={confirm}>
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
  /* The template's `.mt-notice` tone (maintenance.css), for the version line. */
  .body .version-note {
    padding: 8px 10px;
    border-radius: var(--fl-radius-control);
    background: color-mix(in srgb, var(--fl-warning) 12%, transparent);
    font-size: var(--fl-font-small);
  }
  .body .version-note.is-blocked {
    background: color-mix(in srgb, var(--fl-danger) 12%, transparent);
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
