<script lang="ts">
  import { creatorAvatarUrl, creatorInitials } from '$lib/frameleaf/creators';

  /** A creator's picture as the Library kept it, or their initials when the site gave none. */
  let { creator, size = 28 }: { creator: { id?: string; name: string; hasAvatar?: boolean }; size?: number } = $props();
  let broken = $state(false);
  const picture = $derived(creator.id && creator.hasAvatar && !broken ? creatorAvatarUrl(creator.id) : undefined);
</script>

{#if picture}
  <img
    class="cr-avatar"
    src={picture}
    alt=""
    width={size}
    height={size}
    style:width="{size}px"
    style:height="{size}px"
    loading="lazy"
    onerror={() => (broken = true)}
  />
{:else}
  <span class="cr-avatar initials" style:width="{size}px" style:height="{size}px" style:font-size="{size * 0.4}px"
    >{creatorInitials(creator.name)}</span
  >
{/if}

<style>
  .cr-avatar {
    /* Always the square asked for: never squeezed or stretched by the row it sits in. */
    flex: none;
    box-sizing: border-box;
    min-width: 0;
    max-width: none;
    aspect-ratio: 1;
    border-radius: 50%;
    object-fit: cover;
    background: var(--fl-raised);
  }
  .initials {
    display: inline-grid;
    place-items: center;
    color: var(--fl-muted);
    font-weight: 600;
    line-height: 1;
    user-select: none;
  }
</style>
