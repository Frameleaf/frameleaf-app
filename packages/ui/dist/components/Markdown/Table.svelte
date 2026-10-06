<script lang="ts">
  import Table from '../Table/Table.svelte';
  import type { Snippet } from 'svelte';

  type Props = {
    children?: Snippet;
  };

  const { children }: Props = $props();
</script>

<Table striped {children} />
