<script lang="ts">
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import DuplicateUtility from '$lib/components/frameleaf/DuplicateUtility.svelte';
  import LargeFilesUtility from '$lib/components/frameleaf/LargeFilesUtility.svelte';
  import LivePhotosUtility from '$lib/components/frameleaf/LivePhotosUtility.svelte';
  import GeolocationUtility from '$lib/components/frameleaf/GeolocationUtility.svelte';
  import ICloudSyncPanel from '$lib/components/frameleaf/ICloudSyncPanel.svelte';
  import LibraryCareHealth from '$lib/components/frameleaf/LibraryCareHealth.svelte';
  import { UTILITY_GROUPS, utilityTool, utilityToolsFor, type UtilityId } from '$lib/frameleaf/utilities';
  import { loadUtility, type UtilityData } from '$lib/frameleaf/utilities-load';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { Icon } from '@immich/ui';
  import { mdiChevronRight } from '@mdi/js';
  import { untrack } from 'svelte';
  import { t } from 'svelte-i18n';

  let { query = '', onNavigate }: { query?: string; onNavigate?: () => void } = $props();
  const tools = $derived(utilityToolsFor(authManager.user.isAdmin));
  const requestedStatus = $derived(page.url.searchParams.get('status'));
  const selected = $derived(utilityTool(page.url.searchParams.get('section')));
  const denied = $derived(selected?.adminOnly && !authManager.user.isAdmin);
  const matches = $derived(
    tools.filter((tool) =>
      `${$t(tool.titleKey)} ${$t(tool.descriptionKey)}`.toLowerCase().includes(query.trim().toLowerCase()),
    ),
  );
  let data = $state<UtilityData | null>(null);
  let failed = $state(false);
  let retry = $state(0);

  $effect(() => {
    const tool = selected;
    const isAdmin = authManager.user.isAdmin;
    const status = requestedStatus;
    void retry;
    data = null;
    failed = false;
    if (!tool || (tool.adminOnly && !isAdmin) || query.trim()) return;
    let active = true;
    const url = untrack(() => new URL(page.url));
    if (status) url.searchParams.set('status', status);
    void loadUtility(tool.id, url, isAdmin)
      .then((result) => {
        if (active) data = result;
      })
      .catch(() => {
        if (active) failed = true;
      });
    return () => {
      active = false;
    };
  });

  const select = (section?: UtilityId) => {
    onNavigate?.();
    const url = new URL(page.url);
    for (const key of ['section', 'assetId', 'status', 'at', 'index']) url.searchParams.delete(key);
    if (section) url.searchParams.set('section', section);
    return goto(`${url.pathname}${url.search}`, { noScroll: true, keepFocus: true });
  };
</script>

