<script lang="ts">
  import { ProgressBarStatus } from '$lib/constants';
  import { onMount } from 'svelte';
  import { progressBarCalls } from './progress-bar-calls';

  type Props = {
    autoplay?: boolean;
    status?: ProgressBarStatus;
  };

  let { autoplay = false, status = $bindable() }: Props = $props();

  onMount(() => {
    status = autoplay ? ProgressBarStatus.Playing : ProgressBarStatus.Paused;
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
  };
</script>
