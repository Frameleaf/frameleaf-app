<script lang="ts">
  /**
   * Compute & jobs → Job manager (FL-71): the old `/admin/queues` page in the Command Center, with
   * one queue opening inside the section (`?queue=<slug>`). The old addresses only redirect here.
   */
  import { page } from '$app/state';
  import CommandCenterActions from '$lib/components/frameleaf/settings/CommandCenterActions.svelte';
  import OnEvents from '$lib/components/OnEvents.svelte';
  import JobsPanel from '../../../admin/queues/QueuePanel.svelte';
  import QueueDetail from './QueueDetail.svelte';
  import { fromQueueSlug, Route } from '$lib/route';
  import { queueManager } from '$lib/managers/queue-manager.svelte';
  import { getQueuesActions } from '$lib/services/queue.service';
  import { type QueueResponseDto } from '@immich/sdk';
  import { CommandPaletteDefaultProvider, type ActionItem } from '@immich/ui';
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';

  const selected = $derived(fromQueueSlug(page.url.searchParams.get('queue') ?? ''));

  onMount(() => queueManager.listen());

  let queues = $derived<QueueResponseDto[]>(queueManager.queues);

  const { ResumePaused, CreateJob, ManageConcurrency, EnrichmentTasks } = $derived(
    getQueuesActions($t, queueManager.queues),
  );
  const commands: ActionItem[] = $derived([CreateJob, ManageConcurrency, EnrichmentTasks]);

  const onQueueUpdate = (update: QueueResponseDto) => {
    queues = queues.map((queue) => {
      if (queue.name === update.name) {
        return update;
      }
      return queue;
    });
  };
</script>

<CommandPaletteDefaultProvider name={$t('admin.queues')} actions={commands} />

<OnEvents {onQueueUpdate} />

{#if selected}
  <a class="cc-back-link" href={Route.queues()}>← {$t('admin.queues')}</a>
  <QueueDetail name={selected} />
{:else}
  <CommandCenterActions actions={[ResumePaused, ManageConcurrency, EnrichmentTasks, CreateJob]} />
  {#if queues}
    <JobsPanel {queues} />
  {/if}
{/if}

<style>
  .cc-back-link {
    display: inline-block;
    margin-bottom: 12px;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
    text-decoration: none;
  }
  .cc-back-link:hover {
    color: var(--fl-accent);
  }
</style>
