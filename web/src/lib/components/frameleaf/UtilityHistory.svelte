<script lang="ts">
  /**
   * "Recent utility activity" under a utility (FL-69, UT-11), the template's `.um-history`
   * (UtilitiesManager.jsx:946-955, utilities-manager.css:399-415): a closed disclosure with the
   * latest eight entries of the one history every tool shares, each its title and when. The history
   * is the viewer's own recent utility jobs from the server (`recentUtilityActivity`), so it
   * survives reloads and never lists another account's work. Nothing is shown when there is none.
   */
  import type { ActivityItem } from '$lib/frameleaf/activity';
  import { recentUtilityActivity, UTILITY_HISTORY_FETCH } from '$lib/frameleaf/utility-history';
  import { searchMediaOperations } from '@immich/sdk';
  import { DateTime } from 'luxon';
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';

  let items = $state<ActivityItem[]>([]);

  let active = true;
  const load = async () => {
    try {
      const { items: operations } = await searchMediaOperations({
        take: UTILITY_HISTORY_FETCH,
        includeDismissed: true,
      });
      if (active) {
        items = recentUtilityActivity(operations);
      }
    } catch {
      // The history is a convenience: the tool itself works without it.
    }
  };

  onMount(() => {
    void load();
    return () => {
      active = false;
    };
  });

  const when = (item: ActivityItem) => DateTime.fromMillis(item.startedAt);
</script>

{#if items.length > 0}
  <details class="um-history">
    <summary>{$t('library_care_recent_activity')}</summary>
    {#each items as item (item.id)}
      <p>
        <span>{item.titleKey ? $t(item.titleKey) : item.title} · {$t(item.statusKey)}</span>
        <time datetime={when(item).toISO()}>{when(item).toLocaleString(DateTime.DATETIME_MED)}</time>
      </p>
    {/each}
  </details>
{/if}

<style>
  .um-history {
    margin-top: 24px;
    padding: 18px 0;
    border-top: 1px solid var(--fl-border);
  }
  .um-history summary {
    cursor: pointer;
    font-size: var(--fl-font-small, 0.75rem);
  }
  .um-history p {
    display: flex;
    justify-content: space-between;
    gap: 12px;
    margin: 0.375rem 0 0;
  }
  .um-history time {
    color: var(--fl-muted);
    font-size: var(--fl-font-micro, 0.625rem);
    white-space: nowrap;
  }
  @media (max-width: 640px) {
    .um-history p {
      flex-wrap: wrap;
    }
  }
</style>
