<script lang="ts">
  import ImageThumbnail from '$lib/components/assets/thumbnail/ImageThumbnail.svelte';
  import { getPeopleThumbnailUrl } from '$lib/utils';
  import type { PersonResponseDto } from '@immich/sdk';
  /** Pass only currently authorized evidence. Clear on lock, account change or revocation. */
  let { person }: { person?: PersonResponseDto } = $props();
</script>

{#if person}
  {#key person.id + person.updatedAt}
    <span class="avatar" aria-hidden="true">
      <ImageThumbnail url={getPeopleThumbnailUrl(person)} altText="" widthStyle="100%" circle />
    </span>
  {/key}
{/if}

<style>
  .avatar {
    display: inline-flex;
    width: 1.5rem;
    height: 1.5rem;
    overflow: hidden;
    border-radius: 50%;
    flex-shrink: 0;
  }
</style>
