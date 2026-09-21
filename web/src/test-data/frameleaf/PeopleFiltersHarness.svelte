<script lang="ts">
  import { TooltipProvider } from '@immich/ui';
  import SearchFilterModal from '$lib/modals/SearchFilterModal.svelte';
  let { modal = false }: { modal?: boolean } = $props();
  import SearchFilters from '$lib/components/shared-components/search-bar/SearchFilters.svelte';
  const noop = () => {};
</script>

<TooltipProvider>
  {#if modal}
    <SearchFilterModal searchQuery={{ personIds: ['person-a'] }} onClose={noop} />
  {:else}
    <SearchFilters
      id="filters"
      isOpen
      onSelectSearchTerm={noop}
      onClearSearchTerm={noop}
      onClearAllSearchTerms={noop}
      onActiveSelectionChange={noop}
      onSearch={noop}
    />
  {/if}
</TooltipProvider>
