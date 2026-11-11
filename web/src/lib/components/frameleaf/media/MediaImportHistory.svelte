<script lang="ts">
  import Button from '$lib/components/frameleaf/Button.svelte';
  import InlineError from '$lib/components/frameleaf/InlineError.svelte';
  import { getMediaImports, type MediaImportResponseDto } from '@frameleaf/sdk';
  import { onMount, tick } from 'svelte';
  import { locale, t } from 'svelte-i18n';
  import { mediaDate } from './boards-media';
  import MediaImportProgress from './MediaImportProgress.svelte';

  let {
    subscriptionId,
    onOpenResult,
    onSaved,
  }: {
    subscriptionId?: string;
    onOpenResult: () => void;
    onSaved: (assetIds: string[], albumId: string) => void;
  } = $props();

  let jobs = $state<MediaImportResponseDto[]>([]);
  let operation = $state<MediaImportResponseDto>();
  let selectedHeading: HTMLHeadingElement;
  let lastTrigger: HTMLElement | undefined;
  let busy = $state(true);
  let failed = $state(false);
  const controller = new AbortController();

  const load = async () => {
    busy = true;
    failed = false;
    try {
      const { imports } = await getMediaImports({ signal: controller.signal });
      jobs = imports.filter((item) =>
        subscriptionId ? item.subscriptionId === subscriptionId : item.albumId && !item.subscriptionId,
      );
    } catch {
      failed = true;
    } finally {
      busy = false;
    }
  };

  onMount(() => {
    void load();
    return () => controller.abort();
  });

  const open = async (value: MediaImportResponseDto, event: MouseEvent) => {
    lastTrigger = event.currentTarget as HTMLElement;
    operation = value;
    await tick();
    selectedHeading?.focus();
  };

  const back = async () => {
    if (operation) {
      const latest = operation;
      jobs = jobs.map((job) => (job.id === latest.id ? latest : job));
    }
    operation = undefined;
    await tick();
    lastTrigger?.focus();
  };
</script>

{#if operation}
  <div class="media-fields">
    <h3 tabindex="-1" bind:this={selectedHeading}>
      {operation.creator || operation.items[0]?.title || mediaDate(operation.createdAt, $locale)}
    </h3>
    <div><Button onclick={() => void back()}>{$t('back')}</Button></div>
    <MediaImportProgress bind:operation {onOpenResult} {onSaved} />
  </div>
{:else if failed}
  <InlineError compact message={$t('frameleaf_boards_media_history_error')} onRetry={load} />
{:else if busy}
  <p role="status">{$t('loading')}</p>
{:else}
  <div class="media-fields">
    <div class="media-actions">
      <Button onclick={() => void load()}>{$t('refresh')}</Button>
    </div>
    {#if jobs.length}
      <ul class="media-list">
        {#each jobs as job (job.id)}
          <li>
            <strong>{job.creator || job.items[0]?.title || $t('frameleaf_boards_media_download')}</strong>
            <span class="media-secondary">
              <time datetime={job.createdAt}>{mediaDate(job.createdAt, $locale)}</time>
              · {$t(`frameleaf_boards_media_state_${job.state}`)}
            </span>
            <div>
              <Button
                label={$t('frameleaf_boards_media_open_job', { values: { date: mediaDate(job.createdAt, $locale) } })}
                onclick={(event) => void open(job, event)}>{$t('frameleaf_boards_media_open_progress')}</Button
              >
            </div>
          </li>
        {/each}
      </ul>
    {:else}
      <p>{$t('frameleaf_boards_media_history_empty')}</p>
    {/if}
  </div>
{/if}
