<script lang="ts">
  import Theme from '$lib/components/frameleaf/Theme.svelte';
  import Badge from '$lib/components/frameleaf/Badge.svelte';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Chip from '$lib/components/frameleaf/Chip.svelte';
  import IconButton from '$lib/components/frameleaf/IconButton.svelte';
  import SegmentedControl from '$lib/components/frameleaf/SegmentedControl.svelte';
  import Toggle from '$lib/components/frameleaf/Toggle.svelte';
  let {
    theme = 'dark',
    disabled = false,
    onAction,
  }: { theme?: 'dark' | 'light'; disabled?: boolean; onAction?: (id: string) => void } = $props();
  let favorite = $state(false);
  let includeArchived = $state(false);
  let mediaType = $state('all');
  let chipShown = $state(true);
</script>

<Theme {theme}>
  <Button variant="primary" {disabled} onclick={() => onAction?.('create')}>Create album</Button>
  <IconButton label="Favorite" pressed={favorite} {disabled} onclick={() => (favorite = !favorite)}>
    <svg viewBox="0 0 24 24" width="20" height="20">
      <path d="M12 2 15 9h7l-5.5 4.5L18 21l-6-4-6 4 1.5-7.5L2 9h7z" />
    </svg>
  </IconButton>
  <Badge value={3} label="3 filters active" tone="teal" />
  <SegmentedControl
    label="Media type"
    bind:value={mediaType}
    {disabled}
    options={[
      { value: 'all', label: 'All' },
      { value: 'photo', label: 'Photos', hint: '12' },
      { value: 'video', label: 'Videos' },
    ]}
    onChange={(next) => onAction?.(`media:${next}`)}
  />
  <Toggle
    label="Include archived"
    bind:checked={includeArchived}
    onLabel="On"
    offLabel="Off"
    {disabled}
    onChange={(next) => onAction?.(`archived:${next}`)}
  />
  {#if chipShown}
    <Chip label="2026" removeLabel="Remove year 2026" onRemove={() => (chipShown = false)} />
  {/if}
</Theme>
