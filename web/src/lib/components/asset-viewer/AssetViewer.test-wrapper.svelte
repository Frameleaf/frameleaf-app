<script lang="ts">
  import { TooltipProvider } from '@immich/ui';
  import type { ComponentProps } from 'svelte';
  import AssetViewer from './AssetViewer.svelte';
  let props: ComponentProps<typeof AssetViewer> = $props();
</script>

<TooltipProvider>
  <AssetViewer {...props} />
</TooltipProvider>
