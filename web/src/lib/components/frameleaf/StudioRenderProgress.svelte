<script lang="ts">
  import { onMount } from 'svelte';
  import { t, locale } from 'svelte-i18n';
  import type { MediaOperationDto } from '@frameleaf/sdk';
  import { formatActivityDuration } from '$lib/frameleaf/activity';
  /**
   * A running Studio export's facts under its status line (prototype `renderProgressView`): elapsed
   * work time and measured speed, plus at most one note (measuring, finalising or no progress). The
   * status line above already names the stage; queued, done and failed cards don't show this block.
   */
  let {
    progress,
    startedAt,
    online,
  }: {
    progress: NonNullable<MediaOperationDto['renderProgress']>;
    /** When a worker started the render; undefined until one has, so queue time is never counted. */
    startedAt?: number;
    online: boolean;
  } = $props();
  let now = $state(Date.now());
  onMount(() => {
    const timer = setInterval(() => {
      now = Date.now();
    }, 1000);
    return () => clearInterval(timer);
  });
  const format = (seconds: number) => formatActivityDuration(seconds, $locale ?? undefined);
  const elapsed = $derived(startedAt === undefined ? null : Math.max(0, (now - startedAt) / 1000));
  const lastAt = $derived(progress.lastProgressAt ? Date.parse(progress.lastProgressAt) : (startedAt ?? null));
  const quiet = $derived(lastAt === null ? 0 : Math.max(0, (now - lastAt) / 1000));
  const stalled = $derived(online && quiet >= 60);
  const fps = $derived(
    progress.stage === 'rendering' && progress.framesPerSecond !== null && !stalled ? progress.framesPerSecond : null,
  );
</script>

<div class="studio-render-progress">
  {#if elapsed !== null}
    <p>
      {$t('frameleaf_activity_render_elapsed', { values: { time: format(elapsed) } })}
      {#if fps !== null}
        · {$t('frameleaf_activity_render_fps', {
          values: { fps: fps.toLocaleString($locale ?? undefined, { maximumFractionDigits: 1 }) },
        })}
      {/if}
    </p>
  {/if}
  {#if stalled}
    <p role="status" class="warning">
      {$t('frameleaf_activity_render_stalled', { values: { time: format(quiet) } })}
    </p>
  {:else if progress.stage === 'rendering' && progress.remainingRenderSeconds === null}
    <p>{$t('frameleaf_activity_render_measuring')}</p>
  {:else if progress.stage === 'finalising'}
    <p>{$t('frameleaf_activity_render_finalising_note')}</p>
  {/if}
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
  .warning {
    color: var(--fl-warning);
  }
</style>
