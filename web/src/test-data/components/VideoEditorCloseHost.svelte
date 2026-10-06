<script lang="ts">
  import VideoQuickEditor from '$lib/components/frameleaf/editor/VideoQuickEditor.svelte';
  import type { AssetResponseDto } from '@frameleaf/sdk';

  let { asset, onClose }: { asset: AssetResponseDto; onClose: (refresh?: boolean) => void } = $props();
  let open = $state(true);
</script>

{#if open}
  <VideoQuickEditor
    {asset}
    onClose={(refresh) => {
      open = false;
      onClose(refresh);
    }}
  />
{/if}
