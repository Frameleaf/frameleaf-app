<script lang="ts">
  /**
   * Restore from backup, step 1 (FL-80): the install check before an administrator picks a backup,
   * in the maintenance page's Frameleaf card instead of upstream `@frameleaf/ui` layout. Each storage
   * folder shows whether it is readable and writable and whether it holds files, with the same hints.
   */
  import InlineError from '$lib/components/frameleaf/InlineError.svelte';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { handleError } from '$lib/utils/handle-error';
  import { detectPriorInstall, type MaintenanceDetectInstallResponseDto } from '@frameleaf/sdk';
  import { Icon } from '@frameleaf/ui';
  import { mdiAlert, mdiArrowRight, mdiCheck, mdiClose, mdiRefresh } from '@mdi/js';
  import { onDestroy, onMount } from 'svelte';
  import { t } from 'svelte-i18n';

  type Props = {
    next: () => void;
    end: () => void;
  };

  const { next, end }: Props = $props();

  let detectedInstall: MaintenanceDetectInstallResponseDto | undefined = $state();

  let loading = $state(false);
  let failed = $state(false);
  let alive = true;
  onDestroy(() => {
    alive = false;
  });
  const reload = async () => {
    if (loading) {
      return;
    }
    loading = true;
    failed = false;
    const isCurrentSession = authManager.captureSession();
    const isCurrent = () => alive && isCurrentSession();
    try {
      const result = await detectPriorInstall();
      if (isCurrent()) {
        detectedInstall = result;
      }
    } catch (error) {
      if (isCurrent()) {
        failed = true;
        handleError(error, $t('errors.something_went_wrong'));
      }
    } finally {
      // a session change drops the result, not the flag, or reload and retry stay disabled
      if (alive) {
        loading = false;
        // a first check dropped by a session change has nothing to show: offer the retry
        if (!isCurrentSession() && !detectedInstall) {
          failed = true;
        }
      }
    }
  };

  const getLibraryFolderCheckStatus = (writable: boolean, readable: boolean) => {
    if (writable) {
      return $t('maintenance_restore_library_folder_pass');
    }
    return readable
      ? $t('maintenance_restore_library_folder_write_fail')
      : $t('maintenance_restore_library_folder_read_fail');
  };

  const required = (folder: string) => folder === 'profile' || folder === 'upload';

  onMount(() => {
    void reload();
  });
</script>

<div class="auth-card">
  <div class="auth-heading">
    <h1>{$t('frameleaf_maintenance_restore_library')}</h1>
    <p>{$t('frameleaf_maintenance_restore_library_description')}</p>
  </div>
  {#if detectedInstall}
    <ul class="checks">
      {#each detectedInstall.storage as { folder, readable, writable } (folder)}
        <li data-tone={writable ? 'ok' : 'error'}>
          <Icon icon={writable ? mdiCheck : mdiClose} size="18" aria-hidden={true} />
          <span>{folder} ({getLibraryFolderCheckStatus(writable, readable)})</span>
        </li>
      {/each}
      {#each detectedInstall.storage as { folder, files } (folder)}
        {#if folder !== 'backups'}
          <li data-tone={files ? 'ok' : required(folder) ? 'error' : 'warning'}>
            <Icon icon={files ? mdiCheck : required(folder) ? mdiClose : mdiAlert} size="18" aria-hidden={true} />
            <span>
              {#if files}
                {$t('maintenance_restore_library_folder_has_files', { values: { folder, count: files } })}
              {:else}
                {$t('maintenance_restore_library_folder_no_files', { values: { folder } })}
              {/if}
              {#if !files}
                {#if required(folder)}
                  <em>{$t('maintenance_restore_library_hint_missing_files')}</em>
                {/if}
                {#if folder === 'encoded-video' || folder === 'thumbs'}
                  <em>{$t('maintenance_restore_library_hint_regenerate_later')}</em>
                {/if}
                {#if folder === 'library'}
                  <em>{$t('frameleaf_maintenance_restore_library_hint_folders')}</em>
                {/if}
              {/if}
            </span>
          </li>
        {/if}
      {/each}
    </ul>
    {#if !failed}
      <button type="button" class="button quiet refresh" onclick={reload} disabled={loading}>
        <Icon icon={mdiRefresh} size="18" aria-hidden={true} />
        {$t('refresh')}
      </button>
    {/if}
  {:else if !failed}
    <p class="muted" role="status">{$t('frameleaf_maintenance_restore_library_loading')}</p>
  {/if}
  {#if failed}
    <InlineError compact message={$t('errors.something_went_wrong')} onRetry={reload} retrying={loading} />
  {/if}
  <p class="muted">{$t('frameleaf_maintenance_restore_library_confirm')}</p>
  <div class="maint-actions">
    <button type="button" class="button" onclick={end}>{$t('cancel')}</button>
    <button type="button" class="button primary" onclick={next}>
      {$t('next')}
      <Icon icon={mdiArrowRight} size="18" aria-hidden={true} />
    </button>
  </div>
</div>

<style>
  .checks {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 8px;
    font-size: var(--fl-font-small);
  }
  .checks li {
    display: grid;
    grid-template-columns: 20px 1fr;
    gap: 10px;
    align-items: start;
  }
  .checks li[data-tone='ok'] :global(svg) {
    color: var(--fl-teal);
  }
  .checks li[data-tone='warning'] :global(svg) {
    color: var(--fl-warning);
  }
  .checks li[data-tone='error'] :global(svg) {
    color: var(--fl-danger);
  }
  .checks em {
    display: block;
    color: var(--fl-muted);
  }
  .muted {
    margin: 0;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  .button {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  .refresh {
    justify-self: start;
  }
</style>
