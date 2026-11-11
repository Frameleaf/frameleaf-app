<script lang="ts">
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import {
    ACTIVITY_STAGE_KEYS,
    activityCloudJob,
    formatFinishedTime,
    mediaOperationStage,
  } from '$lib/frameleaf/activity';
  import { cloudCostFacts } from '$lib/frameleaf/cloud-jobs';
  import { Route } from '$lib/route';
  import { MediaOperationKind, searchMediaOperations, type MediaOperationDto } from '@frameleaf/sdk';
  import { onDestroy, untrack } from 'svelte';
  import { locale, t } from 'svelte-i18n';

  let { open = $bindable(false), projectId }: { open?: boolean; projectId: string } = $props();

  const PAGE_SIZE = 50;
  type CloudReceipt = MediaOperationDto & { cloudJob: NonNullable<MediaOperationDto['cloudJob']> };
  let receipts = $state<CloudReceipt[]>([]);
  let skip = $state(0);
  let more = $state(false);
  let busy = $state(false);
  let unavailable = $state(false);
  let request: AbortController | undefined;

  const load = async (offset: number, project = projectId) => {
    request?.abort();
    const controller = new AbortController();
    request = controller;
    const current = () => !controller.signal.aborted && open && project === projectId;
    busy = true;
    unavailable = false;
    try {
      const { items, total } = await searchMediaOperations(
        { kind: MediaOperationKind.CloudMlJob, includeDismissed: true, take: PAGE_SIZE, skip: offset },
        { signal: controller.signal },
      );
      if (!current()) {
        return;
      }
      const page = items.filter(
        (item): item is CloudReceipt =>
          item.kind === MediaOperationKind.CloudMlJob &&
          item.projectId === project &&
          !item.withheld &&
          !!item.cloudJob,
      );
      const known = new Map((offset ? receipts : []).map((item) => [item.id, item]));
      for (const item of page) {
        known.set(item.id, item);
      }
      receipts = [...known.values()];
      skip = offset + items.length;
      more = items.length > 0 && skip < total;
    } catch {
      if (current()) {
        unavailable = true;
      }
    } finally {
      if (current()) {
        busy = false;
      }
    }
  };

  $effect(() => {
    const shown = open;
    const project = projectId;
    untrack(() => {
      if (shown) {
        receipts = [];
        skip = 0;
        more = false;
        void load(0, project);
      } else {
        request?.abort();
        busy = false;
      }
    });
  });

  onDestroy(() => request?.abort());
</script>

<Dialog bind:open title={$t('frameleaf_studio_cloud_receipts')} closeLabel={$t('close')}>
  <section aria-label={$t('frameleaf_studio_cloud_receipts')} aria-busy={busy}>
    <p>{$t('frameleaf_studio_cloud_receipts_intro')}</p>
    {#if unavailable}
      <p role="status">{$t('frameleaf_studio_cloud_receipts_unavailable')}</p>
    {:else if !busy && !more && receipts.length === 0}
      <p role="status">{$t('frameleaf_studio_cloud_receipts_empty')}</p>
    {/if}
    {#if receipts.length > 0}
      <ul>
        {#each receipts as receipt (receipt.id)}
          {@const stage = mediaOperationStage(receipt)}
          <li>
            <h3>{receipt.label || $t('frameleaf_studio_cloud_receipts_job')}</h3>
            <p>
              {$t(ACTIVITY_STAGE_KEYS[stage])}
              <time datetime={receipt.createdAt}
                >{formatFinishedTime(Date.parse(receipt.createdAt), $locale ?? undefined)}</time
              >
            </p>
            <dl aria-label={$t('frameleaf_activity_cloud_cost')}>
              {#each cloudCostFacts(activityCloudJob(receipt.cloudJob), stage) as fact (fact.labelKey)}
                <div>
                  <dt>{$t(fact.labelKey)}</dt>
                  <dd>{fact.valueKey ? $t(fact.valueKey) : fact.value}</dd>
                </div>
              {/each}
            </dl>
            {#if stage === 'done' && receipt.resultAssetId}
              <a href={Route.viewAsset({ id: receipt.resultAssetId })}>{$t('frameleaf_activity_open_result')}</a>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
    <div class="actions">
      <a href={Route.activity()}>{$t('frameleaf_activity_open')}</a>
      <Button disabled={busy} onclick={() => void load(0)}>{$t('frameleaf_studio_receipts_refresh')}</Button>
      {#if more}
        <Button disabled={busy} onclick={() => void load(skip)}>{$t('frameleaf_studio_receipts_older')}</Button>
      {/if}
    </div>
  </section>
</Dialog>

<style>
  section,
  ul {
    display: grid;
    gap: 1rem;
  }

  li {
    border-block-start: 1px solid var(--fl-border);
    padding-block-start: 0.75rem;
  }

  h3 {
    font-weight: 600;
    overflow-wrap: anywhere;
  }

  time {
    margin-inline-start: 0.5rem;
  }

  dl {
    margin-block-start: 0.5rem;
  }

  dl div {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    gap: 0.5rem;
  }

  dd {
    overflow-wrap: anywhere;
  }

  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
  }
</style>
