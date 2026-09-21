<script lang="ts">
  import type { TimelineAsset } from '$lib/managers/timeline-manager/types';
  import type { AssetResponseDto } from '@immich/sdk';

  let {
    cursor,
    onClose,
    onAssetSuppressed,
    onUndoDelete,
  }: {
    onUndoDelete?: (assets: TimelineAsset[]) => void | Promise<void>;
    cursor?: { current: AssetResponseDto };
    onClose?: (refreshAsset: boolean) => void;
    onAssetSuppressed?: (asset: AssetResponseDto) => void | Promise<void>;
  } = $props();
</script>

<button type="button" onclick={() => onClose?.(true)}>Save video edits</button>
<button type="button" onclick={() => cursor && onAssetSuppressed?.(cursor.current)}>Suppress asset</button>

<button type="button" onclick={() => onUndoDelete?.([])}>Undo no assets</button>
<button type="button" onclick={() => cursor && onUndoDelete?.([{ id: cursor.current.id } as TimelineAsset])}
  >Undo deleted asset</button
>
