<script lang="ts">
  import BulkAlbumDialog from '$lib/components/frameleaf/BulkAlbumDialog.svelte';
  import { addAssetsToAlbums } from '$lib/services/album.service';

  type Props = {
    assetIds: string[];
    onClose: () => void;
  };

  const { assetIds, onClose }: Props = $props();

  let open = $state(true);
</script>

<BulkAlbumDialog
  count={assetIds.length}
  bind:open
  onSubmit={({ albumId, albumIds }) => addAssetsToAlbums(albumIds ?? [albumId!], assetIds, { notify: true })}
  onClosed={onClose}
/>
