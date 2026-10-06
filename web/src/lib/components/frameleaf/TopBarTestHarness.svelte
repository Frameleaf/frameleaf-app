<script lang="ts">
  import { TooltipProvider } from '@frameleaf/ui';
  import TopBar from './TopBar.svelte';
</script>

<TooltipProvider>
  <TopBar hasRail={false} />
</TooltipProvider>
