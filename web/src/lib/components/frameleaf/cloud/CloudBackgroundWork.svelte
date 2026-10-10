<script lang="ts">
  /**
   * Settings › Background work (FL-164): this server's Frameleaf Cloud backup operation and restore in
   * progress, with Pause, Resume and Cancel. Activity lists the same rows read-only and links here,
   * as the prototype's Activity says ("pause, retry and limits live in Settings → Background work").
   * Nothing shows while no backup operation or restore is queued, running or paused. The status is
   * this server's own; reading it never contacts Frameleaf Cloud.
   */
  import './frameleaf-cloud.css';
  import CloudWorkControls from '$lib/components/frameleaf/cloud/CloudWorkControls.svelte';
  import { ACTIVITY_STAGE_KEYS } from '$lib/frameleaf/activity';
  import { cloudWorkRows } from '$lib/frameleaf/cloud-backup';
  import { commandCenterUrl } from '$lib/frameleaf/settings-areas';
  import { getByteUnitString } from '$lib/utils/byte-units';
  import { getCloudBackupStatus, type CloudBackupStatusResponseDto } from '@frameleaf/sdk';
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';

  /** How often the rows read the status again while something is in progress. */
  const ACTIVE_POLL_MS = 3000;

  let status = $state<CloudBackupStatusResponseDto | null>(null);
  const rows = $derived(cloudWorkRows(status));
  const headingId = $props.id();

  const load = async () => {
    try {
      status = (await getCloudBackupStatus()) ?? null;
    } catch {
      // cloud backup is optional: without it, or while it cannot be read, there is nothing to show
    }
  };

  onMount(() => void load());

  $effect(() => {
    if (rows.length === 0) {
      return;
    }
    const timer = setInterval(() => void load(), ACTIVE_POLL_MS);
    return () => clearInterval(timer);
  });

  const stateOf = (id: string) =>
    id === 'cloud-restore-run' ? status?.activeRestore?.state : status?.activeRun?.state;
</script>

{#if rows.length > 0}
  <section
    class="frameleaf-cloud cloud-background-work"
    aria-labelledby={headingId}
    data-testid="cloud-background-work"
  >
    <h2 id={headingId}>{$t('frameleaf_settings_area_cloud')}</h2>
    {#each rows as row (row.id)}
      {@const title = $t(row.titleKey)}
      {@const runState = stateOf(row.id)}
      <div class="fc-last-run">
        <h3><a href={commandCenterUrl('backups', undefined, { backupView: 'cloud' })}>{title}</a></h3>
        <p class="fc-muted" role="status">
          {[
            $t(ACTIVITY_STAGE_KEYS[row.stage]),
            row.progress !== null && row.stage !== 'queued' ? `${row.progress}%` : null,
            row.files ? $t('frameleaf_cloud_work_files', { values: { count: row.files.done } }) : null,
            row.bytes ? getByteUnitString(row.bytes) : null,
          ]
            .filter(Boolean)
            .join(' · ')}
        </p>
        {#if runState}
          <CloudWorkControls
            operationId={row.operationId}
            {runState}
            {title}
            restore={row.id === 'cloud-restore-run'}
            onStatus={(next) => (status = next)}
          />
        {/if}
      </div>
    {/each}
  </section>
{/if}

<style>
  .cloud-background-work {
    margin: 12px 0 18px;
  }
  .cloud-background-work h2 {
    margin: 0 0 8px;
    font-size: var(--fl-font-size);
    font-weight: 600;
  }
  .cloud-background-work h3 a {
    color: inherit;
  }
</style>
