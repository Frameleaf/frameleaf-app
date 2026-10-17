<script lang="ts">
  import { ProgressBarStatus } from '$lib/constants';
  import { onMount } from 'svelte';
  import { progressBarCalls, progressBarFixture } from './progress-bar-calls';

  type Props = {
    autoplay?: boolean;
    onDone?: () => Promise<void>;
    status?: ProgressBarStatus;
  };

  let { autoplay = false, status = $bindable(), onDone }: Props = $props();

  onMount(() => {
    status = autoplay ? ProgressBarStatus.Playing : ProgressBarStatus.Paused;
    progressBarFixture.done = onDone;
    return () => {
      if (progressBarFixture.done === onDone) {
        progressBarFixture.done = undefined;
      }
    };
  });

  export const play = () => {
    progressBarCalls.push('play');
    status = ProgressBarStatus.Playing;
  };
  export const pause = () => {
    progressBarCalls.push('pause');
    status = ProgressBarStatus.Paused;
  };
  export const restart = () => {
    progressBarCalls.push(status === ProgressBarStatus.Paused ? 'restart (paused)' : 'restart');
  };
  export const resetProgress = () => {
    progressBarCalls.push('reset');
    return progressBarFixture.reset?.();
  };
</script>
