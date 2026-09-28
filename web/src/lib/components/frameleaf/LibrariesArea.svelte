<script lang="ts">
  /**
   * The Libraries area of the settings command center (FL-78), mounted where the design
   * template's `CommandCenter.jsx` mounts `AccountsLibraries view="libraries"`: above the external
   * library settings section. It reads its own rows, so the settings page's loader stays the
   * settings page's, and keeps the selected library, the add form and the edit form in the URL
   * (`selected`, `new=1`, `edit=1`) so a reload shows the same thing.
   */
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import LibrariesManager from '$lib/components/frameleaf/LibrariesManager.svelte';
  import { buildLibraryRows, loadLibrariesArea, type LibrariesAreaData } from '$lib/frameleaf/libraries';
  import { Route } from '$lib/route';
  import {
    getAllLibraries,
    getLibraryStatistics,
    getManagedUploadStatistics,
    searchUsersAdmin,
    UserStatus,
  } from '@immich/sdk';
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';

  let data = $state<LibrariesAreaData | null>(null);
  let failed = $state(false);

  const refresh = async () => {
    try {
      data = await loadLibrariesArea({
        searchUsersAdmin,
        getAllLibraries,
        getManagedUploadStatistics,
        getLibraryStatistics,
      });
      failed = false;
    } catch {
      failed = true;
    }
  };

  onMount(() => {
    void refresh();
  });

  const rows = $derived(
    data
      ? buildLibraryRows({
          libraries: data.libraries,
          users: data.users,
          uploads: data.uploads,
          statistics: data.statistics,
          uploadsName: (name) => $t('frameleaf_libraries_uploads_name', { values: { name } }),
        })
      : [],
  );
  const owners = $derived((data?.users ?? []).filter((user) => user.status === UserStatus.Active && !user.deletedAt));

  const select = async (key: string | null) => {
    const url = new URL(page.url);
    url.searchParams.delete('edit');
    url.searchParams.delete('new');
    if (key) {
      url.searchParams.set('selected', key);
    } else {
      url.searchParams.delete('selected');
    }
    await goto(`${url.pathname}${url.search}`, { replaceState: true, noScroll: true, keepFocus: true });
  };
</script>

{#if data}
  <LibrariesManager
    {rows}
    {owners}
    libraries={data.libraries}
    selectedKey={page.url.searchParams.get('selected')}
    editOnOpen={page.url.searchParams.get('edit') === '1'}
    createOnOpen={page.url.searchParams.get('new') === '1'}
    snapshotAt={data.snapshotAt}
    onSelect={select}
    onAnalytics={() => goto(Route.libraryAnalytics())}
    {refresh}
  />
{:else if failed}
  <p class="load-error" role="alert">{$t('frameleaf_libraries_load_error')}</p>
{:else}
  <p class="loading" role="status">{$t('loading')}</p>
{/if}

<style>
  .load-error,
  .loading {
    margin: 0;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
</style>
