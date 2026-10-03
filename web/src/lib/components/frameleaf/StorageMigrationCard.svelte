<script lang="ts">
  /**
   * FL-326 (spec §5.1, §5.3): Library Care's storage migration status, the prototype's
   * `StorageMigrationCard` (`design/frameleaf/template/src/StorageMigrationCard.jsx`). While the one-time
   * migration runs (typically after "Run in background instead" in Getting Ready) it shows the same
   * stages as Getting Ready, and once it is done the missing originals it left for review, which are the
   * Missing findings listed below it. Hidden when there is nothing to say.
   */
  import {
    STORAGE_MIGRATION_POLL_MS,
    fetchStorageMigrationStatus,
    storageMigrationView,
    type StorageMigrationStatus,
  } from '$lib/frameleaf/storage-migration';
  import { getByteUnitString } from '$lib/utils/byte-units';
  import { Icon } from '@immich/ui';
  import { mdiFileTree, mdiShieldCheckOutline } from '@mdi/js';
  import { onMount } from 'svelte';
  import { locale, t } from 'svelte-i18n';

  let status = $state<StorageMigrationStatus | undefined>();
  const view = $derived(status ? storageMigrationView(status) : undefined);
  const running = $derived(!!status && status.stage !== 'done' && status.stage !== 'pending');
  const visible = $derived(!!status && status.required && (running || status.toReview > 0));

  onMount(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      const next = await fetchStorageMigrationStatus();
      if (stopped) {
        return;
      }
      status = next;
      if (next && next.stage !== 'done') {
        timer = setTimeout(() => void tick(), STORAGE_MIGRATION_POLL_MS);
      }
    };
    void tick();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  });

  const number = (value: number) => value.toLocaleString($locale ?? undefined);
</script>

{#if visible && status && view}
  <section class="storage-migration-card" aria-labelledby="storage-migration-title">
    <Icon icon={running ? mdiFileTree : mdiShieldCheckOutline} size="22" aria-hidden={true} />
    <div class="body">
      <strong id="storage-migration-title">
        {running
          ? $t('frameleaf_storage_migration_title')
          : $t('frameleaf_storage_migration_review_title', { values: { count: status.toReview } })}
      </strong>
      {#if running}
        <div
          class="bar"
          role="progressbar"
          aria-label={$t('frameleaf_storage_migration_progress')}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={view.percent}
        >
          <span style:width="{view.percent}%"></span>
        </div>
        <ul>
          {#each view.tasks as task (task.id)}
            <li data-status={task.status}>
              {$t(`frameleaf_storage_migration_stage_${task.id}`)}
              <span>
                {task.status === 'running'
                  ? $t('frameleaf_storage_migration_stage_count', {
                      values: { done: number(task.done), total: number(task.total) },
                    })
                  : task.status === 'done'
                    ? $t('frameleaf_storage_migration_stage_done')
                    : $t('frameleaf_storage_migration_stage_waiting')}
              </span>
            </li>
          {/each}
        </ul>
        <p>
          {$t('frameleaf_storage_migration_relink_line', {
            values: { relinked: number(view.relinked), toReview: number(view.toReview) },
          })} ·
          {$t('frameleaf_storage_migration_freed', {
            values: { size: getByteUnitString(view.bytesFreed, $locale ?? undefined) },
          })} ·
          {$t('frameleaf_storage_migration_card_not_freed')}
        </p>
      {:else}
        <p>{$t('frameleaf_storage_migration_card_review', { values: { count: status.toReview } })}</p>
      {/if}
    </div>
  </section>
{/if}

<style>
  .storage-migration-card {
    display: flex;
    gap: 0.75rem;
    align-items: flex-start;
    margin: 0 0 1rem;
    padding: 0.875rem 1rem;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-card);
    background: var(--fl-panel);
  }
  .body {
    display: grid;
    flex: 1;
    gap: 0.5rem;
    min-width: 0;
  }
  .body p {
    margin: 0;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  .bar {
    height: 6px;
    overflow: hidden;
    border-radius: 999px;
    background: var(--fl-border);
  }
  .bar span {
    display: block;
    height: 100%;
    background: var(--fl-accent);
  }
  ul {
    display: grid;
    gap: 0.25rem;
    margin: 0;
    padding: 0;
    list-style: none;
    font-size: var(--fl-font-small);
  }
  li {
    display: flex;
    justify-content: space-between;
    gap: 0.75rem;
  }
  li[data-status='queued'] {
    color: var(--fl-muted);
  }
</style>
