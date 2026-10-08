<script lang="ts">
  /**
   * The earlier empty placeholder, redrawn in the Frameleaf empty-state pattern (an icon, an
   * optional heading, one sentence) so the pages that still use it match the rest of the app.
   * New code uses `$lib/components/frameleaf/EmptyState.svelte`, which also offers actions.
   *
   * It reads the brand tokens from the document root, so it works inside or outside a
   * `.frameleaf` scope. With `onClick` the whole card is one button.
   */
  import { ICON_SIZE } from '$lib/frameleaf/tokens';
  import { Icon } from '@frameleaf/ui';
  import { mdiImageMultipleOutline } from '@mdi/js';

  interface Props {
    onClick?: undefined | (() => unknown);
    text: string;
    fullWidth?: boolean;
    /** An illustration to show instead of the icon. */
    src?: string;
    title?: string;
    class?: string;
  }

  let { onClick = undefined, text, fullWidth = false, src, title, class: className = '' }: Props = $props();
</script>

<svelte:element
  this={onClick ? 'button' : 'div'}
  type={onClick ? 'button' : undefined}
  role={onClick ? undefined : 'status'}
  onclick={onClick}
  class="fl-empty-placeholder {className}"
  class:full={fullWidth}
  class:action={!!onClick}
>
  {#if src}
    <img {src} alt="" width="240" draggable="false" />
  {:else}
    <span class="icon" aria-hidden="true"><Icon icon={mdiImageMultipleOutline} size={ICON_SIZE.hero} /></span>
  {/if}

  {#if title}
    <h2>{title}</h2>
  {/if}
  <p>{text}</p>
</svelte:element>

<style>
  .fl-empty-placeholder {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: var(--fl-space-2);
    width: 50%;
    padding: var(--fl-space-12) var(--fl-space-4);
    color: var(--fl-muted);
    font: var(--fl-type-body);
    text-align: center;
    border: 1px solid transparent;
    border-radius: var(--fl-radius-card);
  }
  .full {
    width: 100%;
  }
  .action {
    cursor: pointer;
    border-color: var(--fl-border);
    transition: background-color var(--fl-motion-fast) var(--fl-ease);
  }
  .action:hover {
    background: var(--fl-raised);
  }
  .action:focus-visible {
    outline: var(--fl-focus-ring);
    outline-offset: var(--fl-focus-offset);
  }
  .icon {
    display: inline-flex;
  }
  h2 {
    margin: 0;
    font: var(--fl-type-headline);
    letter-spacing: var(--fl-tracking-headline);
    color: var(--fl-text);
  }
  p {
    max-width: 28rem;
    margin: 0;
  }
  @media (max-width: 767px) {
    .fl-empty-placeholder {
      width: 100%;
    }
  }
</style>
