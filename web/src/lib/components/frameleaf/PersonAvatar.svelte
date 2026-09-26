<script lang="ts">
  import ImageThumbnail from '$lib/components/assets/thumbnail/ImageThumbnail.svelte';
  import { getPeopleThumbnailUrl } from '$lib/utils';
  import type { PersonResponseDto } from '@immich/sdk';
  /**
   * Pass only currently authorized evidence. Clear on lock, account change or revocation.
   * `size` defaults to the 24px chip/picker size; the People grid and person page pass a
   * larger value for the face photograph, per the September 22 revision. Every people photo
   * is a squircle (apple-style.css:137-148): the global `fl-squircle` mask in app.css.
   */
  let {
    person,
    size = 24,
    onUnavailable,
  }: { person?: PersonResponseDto; size?: number; onUnavailable?: () => void } = $props();
</script>

{#if person}
  {#key person.id + person.updatedAt}
    <span class="avatar fl-squircle" style:width="{size}px" style:height="{size}px" aria-hidden="true">
      <ImageThumbnail
        url={getPeopleThumbnailUrl(person)}
        altText=""
        widthStyle="100%"
        onComplete={(errored) => {
          if (errored) {
            onUnavailable?.();
          }
        }}
      />
    </span>
  {/key}
{/if}

<style>
  .avatar {
    display: inline-flex;
    overflow: hidden;
    flex-shrink: 0;
  }
</style>
