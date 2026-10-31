<script lang="ts">
  import { tagDotColor } from '$lib/frameleaf/tag-tree';

  /** A tag's colour as a dot. Decorative: the tag's name is always beside it. */
  let { color }: { color: string | null | undefined } = $props();
</script>

<span class="tag-dot" style:--tag-color={tagDotColor(color)} aria-hidden="true"></span>

<style>
  .tag-dot {
    display: inline-block;
    flex-shrink: 0;
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: var(--tag-color);
  }
</style>
