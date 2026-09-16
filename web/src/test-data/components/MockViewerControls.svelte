<script lang="ts">
  import type { AssetResponseDto } from '@immich/sdk';

  let {
    cursor,
    onClose,
    onAssetSuppressed,
  }: {
    cursor?: { current: AssetResponseDto };
    onClose?: (refreshAsset: boolean) => void;
    onAssetSuppressed?: (asset: AssetResponseDto) => void | Promise<void>;
  } = $props();
</script>

<button type="button" onclick={() => onClose?.(true)}>Save video edits</button>
<button type="button" onclick={() => cursor && onAssetSuppressed?.(cursor.current)}>Suppress asset</button>
