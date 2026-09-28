<script lang="ts">
  import ImageThumbnail from '$lib/components/assets/thumbnail/ImageThumbnail.svelte';
  import { getAssetMediaUrl } from '$lib/utils';
  import { AssetMediaSize } from '@immich/sdk';
  import { Icon } from '@immich/ui';
  import { mdiPawOutline } from '@mdi/js';

  /**
   * A pet's featured photo (FL-58).
   *
   * Pets have no cropped face file of their own: `PersonAvatar` reads a person thumbnail
   * the facial-recognition job wrote, and no equivalent job exists for pets. The featured
   * photo is therefore an ordinary asset thumbnail, requested through the same
   * authorized media URL as every other thumbnail, and a pet with no featured photo gets
   * a plain mark rather than a borrowed image. Like every people photo it is a squircle
   * (apple-style.css:137-148; the people grid is the prototype pattern pets follow).
   */
  let {
    assetId,
    cacheKey,
    size = 160,
    alt = '',
  }: { assetId?: string | null; cacheKey?: string | null; size?: number; alt?: string } = $props();
</script>

<span class="pet-thumb fl-squircle" style:width="{size}px" style:height="{size}px">
  {#if assetId}
    {#key assetId + (cacheKey ?? '')}
      <ImageThumbnail
        url={getAssetMediaUrl({ id: assetId, size: AssetMediaSize.Thumbnail, cacheKey })}
        altText={alt}
        widthStyle="100%"
      />
    {/key}
  {:else}
    <span class="placeholder" aria-hidden="true">
      <Icon icon={mdiPawOutline} size={String(Math.round(size / 2.5))} />
    </span>
  {/if}
</span>

<style>
  .pet-thumb {
    display: inline-flex;
    flex-shrink: 0;
    overflow: hidden;
    background: var(--fl-raised);
  }
  .placeholder {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 100%;
    height: 100%;
    color: var(--fl-muted);
  }
</style>
