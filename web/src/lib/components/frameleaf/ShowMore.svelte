<script lang="ts">
  /**
   * Show more, with the cumulative "Showing n of m" summary beneath the results (FL-33).
   *
   * Paging is cumulative: Show more raises the page count, it never replaces the page, so the
   * summary counts everything on screen rather than a range. The numbers come from FL-31's
   * `discoveryPageSummary`; this component only draws them and asks the host to load the next page.
   */
  import type { LibrarySessionStore } from '$lib/frameleaf/library-session.svelte';
  import { t } from 'svelte-i18n';

  type Props = {
    session: LibrarySessionStore;
    /** Load the next page. Called after the session's page count is raised. */
    onShowMore?: (page: number) => void;
    loading?: boolean;
  };

  let { session, onShowMore, loading = false }: Props = $props();

  const summary = $derived(session.pageSummary);

  const showMore = () => {
    const next = session.showMore();
    onShowMore?.(next.page);
  };
</script>

<div class="fl-show-more" data-testid="frameleaf-show-more">
  <p class="fl-show-more-summary" role="status">
    {$t(summary.key, { values: summary.values })}
  </p>
  {#if summary.hasMore}
    <button type="button" class="fl-show-more-button" disabled={loading} onclick={showMore}>
      {$t('frameleaf_library_show_more')}
    </button>
  {/if}
</div>

<style>
  .fl-show-more {
    display: grid;
    justify-items: center;
    gap: 8px;
    padding: 16px 0 32px;
  }
  .fl-show-more-summary {
    margin: 0;
    color: var(--fl-muted);
    font-size: var(--fl-font-small, 12px);
  }
  .fl-show-more-button {
    padding: 0 16px;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius);
    background: var(--fl-raised);
    color: var(--fl-text);
    font-size: var(--fl-font-size, 14px);
  }
  .fl-show-more-button:disabled {
    color: var(--fl-muted);
  }
</style>
