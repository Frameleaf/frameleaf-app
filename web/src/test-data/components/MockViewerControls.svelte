<script lang="ts">
  import type { OnUndoDelete } from '$lib/utils/actions';
  import { toTimelineAsset } from '$lib/utils/timeline-util';
  import type { AssetResponseDto } from '@frameleaf/sdk';

  let {
    cursor,
    asset,
    onClose,
    onRendered,
    onSaved,
    onAssetSuppressed,
    onUndoDelete,
  }: {
    cursor?: { current: AssetResponseDto };
    asset?: AssetResponseDto;
    onClose?: (refreshAsset: boolean) => void;
    onRendered?: (assetId: string) => void;
    onSaved?: () => void | Promise<void>;
    onUndoDelete?: OnUndoDelete;
    onAssetSuppressed?: (asset: AssetResponseDto) => void | Promise<void>;
  } = $props();
</script>

<button type="button" onclick={() => onClose?.(true)}>Save video edits</button>
{#if asset && onRendered}
  <button type="button" onclick={() => onRendered?.(asset.id)}>Publish photo render</button>
{/if}
<button type="button" onclick={() => cursor && onAssetSuppressed?.(cursor.current)}>Suppress asset</button>

{#if onUndoDelete && cursor}
  <button type="button" onclick={() => cursor && onUndoDelete?.([toTimelineAsset(cursor.current)])}>Undo delete</button>
{/if}

{#if onSaved}
  <button type="button" onclick={() => onSaved?.()}>Save face tags</button>
{/if}
