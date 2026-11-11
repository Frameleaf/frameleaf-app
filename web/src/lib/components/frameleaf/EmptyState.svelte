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
   * A full-size empty state has no photographs on screen, so its icon sits on a soft accent plate
   * and fades in once. The compact form, used inside panels beside content, stays plain.
   *
   * FL-1412 (M13): every empty page is this one pattern, with the prototype's measurements
   * (`src/EmptyState.jsx`, `.fl-empty`): a 48px plate, 8px between the lines, 12px above the
   * actions. A page that shows it shows no toolbar and no Thumbnail size bar. A card that holds it
   * (the Map's) sets `--fl-empty-padding`.
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
      <span class="icon framed" aria-hidden="true"><Icon {icon} size="24" /></span>
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
    padding: var(--fl-empty-padding, 56px var(--fl-space-6));
    color: var(--fl-muted);
    font: var(--fl-type-body);
    text-align: center;
  }
  @media (max-width: 767px) {
    .fl-empty-state {
      padding: var(--fl-empty-padding, 40px var(--fl-space-4));
    }
  }
  .fl-empty-state.compact {
    padding: var(--fl-space-6) var(--fl-space-4);
  }
  .icon {
    display: inline-flex;
    margin-bottom: var(--fl-space-1);
  }
  /* Written here rather than with the base.css classes so it holds wherever the component mounts. */
  .icon.framed {
    display: inline-grid;
    place-items: center;
    width: 48px;
    height: 48px;
    margin-bottom: var(--fl-space-2);
    color: var(--fl-accent);
    border-radius: var(--fl-radius-card);
    background: var(--fl-accent-soft);
    animation: fl-fade-in var(--fl-motion-slow) var(--fl-ease) both;
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
    /* A title can quote what was typed ("No folders match …"). */
    overflow-wrap: anywhere;
  }
  h2,
  p {
    max-width: 44ch;
  }
  p {
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
