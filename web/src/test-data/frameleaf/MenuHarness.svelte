<script lang="ts">
  import Theme from '$lib/components/frameleaf/Theme.svelte';
  import Menu from '$lib/components/frameleaf/Menu.svelte';
  import MenuItem from '$lib/components/frameleaf/MenuItem.svelte';
  let { theme = 'dark', onSelect }: { theme?: 'dark' | 'light'; onSelect?: (id: string) => void } = $props();
  let showHidden = $state(false);
</script>

<Theme {theme}>
  <button type="button">Before menu</button>
  <Menu label="Filter">
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
  </Menu>
  <button type="button">After menu</button>
</Theme>
