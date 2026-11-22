<script lang="ts">
  import BulkAlbumDialog from '$lib/components/frameleaf/BulkAlbumDialog.svelte';
  import { addAssetsToAlbums } from '$lib/services/album.service';

  type Props = {
    assetIds: string[];
    onClose: () => void;
  };

  const { assetIds, onClose }: Props = $props();

  let open = $state(true);
  let adding: Promise<boolean> | undefined;

  // Callers await this modal, so it stays mounted until the add has finished.
  const handleClosed = async () => {
    await adding;
    onClose();
  };
</script>

<BulkAlbumDialog
  count={assetIds.length}
  bind:open
  onSubmit={({ albumId, albumIds }) => {
    if (albumId) {
      adding = addAssetsToAlbums(albumIds ?? [albumId], assetIds, { notify: true });
    }
  }}
  onClosed={handleClosed}
/>
