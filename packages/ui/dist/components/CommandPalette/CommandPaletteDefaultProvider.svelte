<script lang="ts">
  import CommandPaletteProvider from './CommandPaletteProvider.svelte';
  import { defaultProvider, type ActionDefaultProviderOptions } from '../../services/command-palette-manager.svelte.js';

  const options: ActionDefaultProviderOptions = $props();
</script>

<CommandPaletteProvider providers={[defaultProvider(options)]} />
