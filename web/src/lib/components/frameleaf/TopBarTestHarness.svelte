<script lang="ts">
  import { TooltipProvider } from '@immich/ui';
  import TopBar from './TopBar.svelte';
</script>

<TooltipProvider>
  <TopBar hasRail={false} />
</TooltipProvider>
