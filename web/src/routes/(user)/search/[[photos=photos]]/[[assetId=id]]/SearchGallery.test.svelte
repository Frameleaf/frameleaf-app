<script lang="ts">
  import type { AssetResponseDto } from '@immich/sdk';
  let { assets, onEndReached }: { assets: AssetResponseDto[]; onEndReached?: () => void } = $props();
  let draft = $state('');
</script>

<input aria-label="Pending editor draft" bind:value={draft} />
<output aria-label="Loaded search assets">{assets.map((asset) => asset.id).join(',')}</output>
<button type="button" onclick={() => onEndReached?.()}>Load next search page</button>