<header class="heading">
  <p class="overline">
    {#if selected && !query.trim()}
      <button type="button" onclick={() => select()}>{$t('utilities')}</button>
      <Icon icon={mdiChevronRight} size="0.875rem" aria-hidden={true} />
      {$t(selected.titleKey)}
    {:else}
      {$t('frameleaf_settings_group_library')}
    {/if}
  </p>
  <h1>{selected && !query.trim() ? $t(selected.titleKey) : $t('utilities')}</h1>
  <p>{selected && !query.trim() ? $t(selected.descriptionKey) : $t('frameleaf_utilities_description')}</p>
</header>

{#if denied}
  <p role="alert">{$t('frameleaf_utilities_admin_required')}</p>
{:else if !selected || query.trim()}
  <div class="directory">
    {#each UTILITY_GROUPS as group (group)}
      {@const groupTools = matches.filter((tool) => tool.group === group)}
      {#if groupTools.length}
        <section>
          <h2>{$t(`library_care_group_${group}`)}</h2>
          <div class="directory-list">
            {#each groupTools as tool (tool.id)}
              <button type="button" onclick={() => select(tool.id)}>
                <Icon icon={tool.icon} size="1.125rem" aria-hidden={true} />
                <span
                  ><strong>{$t(tool.titleKey)}</strong><span>{$t(tool.descriptionKey)}</span><small
                    >{$t('frameleaf_utilities_resource_settings')}</small
                  ></span
                >
                <Icon icon={mdiChevronRight} size="1.125rem" aria-hidden={true} />
              </button>
            {/each}
          </div>
        </section>
      {/if}
    {/each}
    {#if matches.length === 0}<p role="status">{$t('frameleaf_settings_search_empty', { values: { query } })}</p>{/if}
  </div>
{:else if failed}
  <div role="alert">
    <p>{$t('frameleaf_utilities_load_error')}</p>
    <button type="button" onclick={() => retry++}>{$t('retry')}</button>
  </div>
{:else if data}
  {#key data}
    <div class="tool">
      {#if data.tool === 'duplicates'}<DuplicateUtility {data} />
      {:else if data.tool === 'large-files'}<LargeFilesUtility {data} />
      {:else if data.tool === 'live-photos'}<LivePhotosUtility {data} />
      {:else if data.tool === 'geolocation'}<GeolocationUtility />
      {:else if data.tool === 'icloud'}<ICloudSyncPanel initial={data.initial} />
      {:else if data.tool === 'missing-media' || data.tool === 'corrupt-media'}
        <LibraryCareHealth
          category={data.category}
          initial={data.mediaHealth}
          initialSummary={data.summary}
          initialStatus={data.status}
          roots={data.roots}
          users={data.users}
        />
      {/if}
    </div>
  {/key}
{:else}<p role="status">{$t('loading')}</p>{/if}

<style>
  .heading {
    margin: 0 0 1.25rem;
  }
  .heading h1 {
    margin: 0;
    font-size: 1.75rem;
    font-weight: 550;
    letter-spacing: -0.02em;
  }
  .heading > p:last-child {
    margin: 0.5rem 0 0;
    color: var(--fl-muted);
    font-size: 0.75rem;
    line-height: 1.6;
  }
  .overline {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin: 0 0 0.5rem;
    color: var(--fl-muted);
    font-size: 0.625rem;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }
  .overline button {
    border: 0;
    padding: 0;
    background: none;
    color: inherit;
    font: inherit;
    text-transform: inherit;
  }
  .overline button:hover {
    color: var(--fl-accent);
  }
  .directory {
    display: grid;
    gap: 1.75rem;
    margin: 1.375rem 0 2rem;
  }
  .directory section > h2 {
    font-size: 0.75rem;
    color: var(--fl-muted);
    font-weight: 500;
    margin: 0 0 0.625rem;
  }
  .directory-list {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 0.625rem;
  }
  .directory-list button {
    display: flex;
    align-items: center;
    gap: 0.875rem;
    padding: 1.25rem;
    text-align: left;
    border: 1px solid var(--fl-border);
    border-radius: 0.25rem;
    background: var(--fl-panel);
    color: var(--fl-text);
  }
  .directory-list button:hover {
    background: var(--fl-raised);
    border-color: color-mix(in srgb, var(--fl-muted) 60%, var(--fl-border));
  }
  .directory-list button > :global(svg:first-child) {
    color: var(--fl-muted);
    align-self: flex-start;
    margin-top: 1px;
  }
  .directory-list button > :global(svg:last-child) {
    margin-left: auto;
    flex-shrink: 0;
    color: var(--fl-muted);
  }
  .directory-list button > span {
    min-width: 0;
  }
  .directory-list strong {
    display: block;
    font-size: 0.8125rem;
    font-weight: 550;
    margin-bottom: 0.4375rem;
  }
  .directory-list span > span {
    display: block;
    color: var(--fl-muted);
    font-size: 0.75rem;
    line-height: 1.6;
  }
  .directory-list small {
    display: block;
    margin-top: 0.625rem;
    color: var(--fl-muted);
    font-size: 0.625rem;
  }
  button:focus-visible {
    outline: 2px solid var(--fl-accent);
    outline-offset: 2px;
  }
  .tool {
    min-width: 0;
  }
  @media (max-width: 56rem) {
    .directory-list {
      grid-template-columns: 1fr;
    }
  }
  @media (max-width: 44rem) {
    .directory-list button {
      padding: 1rem;
    }
  }
</style>
