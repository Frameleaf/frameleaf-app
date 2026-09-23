<script lang="ts">
  import ShareCover from '../../../routes/(user)/shared-links/(list)/ShareCover.svelte';
  import Dialog from './Dialog.svelte';
  import SharedLinkForm from './SharedLinkForm.svelte';
  import QrCode from './QrCode.svelte';
  import OnEvents from '$lib/components/OnEvents.svelte';
  import '$lib/frameleaf/tokens.css';
  import { eventManager } from '$lib/managers/event-manager.svelte';
  import { asUrl } from '$lib/services/shared-link.service';
  import { copyToClipboard } from '$lib/utils';
  import { handleError } from '$lib/utils/handle-error';
  import {
    getAllAlbums,
    getAllSharedLinks,
    removeSharedLink,
    SharedLinkType,
    type AlbumResponseDto,
    type SharedLinkResponseDto,
  } from '@immich/sdk';
  import { Theme as AppTheme, themeManager, toastManager } from '@immich/ui';
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';

  // Mounted directly as route content (no Frameleaf ancestor supplies the token scope), so
  // the class and theme attribute are applied on this component's own root, matching the
  // pattern LibraryRail.svelte and TopBar.svelte use for their own root elements.
  const appTheme = $derived(themeManager.value === AppTheme.Dark ? 'dark' : 'light');

  const TABS: { id: 'all' | 'album' | 'individual'; label: () => string }[] = [
    { id: 'all', label: () => $t('all') },
    { id: 'album', label: () => $t('albums') },
    { id: 'individual', label: () => $t('individual_shares') },
  ];

  let links: SharedLinkResponseDto[] = $state([]);
  let loading = $state(true);
  let tab: 'all' | 'album' | 'individual' = $state('all');
  let query = $state('');

  let dialog:
    | { kind: 'pick' }
    | { kind: 'create'; target: { type: SharedLinkType; albumId?: string; assetIds?: string[]; name: string } }
    | { kind: 'edit'; link: SharedLinkResponseDto }
    | { kind: 'qr'; link: SharedLinkResponseDto }
    | { kind: 'delete'; link: SharedLinkResponseDto }
    | undefined = $state();
  let formOpen = $state(false);
  let qrOpen = $state(false);
  let deleteOpen = $state(false);
  let pickOpen = $state(false);

  let albums: AlbumResponseDto[] = $state([]);
  let pickAlbumId = $state('');

  const refresh = async () => {
    loading = true;
    try {
      links = await getAllSharedLinks({});
    } finally {
      loading = false;
    }
  };

  onMount(() => {
    void refresh();
  });

  const onSharedLinkCreate = (link: SharedLinkResponseDto) => {
    if (links.every((entry) => entry.id !== link.id)) {
      links = [link, ...links];
    }
  };
  const onSharedLinkUpdate = (link: SharedLinkResponseDto) => {
    links = links.map((entry) => (entry.id === link.id ? link : entry));
  };
  const onSharedLinkDelete = (link: SharedLinkResponseDto) => {
    links = links.filter((entry) => entry.id !== link.id);
  };

  const titleOf = (link: SharedLinkResponseDto) => {
    if (link.album) {
      return link.album.albumName;
    }
    if (link.assets.length === 1) {
      return link.assets[0].originalFileName;
    }
    return $t('frameleaf_sharing.individual_items', { values: { count: link.assets.length } });
  };

  const needle = $derived(query.trim().toLowerCase());
  const visible = $derived(
    links.filter((link) => {
      if (tab !== 'all' && link.type !== (tab === 'album' ? SharedLinkType.Album : SharedLinkType.Individual)) {
        return false;
      }
      if (!needle) {
        return true;
      }
      return [titleOf(link), link.description ?? '', link.slug ?? '', link.id].join(' ').toLowerCase().includes(needle);
    }),
  );
  const counts = $derived(
    Object.fromEntries(
      TABS.map(({ id }) => [
        id,
        links.filter(
          (link) => id === 'all' || link.type === (id === 'album' ? SharedLinkType.Album : SharedLinkType.Individual),
        ).length,
      ]),
    ),
  );

  const isExpired = (link: SharedLinkResponseDto) => !!link.expiresAt && Date.parse(link.expiresAt) <= Date.now();

  const openPicker = async () => {
    dialog = { kind: 'pick' };
    pickOpen = true;
    albums = await getAllAlbums({ isOwned: true });
    pickAlbumId = albums[0]?.id ?? '';
  };

  const startCreateFromAlbum = () => {
    const album = albums.find((entry) => entry.id === pickAlbumId);
    if (!album) {
      return;
    }
    pickOpen = false;
    dialog = { kind: 'create', target: { type: SharedLinkType.Album, albumId: album.id, name: album.albumName } };
    formOpen = true;
  };

  const openEdit = (link: SharedLinkResponseDto) => {
    dialog = { kind: 'edit', link };
    formOpen = true;
  };

  const openQr = (link: SharedLinkResponseDto) => {
    dialog = { kind: 'qr', link };
    qrOpen = true;
  };

  const openDelete = (link: SharedLinkResponseDto) => {
    dialog = { kind: 'delete', link };
    deleteOpen = true;
  };

  const confirmDelete = async () => {
    if (dialog?.kind !== 'delete') {
      return;
    }
    const { link } = dialog;
    try {
      await removeSharedLink({ id: link.id });
      eventManager.emit('SharedLinkDelete', link);
      toastManager.primary($t('deleted_shared_link'));
    } catch (error) {
      handleError(error, $t('errors.unable_to_delete_shared_link'));
    } finally {
      deleteOpen = false;
    }
  };
