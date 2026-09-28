<script lang="ts">
  /**
   * Restore from backup, step 1 (FL-80): the install check before an administrator picks a backup,
   * in the maintenance page's Frameleaf card instead of upstream `@immich/ui` layout. Each storage
   * folder shows whether it is readable and writable and whether it holds files, with the same hints.
   */
  import { detectPriorInstall, type MaintenanceDetectInstallResponseDto } from '@immich/sdk';
  import { Icon } from '@immich/ui';
  import { mdiAlert, mdiArrowRight, mdiCheck, mdiClose, mdiRefresh } from '@mdi/js';
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';

  type Props = {
    next: () => void;
    end: () => void;
  };

  const { next, end }: Props = $props();

  let detectedInstall: MaintenanceDetectInstallResponseDto | undefined = $state();

  const reload = async () => {
    detectedInstall = await detectPriorInstall();
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

  onMount(() => reload());
</script>

<div class="auth-card">
  <div class="auth-heading">
    <h1>{$t('maintenance_restore_library')}</h1>
    <p>{$t('maintenance_restore_library_description')}</p>
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
                  <em>{$t('maintenance_restore_library_hint_storage_template_missing_files')}</em>
                {/if}
              {/if}
            </span>
          </li>
        {/if}
      {/each}
    </ul>
    <button type="button" class="button quiet refresh" onclick={reload}>
      <Icon icon={mdiRefresh} size="18" aria-hidden={true} />
      {$t('refresh')}
    </button>
  {:else}
    <p class="muted" role="status">{$t('maintenance_restore_library_loading')}</p>
  {/if}
  <p class="muted">{$t('maintenance_restore_library_confirm')}</p>
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
