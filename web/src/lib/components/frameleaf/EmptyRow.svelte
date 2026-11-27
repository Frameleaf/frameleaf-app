<script lang="ts">
  /**
   * One empty section of a page that has other content (FL-1810, prototype `EmptyRow`): a quiet
   * dashed row with an icon, one line (and an optional second, smaller one) and at most one action.
   * The page keeps its layout. A whole empty page uses EmptyState instead.
   */
  import { ICON_SIZE } from '$lib/frameleaf/tokens';
  import { Icon } from '@frameleaf/ui';

  let {
    icon,
    title,
    message,
    action,
  }: {
    icon?: string;
    title: string;
    message?: string;
    /** The one way forward, if there is one. */
    action?: { label: string; onClick?: () => void; href?: string };
  } = $props();
</script>

<div class="fl-empty-row" role="status" data-testid="frameleaf-empty-row">
  {#if icon}<Icon {icon} size={ICON_SIZE.xl} aria-hidden />{/if}
  <span class="text">
    <strong>{title}</strong>
    {#if message}<small>{message}</small>{/if}
  </span>
  {#if action?.href}
    <a class="button" href={action.href} onclick={action.onClick}>{action.label}</a>
  {:else if action}
    <button type="button" class="button" onclick={action.onClick}>{action.label}</button>
  {/if}
</div>

<style>
  .fl-empty-row {
    display: flex;
    align-items: center;
    gap: var(--fl-space-4);
    padding: var(--fl-space-4);
    border: 1px dashed var(--fl-border);
    border-radius: var(--fl-radius-card);
    color: var(--fl-muted);
  }
  .text {
    display: grid;
    gap: var(--fl-space-1);
    flex: 1;
    min-width: 0;
  }
  strong {
    color: var(--fl-text);
    font: 600 var(--fl-font-callout) / 1.3 var(--fl-family-ui);
    overflow-wrap: anywhere;
  }
  small {
    font: var(--fl-type-caption);
    line-height: 1.5;
  }
  .button {
    flex: none;
    min-height: 44px;
    text-decoration: none;
  }
  @media (max-width: 560px) {
    .fl-empty-row {
      flex-wrap: wrap;
    }
  }
</style>
