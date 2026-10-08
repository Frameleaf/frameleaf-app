<script lang="ts">
  /**
   * The library's empty state (FL-33), replacing the legacy `EmptyPlaceholder` "click to upload"
   * card. Ported from the prototype's two empty states: the timeline's `.tl-empty`
   * (`TimelineLibrary.jsx`, "No photos or videos in this view.") and the filtered grid's `.empty`
   * (`App.jsx`, "No matching media" with "Clear search and filters").
   *
   * It is the shared `EmptyState` with the library's own API and test id, so an empty library, an
   * empty panel and an empty list all say "nothing here" the same way: the icon in the logo's
   * frame, one sentence, and at most two ways forward.
   *
   * It says only that nothing is shown. It never counts what a filter, the Locked session or a
   * hidden person keeps out of view, so an empty page reveals nothing about those items.
   *
   * A brand-new library is the one empty state that leads somewhere: give it a `primary` action
   * ("Upload photos"), a `secondaryAction` and a `hint`. That state is one of the three places the
   * hero type step is used (BRAND.md), and it arrives on Reveal (one fade under Reduce Motion).
   */
  import EmptyState from '$lib/components/frameleaf/EmptyState.svelte';

  type Action = { label: string; onClick: () => void; icon?: string };
  type Props = {
    icon: string;
    /** A heading, when the state has one (the filtered grid's "No matching media"). */
    title?: string;
    message: string;
    action?: Action;
    /** Draw `action` as the filled primary button: the way forward out of a first-run state. */
    primary?: boolean;
    secondaryAction?: Action;
    /** A quiet last line, such as "or drop files anywhere". */
    hint?: string;
  };

  let { icon, title, message, action, primary = false, secondaryAction, hint }: Props = $props();

  // EmptyState fills its first action; an action that is not the way forward takes the quiet slot.
  const filled = $derived(primary ? action : undefined);
  const quiet = $derived(primary ? secondaryAction : (action ?? secondaryAction));
</script>

<div class="fl-library-empty fl-reveal" class:is-welcome={primary} data-testid="frameleaf-library-empty">
  <EmptyState {icon} {title} {message} action={filled} secondaryAction={quiet}>
    {#if hint}
      <p class="fl-library-empty-hint">{hint}</p>
    {/if}
  </EmptyState>
</div>

<style>
  .fl-library-empty.is-welcome {
    padding-block-start: max(var(--fl-space-4), 8vh);
  }
  /* The first-run title is the screen's one hero line; it steps down where it would wrap. */
  .fl-library-empty.is-welcome :global(h2) {
    margin-block: var(--fl-space-2) var(--fl-space-1);
    font: var(--fl-type-hero);
    letter-spacing: var(--fl-tracking-hero);
    text-wrap: balance;
  }
  @media (max-width: 700px) {
    .fl-library-empty.is-welcome :global(h2) {
      font: var(--fl-type-display);
      letter-spacing: var(--fl-tracking-display);
    }
  }
  .fl-library-empty-hint {
    margin: var(--fl-space-3) 0 0;
    color: var(--fl-muted);
    font: var(--fl-type-caption);
  }
</style>
