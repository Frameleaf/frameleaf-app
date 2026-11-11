<script lang="ts">
  import './creators.css';
  import type { MediaCreatorItemResponse } from '@frameleaf/sdk';
  import { Theme as AppTheme, themeManager, toastManager } from '@frameleaf/ui';
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import InlineError from '$lib/components/frameleaf/InlineError.svelte';
  import { creatorsHref, readCreatorsLocation, type CreatorsLocation } from '$lib/frameleaf/creators';
  import { creatorsStore } from '$lib/frameleaf/creators-store.svelte';
  import { onLibraryAccessChange } from '$lib/frameleaf/library-access';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { eventManager } from '$lib/managers/event-manager.svelte';
  import CreatorItemPanel from './CreatorItemPanel.svelte';
  import CreatorPage from './CreatorPage.svelte';
  import CreatorsHome from './CreatorsHome.svelte';
  import CreatorsSubscriptions from './CreatorsSubscriptions.svelte';
  import CreatorsTray from './CreatorsTray.svelte';

  /**
   * The Creators area of Boards (prototype `CreatorsWorkspace`): its page, an item's details beside
   * it and the downloads tray. The Boards rail draws the list of creators. The address says where
   * you are (`/pro?area=creators…`), so reload, Back and Forward all work.
   */
  const where = $derived(readCreatorsLocation(new URL(page.url.href)));
  const creator = $derived(where.creator ? creatorsStore.creators.find(({ id }) => id === where.creator) : undefined);
  let items = $state<MediaCreatorItemResponse[]>([]);
  const item = $derived(
    where.item
      ? (items.find(({ assetId }) => assetId === where.item) ??
          (creatorsStore.opened?.assetId === where.item ? creatorsStore.opened : undefined))
      : undefined,
  );

  /** Moving between pages adds to history; a filter or a panel replaces the entry it is on. */
  const go = (next: Partial<CreatorsLocation>, replace = false) => goto(creatorsHref(next), { replace, reset: false });
  const view = (change: Partial<CreatorsLocation>) => void go({ ...where, ...change }, true);

  const start = () => {
    // Loads the first time (or for another account); after that, reads the creators again.
    void creatorsStore.ensure();
    if (creatorsStore.status === 'ready') {
      void creatorsStore.refresh();
    } else if (creatorsStore.status !== 'loading') {
      void creatorsStore.load();
    }
  };

  onMount(() => {
    start();
    const stopEvents = eventManager.on({ AlbumCreate: () => void creatorsStore.loadFolders() });
    const stopAccess = onLibraryAccessChange(
      () => {
        creatorsStore.reset();
        if (authManager.authenticated) {
          void creatorsStore.load();
        }
      },
      authManager.authenticated ? authManager.user.id : undefined,
    );
    return () => {
      stopEvents();
      stopAccess();
    };
  });

  const done = async (message: string, creatorId?: string) => {
    toastManager.primary(message);
    creatorsStore.started();
    await creatorsStore.refresh();
    if (creatorId) {
      void go({ creator: creatorId });
    }
  };

  const openItem = (opened: MediaCreatorItemResponse) => {
    creatorsStore.opened = opened;
    if (opened.creatorId === where.creator) {
      view({ item: opened.assetId });
    } else {
      void go({ creator: opened.creatorId, item: opened.assetId });
    }
  };

  const changed = (updated: MediaCreatorItemResponse) => {
    items = items.map((value) => (value.assetId === updated.assetId ? updated : value));
    if (creatorsStore.opened?.assetId === updated.assetId) {
      creatorsStore.opened = updated;
    }
  };

  const deleted = (assetId: string) => {
    items = items.filter((value) => value.assetId !== assetId);
    creatorsStore.opened = null;
    view({ item: null });
    if (where.creator) {
      void creatorsStore.refreshCreator(where.creator);
    }
  };
</script>

<section
  class="frameleaf fl-creators"
  data-theme={themeManager.value === AppTheme.Dark ? 'dark' : 'light'}
  aria-label={$t('frameleaf_creators_title')}
>
  <div class="cr-page">
    {#if creatorsStore.status === 'unavailable'}
      <!-- An older Library, or one without the tools to save from the web: Items keeps working. -->
      <div class="cr-notice">
        <h1>{$t('frameleaf_creators_title')}</h1>
        <p role="status">{$t('frameleaf_boards_media_unavailable')}</p>
        {#if creatorsStore.reason}<p class="cr-muted cr-pre">{creatorsStore.reason}</p>{/if}
      </div>
    {:else if creatorsStore.status === 'failed'}
      <div class="cr-notice">
        <InlineError
          compact
          message={$t('frameleaf_boards_media_capabilities_error')}
          onRetry={() => creatorsStore.load()}
        />
      </div>
    {:else if creatorsStore.status !== 'ready'}
      <p class="cr-notice" role="status">{$t('loading')}</p>
    {:else if where.creator}
      {#if creator}
        <CreatorPage
          {creator}
          section={where.section}
          kind={where.kind}
          unwatched={where.unwatched}
          settings={where.settings}
          bind:items
          onView={view}
          onOpenItem={openItem}
        />
      {:else}
        <div class="cr-notice">
          <p role="status">{$t('frameleaf_creators_gone')}</p>
          <a href={creatorsHref()}>{$t('frameleaf_creators_back_home')}</a>
        </div>
      {/if}
    {:else if where.view === 'subscriptions'}
      <CreatorsSubscriptions />
    {:else}
      <CreatorsHome onDone={(message, creatorId) => void done(message, creatorId)} onOpenItem={openItem} />
    {/if}
    {#if creatorsStore.status === 'ready'}<CreatorsTray />{/if}
  </div>
  {#if item && creator && creatorsStore.status === 'ready'}
    <CreatorItemPanel {item} {creator} onClose={() => view({ item: null })} onChange={changed} onDeleted={deleted} />
  {/if}
</section>
{#if creatorsStore.connectionsOpen && creatorsStore.capabilities}
  {#await import('./CreatorsConnectionsDialog.svelte') then { default: CreatorsConnectionsDialog }}
    <CreatorsConnectionsDialog
      methods={creatorsStore.capabilities.authentication}
      onClosed={() => {
        creatorsStore.connectionsOpen = false;
        void creatorsStore.loadConnections();
      }}
    />
  {/await}
{/if}
