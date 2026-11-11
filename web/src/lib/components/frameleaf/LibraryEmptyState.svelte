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
   * ("Add photos") and a `secondaryAction`. FL-1412 (M13): it is the same pattern as every other
   * empty page, so it has no larger title and no third line.
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
  };

  let { icon, title, message, action, primary = false, secondaryAction }: Props = $props();

  // EmptyState fills its first action; an action that is not the way forward takes the quiet slot.
  const filled = $derived(primary ? action : undefined);
  const quiet = $derived(primary ? secondaryAction : (action ?? secondaryAction));
</script>

<div class="fl-library-empty fl-reveal" data-testid="frameleaf-library-empty">
  <EmptyState {icon} {title} {message} action={filled} secondaryAction={quiet} />
</div>
