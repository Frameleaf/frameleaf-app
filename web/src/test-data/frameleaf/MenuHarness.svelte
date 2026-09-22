<script lang="ts">
  import Theme from '$lib/components/frameleaf/Theme.svelte';
  import Menu from '$lib/components/frameleaf/Menu.svelte';
  import MenuItem from '$lib/components/frameleaf/MenuItem.svelte';
  let { theme = 'dark', onSelect }: { theme?: 'dark' | 'light'; onSelect?: (id: string) => void } = $props();
  let showHidden = $state(false);
  // FL-38: exercises MenuItem's `keepOpen`, which a "Reassign…"-style command needs so the
  // popup can swap in a follow-up view instead of closing on activation.
  let mode = $state<'list' | 'detail'>('list');
</script>

<Theme {theme}>
  <button type="button">Before menu</button>
  <Menu label="Filter">
    {#if mode === 'list'}
      <MenuItem onSelect={() => onSelect?.('people')}>People</MenuItem>
      <MenuItem onSelect={() => onSelect?.('date')}>Date</MenuItem>
      <MenuItem disabled onSelect={() => onSelect?.('places')}>Places</MenuItem>
      <MenuItem
        checked={showHidden}
        onSelect={() => {
          showHidden = !showHidden;
          onSelect?.('hidden');
        }}
      >
        Hidden people
      </MenuItem>
      <MenuItem
        keepOpen
        onSelect={() => {
          mode = 'detail';
          onSelect?.('more');
        }}
      >
        More…
      </MenuItem>
    {:else}
      <MenuItem onSelect={() => onSelect?.('detail-choice')}>Detail view</MenuItem>
    {/if}
  </Menu>
  <button type="button">After menu</button>
</Theme>
