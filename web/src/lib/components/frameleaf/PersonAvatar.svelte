<script lang="ts">
  import ImageThumbnail from '$lib/components/assets/thumbnail/ImageThumbnail.svelte';
  import { getPeopleThumbnailUrl } from '$lib/utils';
  import type { PersonResponseDto } from '@frameleaf/sdk';
  /**
   * Pass only currently authorized evidence. Clear on lock, account change or revocation.
   * `size` defaults to the 24px chip/picker size; the People grid and person page pass a
   * larger value for the face photograph, per the September 22 revision. Every people photo
   * is a squircle (apple-style.css:137-148): the global `fl-squircle` mask in app.css.
   *
   * `fluid` lets the face shrink with a narrow column: `size` becomes the most it grows to and the
   * parent sets the width. `heroKey` marks it as one end of a card-to-page Hero pairing
   * (`data-fl-shared`, $lib/frameleaf/motion heroNavigation); `heroPage` marks the end that is the
   * page the card opens.
   */
  let {
    person,
    size = 24,
    fluid = false,
    heroKey,
    heroPage = false,
    onUnavailable,
  }: {
    person?: PersonResponseDto;
    size?: number;
    fluid?: boolean;
    heroKey?: string;
    heroPage?: boolean;
    onUnavailable?: () => void;
  } = $props();
</script>

{#if person}
  {#key person.id + person.updatedAt}
    <span
      class="avatar fl-squircle"
      class:fluid
      style:width={fluid ? undefined : `${size}px`}
      style:height={fluid ? undefined : `${size}px`}
      style:max-width={fluid ? `${size}px` : undefined}
      data-fl-shared={heroKey}
      data-fl-shared-page={heroKey && heroPage ? '' : undefined}
      aria-hidden="true"
    >
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
  .avatar.fluid {
    width: 100%;
    aspect-ratio: 1;
  }
</style>
