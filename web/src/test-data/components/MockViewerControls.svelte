<script lang="ts">
  import type { AssetResponseDto } from '@frameleaf/sdk';

  let {
    cursor,
    asset,
    onClose,
    onRendered,
    onAssetSuppressed,
  }: {
    cursor?: { current: AssetResponseDto };
    asset?: AssetResponseDto;
    onClose?: (refreshAsset: boolean) => void;
    onRendered?: (assetId: string) => void;
    onAssetSuppressed?: (asset: AssetResponseDto) => void | Promise<void>;
  } = $props();
</script>

<button type="button" onclick={() => onClose?.(true)}>Save video edits</button>
{#if asset && onRendered}
  <button type="button" onclick={() => onRendered?.(asset.id)}>Publish photo render</button>
{/if}
<button type="button" onclick={() => cursor && onAssetSuppressed?.(cursor.current)}>Suppress asset</button>
