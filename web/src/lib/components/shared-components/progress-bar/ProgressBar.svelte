<script lang="ts">
  import { ProgressBarStatus } from '$lib/constants';
  import { handlePromiseError } from '$lib/utils';

  import { onDestroy, onMount, untrack } from 'svelte';
  import { tweened } from 'svelte/motion';

  interface Props {
    /**
     * Autoplay on mount
     * @default false
     */
    autoplay?: boolean;
    /**
     * Progress bar status
     */
    status?: ProgressBarStatus;
    hidden?: boolean;
    duration?: number;
    onDone: () => void;
    onPlaying?: () => void;
    onPaused?: () => void;
  }

  let {
    autoplay = false,
    status = $bindable(),
    hidden = false,
    duration = 5,
    onDone,
    onPlaying = () => {},
    onPaused = () => {},
  }: Props = $props();

  let progressDuration = duration;
  let destroyed = false;
  const progress = tweened<number>(0, {
    duration: (from: number, to: number) => progressDuration * 1000 * (to - from),
  });

  $effect(() => {
    const nextDuration = duration;
    untrack(() => {
      if (nextDuration === progressDuration) {
        return;
      }
      progressDuration = nextDuration;
      void progress.set(0, { duration: 0 });
      if (status === ProgressBarStatus.Playing) {
        handlePromiseError(play());
      }
    });
  });

  $effect(() => {
    if ($progress === 1) {
      untrack(() => onDone());
    }
  });

  onMount(() => {
    if (autoplay) {
      handlePromiseError(play());
    } else {
      status = ProgressBarStatus.Paused;
    }
  });

  onDestroy(() => {
    destroyed = true;
    void progress.set(0, { duration: 0 });
  });

  export const play = async () => {
    if (destroyed) {
      return;
    }
    status = ProgressBarStatus.Playing;
    onPlaying();
    if (!destroyed && status === ProgressBarStatus.Playing) {
      await progress.set(1);
    }
  };

  export const pause = async () => {
    if (destroyed) {
      return;
    }
    status = ProgressBarStatus.Paused;
    onPaused();
    if (!destroyed && status === ProgressBarStatus.Paused) {
      await progress.set($progress, { duration: 0 });
    }
  };

  export const restart = async () => {
    await resetProgress();

    if (!destroyed && status !== ProgressBarStatus.Paused) {
      await play();
    }
  };

  export const resetProgress = async () => {
    if (!destroyed) {
      await progress.set(0, { duration: 0 });
    }
  };
</script>

{#if !hidden}
  <span class="absolute inset-s-0 h-[3px] bg-immich-primary shadow-2xl" style:width={`${$progress * 100}%`}></span>
{/if}
