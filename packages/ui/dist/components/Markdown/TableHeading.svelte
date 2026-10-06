<script lang="ts">
  import TableHeading from '../Table/TableHeading.svelte';
  import type { Snippet } from 'svelte';

  type Props = {
    children?: Snippet;
  };

  const { children }: Props = $props();
</script>

<TableHeading {children} />
