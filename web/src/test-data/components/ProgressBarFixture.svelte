<script lang="ts">
  import ProgressBar from '$lib/components/shared-components/progress-bar/ProgressBar.svelte';
  import type { ProgressBarStatus } from '$lib/constants';
  import type { ComponentProps } from 'svelte';

  let props: ComponentProps<typeof ProgressBar> = $props();
  let status = $state<ProgressBarStatus>();
  let bar: ReturnType<typeof ProgressBar>;
  export const getBar = () => bar;
</script>

<ProgressBar {...props} bind:status bind:this={bar} />