</script>

<OnEvents {onSharedLinkCreate} {onSharedLinkUpdate} {onSharedLinkDelete} />

<section class="frameleaf sl-screen" data-theme={appTheme} aria-labelledby="sl-heading">
  <header class="sl-head">
    <div>
      <h1 id="sl-heading">{$t('shared_links')}</h1>
    </div>
    <button type="button" class="primary" disabled={loading} onclick={openPicker}>
      {$t('frameleaf_sharing.new_link')}
    </button>
  </header>

  <div class="sl-toolbar">
    <div class="sl-tabs" role="tablist" aria-label={$t('show_shared_links')}>
      {#each TABS as entry (entry.id)}
        <button
          type="button"
          role="tab"
          aria-selected={tab === entry.id}
          class="sl-tab"
          onclick={() => (tab = entry.id)}
        >
          {entry.label()}
          <span class="sl-count">{counts[entry.id] ?? 0}</span>
        </button>
      {/each}
    </div>
    <label class="sl-search">
      <input
        type="search"
        bind:value={query}
        placeholder={$t('frameleaf_sharing.search_links')}
        aria-label={$t('frameleaf_sharing.search_links')}
      />
    </label>
  </div>

  {#if loading}
    <p role="status">{$t('loading')}</p>
  {:else if visible.length}
    <ul class="sl-grid">
      {#each visible as link (link.id)}
        {@const title = titleOf(link)}
        {@const expired = isExpired(link)}
        <li class="sl-card" data-expired={expired || undefined}>
          <a class="sl-cover" href={asUrl(link)} target="_blank" rel="noopener noreferrer" aria-label={title}>
            <ShareCover sharedLink={link} />
            {#if expired}<span class="sl-cover-flag">{$t('expired')}</span>{/if}
          </a>
          <div class="sl-body">
            <div class="sl-heading">
              <h2>{title}</h2>
              <span class="sl-type">{link.type === SharedLinkType.Album ? $t('album') : $t('individual_share')}</span>
            </div>
            {#if link.description}<p class="sl-desc">{link.description}</p>{/if}
            <ul class="sl-badges" aria-label={$t('frameleaf_sharing.link_ready_title')}>
              {#if link.password}<li>{$t('password')}</li>{/if}
              {#if link.allowDownload}<li>{$t('download')}</li>{/if}
              {#if link.allowUpload}<li>{$t('upload')}</li>{/if}
              {#if link.showMetadata}<li>{$t('show_metadata')}</li>{/if}
              {#if link.expiresAt}<li>
                  {$t('expires_date', { values: { date: new Date(link.expiresAt).toLocaleString() } })}
                </li>{/if}
            </ul>
          </div>
          <div class="sl-actions">
            <button type="button" onclick={() => copyToClipboard(asUrl(link))}>{$t('copy_link')}</button>
            <button type="button" onclick={() => openQr(link)}>{$t('view_qr_code')}</button>
            <span class="grow"></span>
            <button type="button" onclick={() => openEdit(link)}>{$t('edit_link')}</button>
            <button type="button" class="danger" onclick={() => openDelete(link)}>{$t('delete_link')}</button>
          </div>
        </li>
      {/each}
    </ul>
  {:else}
    <div class="sl-empty">
      <h2>
        {links.length > 0 ? $t('frameleaf_sharing.empty_matches_title') : $t('frameleaf_sharing.empty_links_title')}
      </h2>
      <p>{links.length > 0 ? $t('frameleaf_sharing.empty_matches_body') : $t('frameleaf_sharing.empty_links_body')}</p>
    </div>
  {/if}
</section>

<Dialog title={$t('frameleaf_sharing.pick_album_title')} closeLabel={$t('close')} bind:open={pickOpen}>
  {#if albums.length}
    <label>
      {$t('album')}
      <select bind:value={pickAlbumId}>
        {#each albums as album (album.id)}
          <option value={album.id}>{album.albumName}</option>
        {/each}
      </select>
    </label>
    <p class="muted">{$t('frameleaf_sharing.pick_album_hint')}</p>
    <div class="sl-dialog-actions">
      <button type="button" onclick={() => (pickOpen = false)}>{$t('cancel')}</button>
      <button type="button" class="primary" disabled={!pickAlbumId} onclick={startCreateFromAlbum}
        >{$t('continue')}</button
      >
    </div>
  {:else}
    <p class="muted">{$t('frameleaf_sharing.pick_album_hint')}</p>
  {/if}
</Dialog>

{#if dialog?.kind === 'create'}
  <SharedLinkForm bind:open={formOpen} target={dialog.target} />
{:else if dialog?.kind === 'edit'}
  <SharedLinkForm bind:open={formOpen} link={dialog.link} />
{/if}

{#if dialog?.kind === 'qr'}
  <Dialog title={$t('view_qr_code')} closeLabel={$t('close')} bind:open={qrOpen}>
    <QrCode
      value={asUrl(dialog.link)}
      label={$t('view_qr_code')}
      copyLabel={$t('copy_link')}
      downloadLabel={$t('download')}
      errorLabel={$t('frameleaf_sharing.qr_error')}
      fileName={dialog.link.slug || dialog.link.id}
    />
  </Dialog>
{/if}

{#if dialog?.kind === 'delete'}
  <Dialog title={$t('delete_shared_link')} closeLabel={$t('close')} bind:open={deleteOpen}>
    <p>{$t('confirm_delete_shared_link')}</p>
    <div class="sl-dialog-actions">
      <button type="button" onclick={() => (deleteOpen = false)}>{$t('cancel')}</button>
      <button type="button" class="danger" onclick={confirmDelete}>{$t('delete_shared_link')}</button>
    </div>
  </Dialog>
{/if}

<style>
  .sl-screen {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }
  .sl-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
  }
  h1 {
    font-size: 1.25rem;
  }
  .sl-toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    flex-wrap: wrap;
  }
  .sl-tabs {
    display: flex;
    gap: 0.25rem;
  }
  .sl-tab {
    background: var(--fl-raised);
    color: var(--fl-text);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius);
    padding: 0 0.75rem;
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
  }
  .sl-tab[aria-selected='true'] {
    background: var(--fl-accent);
    color: var(--fl-accent-text);
    border-color: var(--fl-accent);
  }
  .sl-count {
    font-size: 0.75rem;
    opacity: 0.8;
  }
  .sl-search input {
    background: var(--fl-raised);
    color: var(--fl-text);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius);
    padding: 0.5rem;
  }
  .sl-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(16rem, 1fr));
    gap: 1rem;
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .sl-card {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    background: var(--fl-panel);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-panel-radius);
    padding: 0.75rem;
  }
  .sl-card[data-expired] {
    opacity: 0.7;
  }
  .sl-cover {
    position: relative;
    display: block;
  }
  .sl-cover-flag {
    position: absolute;
    top: 0.5rem;
    left: 0.5rem;
    background: var(--fl-canvas);
    color: var(--fl-text);
    border-radius: var(--fl-radius);
    padding: 0 0.375rem;
    font-size: 0.75rem;
  }
  .sl-heading {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 0.5rem;
  }
  h2 {
    font-size: 1rem;
    overflow-wrap: anywhere;
  }
  .sl-type {
    color: var(--fl-muted);
    font-size: 0.75rem;
    flex-shrink: 0;
  }
  .sl-desc {
    color: var(--fl-muted);
    font-size: 0.875rem;
  }
  .sl-badges {
    display: flex;
    flex-wrap: wrap;
    gap: 0.375rem;
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .sl-badges li {
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius);
    padding: 0 0.5rem;
    font-size: 0.75rem;
    color: var(--fl-muted);
  }
  .sl-actions {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    flex-wrap: wrap;
  }
  .sl-actions .grow {
    flex: 1;
  }
  .sl-actions button,
  .sl-head button,
  .sl-dialog-actions button {
    background: var(--fl-raised);
    color: var(--fl-text);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius);
    padding: 0 0.75rem;
  }
  .sl-actions button.danger,
  .sl-dialog-actions button.danger {
    color: var(--fl-accent);
    border-color: var(--fl-accent);
  }
  .sl-head button.primary,
  .sl-dialog-actions button.primary {
    background: var(--fl-accent);
    color: var(--fl-accent-text);
    border-color: var(--fl-accent);
  }
  .sl-empty {
    text-align: center;
    color: var(--fl-muted);
    padding: 2rem;
  }
  .sl-dialog-actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
    margin-top: 1rem;
  }
  .muted {
    color: var(--fl-muted);
  }
</style>
