<script lang="ts">
  /**
   * Storage & originals → Physical deduplication (FL-71), the template's `deduplication` section;
   * the old `/admin/physical-deduplication` page only redirects here. The toolbar, preview and apply
   * flow live in PhysicalDedupManager.
   */
  import PhysicalDedupManager from '$lib/components/frameleaf/PhysicalDedupManager.svelte';
  import Loader from './Loader.svelte';
  import { loadDeduplication } from './loaders';
</script>

<Loader load={loadDeduplication}>
  {#snippet children(data)}
    <PhysicalDedupManager users={data.users} initial={data.preview} />
  {/snippet}
</Loader>
