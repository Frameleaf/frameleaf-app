<script lang="ts">
  import type { FaceBox } from '$lib/frameleaf/people';

  /**
   * A squircle crop of one face (FL-37; apple-style.css:137-148 masks every people photo), ported from `FaceCrop` in
   * design/frameleaf/template/src/People.jsx:130-170: the image is scaled so the face box
   * fills the shape and translated so the box centre sits in the middle, keeping the
   * source aspect ratio. Without a usable box it shows the whole image, cropped to cover.
   */
  interface Props {
    src: string;
    box?: FaceBox | null;
    size?: number;
    alt?: string;
  }

  let { src, box, size = 64, alt = '' }: Props = $props();

  const valid = $derived(!!box && box.width > 0 && box.height > 0);
  const centreX = $derived(box ? (box.x + box.width / 2) * 100 : 50);
  const centreY = $derived(box ? (box.y + box.height / 2) * 100 : 50);
</script>

<span
  class="face-crop fl-squircle"
  class:plain={!valid}
  style:width="{size}px"
  style:height="{size}px"
  role={alt ? 'img' : undefined}
  aria-label={alt || undefined}
  aria-hidden={alt ? undefined : true}
>
  {#if valid && box}
    <img
      {src}
      alt=""
      loading="lazy"
      draggable="false"
      style:width="{Math.min(100 / box.width, 2500)}%"
      style:transform="translate(-{centreX}%, -{centreY}%)"
    />
  {:else}
    <img {src} alt="" loading="lazy" draggable="false" />
  {/if}
</span>

<style>
  /* template/src/people.css `.pp-face-crop`. */
  .face-crop {
    position: relative;
    display: inline-block;
    flex-shrink: 0;
    overflow: hidden;
    background: var(--fl-raised);
    border: 1px solid var(--fl-border);
  }
  .face-crop img {
    position: absolute;
    top: 50%;
    left: 50%;
    display: block;
    max-width: none;
    height: auto;
  }
  .face-crop.plain img {
    inset: 0;
    width: 100%;
    height: 100%;
    object-fit: cover;
    object-position: 50% 40%;
  }
</style>
