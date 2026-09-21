<script lang="ts">
  import { TooltipProvider } from '@immich/ui';
  import type { ComponentProps } from 'svelte';
  import DetailPanelImageEnrichment from './DetailPanelImageEnrichment.svelte';

  let props: ComponentProps<typeof DetailPanelImageEnrichment> = $props();
</script>

<TooltipProvider>
  <DetailPanelImageEnrichment {...props} />
</TooltipProvider>
