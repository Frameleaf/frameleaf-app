<script lang="ts">
  /**
   * The library's empty state (FL-33), replacing the legacy `EmptyPlaceholder` "click to upload"
   * card. Ported from the prototype's two empty states: the timeline's `.tl-empty`
   * (`TimelineLibrary.jsx`, "No photos or videos in this view.") and the filtered grid's `.empty`
   * (`App.jsx`, "No matching media" with "Clear search and filters").
   *
   * It says only that nothing is shown. It never counts what a filter, the Locked session or a
   * hidden person keeps out of view, so an empty page reveals nothing about those items.
   */
  import Button from '$lib/components/frameleaf/Button.svelte';
  import { Icon } from '@immich/ui';

  type Props = {
    icon: string;
    /** A heading, when the state has one (the filtered grid's "No matching media"). */
    title?: string;
    message: string;
    action?: { label: string; onClick: () => void };
  };

  let { icon, title, message, action }: Props = $props();
</script>

<div class="fl-empty" role="status" data-testid="frameleaf-library-empty">
  <Icon {icon} size={title ? '36' : '30'} aria-hidden />
  {#if title}
    <h2>{title}</h2>
  {/if}
  <p>{message}</p>
  {#if action}
    <Button onclick={action.onClick}>{action.label}</Button>
  {/if}
</div>

<style>
  /* Template styles.css `.empty` and timeline-library.css `.tl-empty`. */
  .fl-empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    padding: 45px 12px;
    color: var(--fl-muted);
    font-size: var(--fl-font-small, 13px);
    text-align: center;
  }
  h2 {
    margin: 12px 0 0;
    color: var(--fl-text);
    font-size: 18px;
    font-weight: 600;
  }
  p {
    margin: 0 0 8px;
  }
</style>
