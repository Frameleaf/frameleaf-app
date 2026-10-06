<script lang="ts">
  import ProgressBar, { type Props } from '../../internal/ProgressBar.svelte';

  let props: Omit<Props, 'type'> = $props();
</script>

<ProgressBar type="meter" {...props} />
