<script lang="ts">
  /** One queue (the old `/admin/queues/<name>` page) inside Compute & jobs → Job manager (FL-71). */
  import CommandCenterActions from '$lib/components/frameleaf/settings/CommandCenterActions.svelte';
  import QueueGraph from '../../../admin/queues/[name]/QueueGraph.svelte';
  import { queueManager } from '$lib/managers/queue-manager.svelte';
  import { asQueueItem, getQueueActions } from '$lib/services/queue.service';
  import { Badge, Card, CardBody, CardHeader, CardTitle, Heading, Icon, MenuItemType, Text } from '@immich/ui';
  import { mdiClockTimeTwoOutline } from '@mdi/js';
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';
  import { getQueue, type QueueName, type QueueResponseDto } from '@immich/sdk';

  type Props = {
    name: QueueName;
  };

  const { name }: Props = $props();

  let loaded = $state<QueueResponseDto>();
  $effect(() => {
    const wanted = name;
    let cancelled = false;
    void getQueue({ name: wanted })
      .then((result) => {
        if (!cancelled) {
          loaded = result;
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  });

  const queue = $derived(queueManager.queues.find((q) => q.name === name) ?? loaded);

  onMount(() => queueManager.listen());
</script>

{#if queue}
  {@render detail(queue)}
{:else}
  <p role="status">{$t('loading')}</p>
{/if}

{#snippet detail(queue: QueueResponseDto)}
  {@const { Pause, Resume, Empty, RemoveFailedJobs } = getQueueActions($t, queue)}
  {@const item = asQueueItem($t, queue)}

  <CommandCenterActions actions={[Pause, Resume, Empty, MenuItemType.Divider, RemoveFailedJobs]} />
  <div class="mt-4 mb-1 flex items-center gap-2">
    <Heading tag="h2" size="large">{item.title}</Heading>
    {#if queue.isPaused}
      <Badge color="warning">
        {$t('paused')}
      </Badge>
    {/if}
  </div>
  <Text color="muted" class="mb-4">{item.subtitle}</Text>

  <div class="mb-4 flex gap-1">
    <Badge>{$t('active_count', { values: { count: queue.statistics.active } })}</Badge>
    <Badge>{$t('waiting_count', { values: { count: queue.statistics.waiting + queue.statistics.paused } })}</Badge>
    {#if queue.statistics.failed > 0}
      <Badge color="danger">{$t('failed_count', { values: { count: queue.statistics.failed } })}</Badge>
    {/if}
  </div>

  <div class="mt-8">
    <Card color="secondary">
      <CardHeader>
        <div class="flex items-center gap-2 text-primary">
          <Icon icon={mdiClockTimeTwoOutline} size="1.5rem" />
          <CardTitle>{$t('admin.jobs_over_time')}</CardTitle>
        </div>
      </CardHeader>
      <CardBody>
        <QueueGraph {queue} class="h-[300px]" />
      </CardBody>
    </Card>
  </div>
{/snippet}
