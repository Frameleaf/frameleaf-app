<script lang="ts">
  import TableRow from '../Table/TableRow.svelte';
  import type { Snippet } from 'svelte';

  type Props = {
    children: Snippet;
  };

  const { children }: Props = $props();
</script>

<TableRow {children} />
