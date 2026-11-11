<script lang="ts">
  /**
   * FL-1409 (M7; prototype `Activity.jsx` `ScanInterrupted`): a library scan that stopped early.
   *
   * Interrupted (the server restarted, or the scan's worker was lost): what happened, that nothing was lost, how
   * many files are in the library, and Scan again. The scan carries on by itself once after a restart, so this
   * shows only when that did not work.
   *
   * A folder that can't be reached is not an interruption: it says "Waiting for a drive", as Recent work does, names
   * the library and offers no Scan again, because scanning again can't help until the drive is back.
   *
   * What the server reported stays under Technical details.
   */
  import ActivityNotice from '$lib/components/frameleaf/ActivityNotice.svelte';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import type { ActivityItem } from '$lib/frameleaf/activity';
  import { getAllLibraries, type LibraryResponseDto } from '@frameleaf/sdk';
  import { Icon } from '@frameleaf/ui';
  import { mdiAlertCircleOutline, mdiHarddisk, mdiRefresh } from '@mdi/js';
  import { onMount } from 'svelte';
  import { locale, t } from 'svelte-i18n';

  let {
    item,
    busy = false,
    onScanAgain,
    onDismiss,
  }: {
    item: ActivityItem;
    /** Scan again or Not now is on its way to the server. */
    busy?: boolean;
    onScanAgain: (libraryId: string) => void;
    onDismiss: () => void;
  } = $props();

  const interrupted = $derived(item.scan === 'interrupted');
  /** The library this scan was of: Scan again needs it, and it knows how many files are in. */
  let library = $state<LibraryResponseDto>();
  onMount(async () => {
    try {
      const libraries = await getAllLibraries({});
      library = libraries.find((candidate) => candidate.scan?.operationId === item.operationId);
    } catch {
      // Only an administrator may read libraries; without one the card still says what happened.
    }
  });
</script>

<ActivityNotice
  icon={interrupted ? mdiAlertCircleOutline : mdiHarddisk}
  title={interrupted
    ? $t('frameleaf_activity_scan_interrupted_title', { values: { name: item.title } })
    : $t('frameleaf_job_runs_status_waiting_drive')}
>
  <p>
    {#if !interrupted}
      {$t('frameleaf_activity_scan_drive_body', { values: { name: item.title } })}
    {:else if library}
      {$t('frameleaf_activity_scan_interrupted_body_count', {
        values: { count: library.assetCount, files: library.assetCount.toLocaleString($locale ?? undefined) },
      })}
    {:else}
      {$t('frameleaf_activity_scan_interrupted_body')}
    {/if}
  </p>
  {#if item.error}
    <details>
      <summary>{$t('frameleaf_activity_work_technical')}</summary>
      <p>{item.error}</p>
    </details>
  {/if}
  {#snippet actions()}
    {#if interrupted && library}
      <Button variant="primary" disabled={busy} onclick={() => onScanAgain(library!.id)}>
        <Icon icon={mdiRefresh} size="1.125rem" aria-hidden={true} />{$t('frameleaf_activity_scan_again')}
      </Button>
    {/if}
    <Button disabled={busy} onclick={onDismiss}>{$t('frameleaf_activity_scan_not_now')}</Button>
  {/snippet}
</ActivityNotice>
