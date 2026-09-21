<script lang="ts">
  import { TooltipProvider } from '@immich/ui';
  import Theme from '$lib/components/frameleaf/Theme.svelte';
  import Picker from '$lib/components/frameleaf/Picker.svelte';
  let { theme = 'dark', disabled = false }: { theme?: 'dark' | 'light'; disabled?: boolean } = $props();
  const options = [
    { label: 'Camera A (12)', value: 'a' },
    { label: 'Camera B (8)', value: 'b' },
  ];
</script>

<TooltipProvider>
  <Theme {theme}>
    <Picker label="Outer camera" {options} {disabled} />
    <Theme theme={theme === 'dark' ? 'light' : 'dark'}>
      <Picker label="Nested camera" {options} {disabled} />
    </Theme>
  </Theme>
</TooltipProvider>
