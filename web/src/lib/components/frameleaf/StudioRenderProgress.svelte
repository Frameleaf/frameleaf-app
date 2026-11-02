<script lang="ts">
  import { onMount } from 'svelte';
  import { t, locale } from 'svelte-i18n';
  import type { MediaOperationDto } from '@frameleaf/sdk';
  import { formatActivityDuration } from '$lib/frameleaf/activity';
  let {
    progress,
    startedAt,
    finishedAt,
    active,
    online,
  }: {
    progress: NonNullable<MediaOperationDto['renderProgress']>;
    startedAt: number;
    finishedAt?: number;
    active: boolean;
    online: boolean;
  } = $props();
  let now = $state(Date.now());
  onMount(() => {
    const timer = setInterval(() => {
      now = Date.now();
    }, 1000);
    return () => clearInterval(timer);
  });
  const elapsed = $derived(Math.max(0, ((finishedAt ?? now) - startedAt) / 1000));
  const lastAt = $derived(progress.lastProgressAt ? Date.parse(progress.lastProgressAt) : null);
  const stalled = $derived(active && online && now - (lastAt ?? startedAt) >= 60_000);
</script>

<div class="studio-render-progress">
  <p>
    {$t(`frameleaf_activity_render_stage_${progress.stage}`)} ·
    {$t('frameleaf_activity_render_elapsed', {
      values: { time: formatActivityDuration(elapsed, $locale ?? undefined) },
    })}
    {#if progress.framesPerSecond !== null && active && !stalled}
      · {$t('frameleaf_activity_render_fps', {
        values: { fps: progress.framesPerSecond.toLocaleString($locale ?? undefined, { maximumFractionDigits: 1 }) },
      })}
    {/if}
  </p>
  {#if progress.lastProgressAt && lastAt !== null}
    <p>
      {$t('frameleaf_activity_render_last_progress')}
      <time datetime={progress.lastProgressAt}>{new Date(lastAt).toLocaleString($locale ?? undefined)}</time>
    </p>
  {/if}
  {#if active && progress.stage === 'rendering' && progress.remainingRenderSeconds === null}
    <p>{$t('frameleaf_activity_render_measuring')}</p>
  {/if}
  {#if active && progress.stage === 'finalising'}<p>{$t('frameleaf_activity_render_finalising_note')}</p>{/if}
  {#if stalled}<p role="status">{$t('frameleaf_activity_render_stalled')}</p>{/if}
</div>

<style>
  .studio-render-progress {
    margin-top: 0.5rem;
    color: var(--fl-text-muted, #a1a1aa);
    font-size: 0.8125rem;
  }
  p {
    margin: 0.25rem 0;
  }
</style>
