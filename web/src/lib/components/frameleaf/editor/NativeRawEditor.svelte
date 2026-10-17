<script lang="ts">
  /**
   * RAW development from the viewer (FL-282): the RAW develop editor (FL-420, PhotographyEditor.jsx)
   * on this one photo. Photography opens the same editor on a whole shoot.
   */
  import type { AssetResponseDto } from '@frameleaf/sdk';
  import RawDevelopEditor from '$lib/components/frameleaf/develop/RawDevelopEditor.svelte';

  let {
    asset,
    onClose,
    onLegacy,
    onRendered,
  }: {
    asset: AssetResponseDto;
    onClose: (refresh?: boolean) => void;
    onLegacy: () => void;
    onRendered?: (id: string) => void;
  } = $props();

  const photos = $derived([
    { id: asset.id, fileName: asset.originalFileName, rating: null, canRate: false, edited: !!asset.isEdited },
  ]);
</script>

{#key asset.id}
  <RawDevelopEditor {photos} initialId={asset.id} onBack={() => onClose()} {onRendered} {onLegacy} />
{/key}
