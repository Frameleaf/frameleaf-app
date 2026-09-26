<script lang="ts">
  import { page } from '$app/state';
  import {
    DISCOVERY_QUERY_PARAMETER,
    discoveryUrl,
    parseDiscoveryQueryText,
    type DiscoveryQuery,
  } from '$lib/components/discovery/query';
  import { fromSavedSearch } from '$lib/frameleaf/search-palette';
  import '$lib/frameleaf/tokens.css';
  import { savedSearchesStore } from '$lib/stores/saved-searches.svelte';
  import { Icon } from '@immich/ui';
  import { mdiClose, mdiFilterOutline } from '@mdi/js';
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';

  /**
   * The rail's saved searches (FL-49, S-14). Ported from the prototype's rail presets
   * (`LibraryRail.jsx` `presets.map(...)`: nested links under the library section, a filter icon for a
   * filter preset). Saved searches are the account's `savedSearches` preference (`savedSearchesStore`),
   * read from the server and dropped on every access change, so a search that names a Locked person,
   * pet or tag is never listed while the session is locked.
   *
   * It is exported for the rail to mount (the shell owns `LibraryRail.svelte`); it renders nothing
   * until there is a saved search, and in the icon-only rail each link is named by its title.
   */
  let { iconOnly = false }: { iconOnly?: boolean } = $props();

  onMount(() => {
    void savedSearchesStore.load();
  });

  const entries = $derived(
    savedSearchesStore.list.flatMap((item) => {
      const query = fromSavedSearch(item);
      return query ? [{ name: item.name, query, href: discoveryUrl(query) }] : [];
    }),
  );

  /** The saved search the results page is showing, if any. */
  const currentQuery = $derived.by(() => {
    if (!/^\/search(?:\/|$)/.test(page.url.pathname)) {
      return undefined;
    }
    const raw = page.url.searchParams.get(DISCOVERY_QUERY_PARAMETER);
    const parsed = raw ? parseDiscoveryQueryText(raw) : undefined;
    return parsed?.ok ? JSON.stringify(parsed.query) : undefined;
  });
  const isCurrent = (query: DiscoveryQuery) => currentQuery === JSON.stringify(query);
</script>

{#if entries.length > 0}
  <div class="frameleaf-saved-searches" role="group" aria-label={$t('frameleaf_search_saved_searches')}>
    {#each entries as entry (entry.name)}
      {@const current = isCurrent(entry.query)}
      <div class="row">
        <a
          href={entry.href}
          class="fl-link"
          class:fl-nested={!iconOnly}
          class:fl-icon-only={iconOnly}
          class:fl-current={current}
          aria-current={current ? 'page' : undefined}
          title={iconOnly ? entry.name : undefined}
          aria-label={iconOnly ? entry.name : undefined}
        >
          <Icon icon={mdiFilterOutline} size="1.25em" aria-hidden={true} class="fl-icon" />
          {#if !iconOnly}<span class="fl-label">{entry.name}</span>{/if}
        </a>
        {#if !iconOnly}
          <button
            type="button"
            class="remove"
            aria-label={$t('frameleaf_search_delete_saved', { values: { name: entry.name } })}
            onclick={() => void savedSearchesStore.remove(entry.name)}
          >
            <Icon icon={mdiClose} size="0.875em" aria-hidden={true} />
          </button>
        {/if}
      </div>
    {/each}
  </div>
{/if}

<style>
  /* The rail's link look (LibraryRail.svelte .fl-link), so the list sits in the rail unchanged. */
  .row {
    position: relative;
    display: flex;
    align-items: center;
  }
  .fl-link {
    display: flex;
    flex: 1;
    min-width: 0;
    align-items: center;
    gap: 11px;
    min-height: 34px;
    padding: 7px 22px;
    border-radius: var(--fl-radius);
    color: var(--fl-text);
    text-decoration: none;
  }
  .fl-link:hover {
    background: var(--fl-raised);
  }
  .fl-current,
  .fl-current:hover {
    background: color-mix(in srgb, var(--fl-accent), var(--fl-panel) 86%);
    box-shadow: inset 3px 0 var(--fl-accent);
  }
  .fl-nested {
    padding-inline-start: 42px;
  }
  .fl-icon-only {
    justify-content: center;
    min-height: 36px;
    padding: 8px 0;
  }
  .fl-label {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .remove {
    position: absolute;
    inset-inline-end: 0.25rem;
    display: grid;
    place-items: center;
    width: 28px;
    height: 28px;
    border: 0;
    border-radius: var(--fl-radius);
    background: transparent;
    color: var(--fl-muted);
    opacity: 0;
  }
  .row:hover .remove,
  .remove:focus-visible {
    opacity: 1;
  }
  @media (hover: none) {
    .remove {
      opacity: 1;
    }
  }
  .remove:hover {
    background: var(--fl-raised);
    color: var(--fl-text);
  }
</style>
