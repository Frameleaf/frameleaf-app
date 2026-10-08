<script lang="ts">
  /**
   * The empty state for any Frameleaf surface: an icon, an optional heading, one sentence, and up
   * to two ways forward. It generalises LibraryEmptyState (which keeps its own test id and API) so
   * panels, lists and whole pages say "nothing here yet" the same way.
   *
   * It says only that nothing is shown. Never count what a filter, the Locked session or a hidden
   * person keeps out of view. A first-run empty state should lead with the action that fills it
   * ("Upload photos"); a filtered one with the action that clears the filter.
   *
   * `children` renders under the actions, for a hint such as "or drop files anywhere".
   *
   * A full-size empty state is a moment with no photographs on screen, so it carries the brand:
   * the icon sits in the logo's frame, drawn in the brand gradient, and unfurls once (BRAND.md
   * decisions 3 and 6). The compact form, used inside panels beside content, stays plain.
   */
  import { ICON_SIZE } from '$lib/frameleaf/tokens';
  import { Icon } from '@frameleaf/ui';
  import type { Snippet } from 'svelte';

  type Action = { label: string; onClick?: () => void; href?: string; icon?: string };

  let {
    icon,
    title,
    message,
    action,
    secondaryAction,
    compact = false,
    children,
  }: {
    icon?: string;
    title?: string;
    message: string;
    /** The one primary way forward. */
    action?: Action;
    secondaryAction?: Action;
    /** Tighter padding for a panel or a card rather than a page. */
    compact?: boolean;
    children?: Snippet;
  } = $props();
</script>

{#snippet control(item: Action, primary: boolean)}
  {#if item.href}
    <a class="button" class:primary href={item.href} onclick={item.onClick}>
      {#if item.icon}<Icon icon={item.icon} size={ICON_SIZE.md} aria-hidden />{/if}
      {item.label}
    </a>
  {:else}
    <button type="button" class="button" class:primary onclick={item.onClick}>
      {#if item.icon}<Icon icon={item.icon} size={ICON_SIZE.md} aria-hidden />{/if}
      {item.label}
    </button>
  {/if}
{/snippet}

<div class="fl-empty-state" class:compact role="status" data-testid="frameleaf-empty-state">
  {#if icon}
    {#if compact}
      <span class="icon" aria-hidden="true"><Icon {icon} size={ICON_SIZE.hero} /></span>
    {:else}
      <span class="icon framed" aria-hidden="true"><Icon {icon} size={ICON_SIZE.hero} /></span>
    {/if}
  {/if}
  {#if title}<h2>{title}</h2>{/if}
  <p>{message}</p>
  {#if action || secondaryAction}
    <div class="actions">
      {#if action}{@render control(action, true)}{/if}
      {#if secondaryAction}{@render control(secondaryAction, false)}{/if}
    </div>
  {/if}
  {@render children?.()}
</div>

<style>
  .fl-empty-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--fl-space-2);
    padding: var(--fl-space-12) var(--fl-space-4);
    color: var(--fl-muted);
    font: var(--fl-type-body);
    text-align: center;
  }
  .compact {
    padding-block: var(--fl-space-6);
  }
  .icon {
    display: inline-flex;
    margin-bottom: var(--fl-space-1);
  }
  /*
   * The logo's frame, drawn in the brand gradient as a hairline with nothing inside it, and the
   * Unfurl signature. Written here rather than with the base.css classes so they hold wherever the
   * component is mounted, and so the frame can be hollow over any surface.
   */
  .icon.framed {
    position: relative;
    display: inline-grid;
    place-items: center;
    width: 3.5rem;
    height: 3.5rem;
    margin-bottom: var(--fl-space-2);
    color: var(--fl-text);
    border-radius: 27%;
    transform-origin: bottom left;
    animation:
      fl-fade-in var(--fl-duration-reduced) var(--fl-ease) both,
      fl-unfurl-in var(--fl-duration-unfurl) var(--fl-unfurl) both;
  }
  .icon.framed::before {
    content: '';
    position: absolute;
    inset: 0;
    padding: 1.5px;
    background: var(--fl-brand-gradient);
    border-radius: inherit;
    -webkit-mask:
      linear-gradient(black 0 0) content-box,
      linear-gradient(black 0 0);
    -webkit-mask-composite: xor;
    mask-composite: exclude;
    mask:
      linear-gradient(black 0 0) content-box exclude,
      linear-gradient(black 0 0);
    pointer-events: none;
  }
  .icon.framed:dir(rtl) {
    transform-origin: bottom right;
    animation-name: fl-fade-in, fl-unfurl-in-rtl;
  }
  @media (prefers-reduced-motion: reduce) {
    .icon.framed {
      animation: fl-fade-in var(--fl-duration-reduced) var(--fl-ease) both !important;
    }
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
  .actions {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: var(--fl-space-2);
    margin-top: var(--fl-space-3);
  }
  a.button {
    min-height: var(--fl-control-height);
    text-decoration: none;
  }
  @media (pointer: coarse) {
    a.button {
      min-height: var(--fl-control-height-touch);
    }
  }
</style>
