<script lang="ts">
  import AlbumIcon from '$lib/components/frameleaf/AlbumIcon.svelte';
  import { defaultIconFor } from '$lib/frameleaf/album-directory';
  import { albumColorSpec } from '$lib/frameleaf/album-tree';

  /**
   * An album's or collection's own icon in its own colour (prototype `CollectionMark`), or the plain
   * look when it has neither. Used by the rail, Albums, the collection cards and every picker, so a
   * collection looks the same wherever it is chosen. Decorative: the name always sits beside it.
   */
  interface Props {
    icon: string | null | undefined;
    color?: string | null;
    kind?: string;
    /** A collection with albums inside draws the stacked folder when it has no icon of its own. */
    hasChildren?: boolean;
    size?: string | number;
    class?: string;
  }

  let { icon, color, kind, hasChildren = false, size = '1.25em', class: className = '' }: Props = $props();

  const spec = $derived(albumColorSpec(color));
  // Without a kind the icon's own default (the plain folder) shows, as the rail always drew it.
  const name = $derived(icon ?? (hasChildren ? 'mdiFolderMultipleOutline' : kind ? defaultIconFor(kind) : null));
</script>

<span
  class="album-mark {className}"
  class:colored={!!spec}
  data-color={spec?.id}
  style={spec ? `--mark-light: ${spec.light}; --mark-dark: ${spec.dark};` : undefined}
  aria-hidden="true"
>
  <AlbumIcon {name} {size} />
</span>

<style>
  .album-mark {
    display: inline-flex;
    flex-shrink: 0;
    align-items: center;
    justify-content: center;
    line-height: 0;
  }
  .album-mark.colored {
    color: var(--mark-light);
  }
  :global([data-theme='dark']) .album-mark.colored {
    color: var(--mark-dark);
  }
</style>
