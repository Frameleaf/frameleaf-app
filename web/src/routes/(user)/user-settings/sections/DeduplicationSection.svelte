<script lang="ts">
  import FileTrashUtility from '$lib/components/frameleaf/FileTrashUtility.svelte';
  import Loader from './Loader.svelte';
  import { loadDeduplication } from './loaders';
</script>

<Loader load={loadDeduplication}>
  {#snippet children(data)}
    <FileTrashUtility initial={data} />
  {/snippet}
</Loader>
