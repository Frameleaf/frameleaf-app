<script lang="ts">
  import ShareCover from '../../../routes/(user)/shared-links/(list)/ShareCover.svelte';
  import Button from './Button.svelte';
  import Dialog from './Dialog.svelte';
  import IconButton from './IconButton.svelte';
  import SharedLinkForm from './SharedLinkForm.svelte';
  import QrCode from './QrCode.svelte';
  import OnEvents from '$lib/components/OnEvents.svelte';
  import '$lib/frameleaf/tokens.css';
  import { eventManager } from '$lib/managers/event-manager.svelte';
  import {
    isLinkExpired,
    relativeTime,
    sharedLinkBadges,
    type SharedLinkBadgeId,
  } from '$lib/frameleaf/shared-link-badges';
  import { Route } from '$lib/route';
  import { asUrl } from '$lib/services/shared-link.service';
  import { copyToClipboard } from '$lib/utils';
  import { handleError } from '$lib/utils/handle-error';
  import {
    getAllAlbums,
    getAllSharedLinks,
    getSharedLinkById,
    removeSharedLink,
    SharedLinkType,
    type AlbumResponseDto,
    type SharedLinkResponseDto,
  } from '@immich/sdk';
  import { Icon, Theme as AppTheme, themeManager, toastManager } from '@immich/ui';
  import {
    mdiClockOutline,
    mdiContentCopy,
    mdiDeleteOutline,
    mdiDownloadOutline,
    mdiInformationOutline,
    mdiLinkVariant,
    mdiLockOutline,
    mdiMagnify,
    mdiOpenInNew,
    mdiPencilOutline,
    mdiPlus,
    mdiQrcode,
    mdiUpload,
  } from '@mdi/js';
  import { replaceState } from '$app/navigation';
  import { page } from '$app/state';
  import { onMount, untrack } from 'svelte';
  import { locale, t } from 'svelte-i18n';

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
    } catch (error) {
      handleError(error, $t('frameleaf_sharing.links_load_failed'));
    } finally {
      loading = false;
    }
  };

  let loaded = $state(false);

  /**
   * `?edit={id}` (the old `/shared-links/{id}/edit` address) opens that link's form. It follows
   * the address, so a later navigation to `?edit=` opens the form too. A link not in the loaded
   * list is asked for by id; one that cannot be found says so.
   */
  const openRequestedEdit = async (id: string) => {
    const url = new URL(page.url);
    url.searchParams.delete('edit');
    replaceState(url, page.state);

    let link = links.find((entry) => entry.id === id);
    if (!link) {
      try {
        link = await getSharedLinkById({ id });
      } catch {
        link = undefined;
      }
    }
    if (link) {
      openEdit(link);
    } else {
      toastManager.warning($t('frameleaf_sharing.link_not_found'));
    }
  };

  const requestedEdit = $derived(page.url.searchParams.get('edit'));
  $effect(() => {
    const id = requestedEdit;
    if (id && loaded) {
      untrack(() => void openRequestedEdit(id));
    }
  });

  onMount(() => {
    void refresh().finally(() => (loaded = true));
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

  const isExpired = (link: SharedLinkResponseDto) => isLinkExpired(link);

  /* ---- AL-20: the tabs are a real tablist — arrows, Home and End move and select, one tab stop ---- */
  let tabButtons: HTMLButtonElement[] = $state([]);
  const onTabKeydown = (event: KeyboardEvent) => {
    const index = TABS.findIndex(({ id }) => id === tab);
    const delta = { ArrowRight: 1, ArrowLeft: -1, Home: -index, End: TABS.length - 1 - index }[event.key];
    if (delta === undefined) {
      return;
    }
    event.preventDefault();
    const next = (index + delta + TABS.length) % TABS.length;
    tab = TABS[next].id;
    tabButtons[next]?.focus();
  };

  /* ---- AL-21: what each card says about its link (SharedLinks.jsx `Badges`, `sl-meta`) ---- */
  const badgeIcons: Record<SharedLinkBadgeId, string> = {
    expired: mdiClockOutline,
    password: mdiLockOutline,
    download: mdiDownloadOutline,
    upload: mdiUpload,
    metadata: mdiInformationOutline,
    expiry: mdiClockOutline,
  };
  const badgeLabel = (id: SharedLinkBadgeId, at?: string) => {
    switch (id) {
      case 'expired': {
        return $t('expired');
      }
      case 'password': {
        return $t('password');
      }
      case 'download': {
        return $t('frameleaf_sharing.badge_downloads');
      }
      case 'upload': {
        return $t('frameleaf_sharing.badge_uploads');
      }
      case 'metadata': {
        return $t('frameleaf_sharing.badge_metadata');
      }
      case 'expiry': {
        return $t('frameleaf_sharing.badge_expires', {
          values: { when: relativeTime(at ?? Date.now(), Date.now(), $locale ?? undefined) },
        });
      }
    }
  };
  const createdLabel = (link: SharedLinkResponseDto) =>
    $t('frameleaf_sharing.created_when', {
      values: { when: relativeTime(link.createdAt, Date.now(), $locale ?? undefined) },
    });

  /** An album link opens the album here; a selection opens the public page, as a visitor sees it. */
  const openPublic = (link: SharedLinkResponseDto) => window.open(asUrl(link), '_blank', 'noopener,noreferrer');

  let status = $state('');
  const copy = async (link: SharedLinkResponseDto) => {
    await copyToClipboard(asUrl(link));
    status = $t('frameleaf_sharing.link_copied_for', { values: { name: titleOf(link) } });
  };

  const openPicker = async () => {
    dialog = { kind: 'pick' };
    pickOpen = true;
    try {
      albums = await getAllAlbums({ isOwned: true });
      pickAlbumId = albums[0]?.id ?? '';
    } catch (error) {
      pickOpen = false;
      handleError(error, $t('frameleaf_sharing.albums_load_failed'));
    }
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
      status = $t('frameleaf_sharing.link_deleted_for', { values: { name: titleOf(link) } });
      toastManager.primary($t('deleted_shared_link'));
    } catch (error) {
      handleError(error, $t('errors.unable_to_delete_shared_link'));
    } finally {
      deleteOpen = false;
    }
  };
</script>

<OnEvents {onSharedLinkCreate} {onSharedLinkUpdate} {onSharedLinkDelete} />

<!-- The shared links screen, ported from the design's SharedLinks.jsx (AL-19..AL-22). -->
<section class="frameleaf sl-screen" data-theme={appTheme} aria-labelledby="sl-heading">
  <header class="sl-head">
    <div>
      <h1 id="sl-heading">{$t('shared_links')}</h1>
      <p>{$t('frameleaf_sharing.links_intro')}</p>
    </div>
    <Button variant="primary" disabled={loading} onclick={openPicker}>
      <Icon icon={mdiPlus} size="18" aria-hidden={true} />
      {$t('frameleaf_sharing.new_link')}
    </Button>
  </header>

  <div class="sl-toolbar">
    <div
      class="sl-tabs"
      role="tablist"
      aria-label={$t('frameleaf_sharing.link_types')}
      tabindex="-1"
      onkeydown={onTabKeydown}
    >
      {#each TABS as entry, index (entry.id)}
        <button
          bind:this={tabButtons[index]}
          type="button"
          role="tab"
          id={`sl-tab-${entry.id}`}
          aria-selected={tab === entry.id}
          aria-controls="sl-panel"
          tabindex={tab === entry.id ? 0 : -1}
          class="sl-tab"
          onclick={() => (tab = entry.id)}
        >
          {entry.label()}
          <span class="sl-count">{counts[entry.id] ?? 0}</span>
        </button>
      {/each}
    </div>
    <label class="sl-search">
      <Icon icon={mdiMagnify} size="18" aria-hidden={true} />
      <input
        type="search"
        bind:value={query}
        placeholder={$t('frameleaf_sharing.search_links')}
        aria-label={$t('frameleaf_sharing.search_shared_links')}
      />
    </label>
  </div>

  <p class="sr-only" role="status" aria-live="polite">{status}</p>

  <div id="sl-panel" role="tabpanel" aria-labelledby={`sl-tab-${tab}`}>
    {#if loading}
      <p class="muted">{$t('loading')}</p>
    {:else if visible.length}
      <ul class="sl-grid">
        {#each visible as link (link.id)}
          {@const title = titleOf(link)}
          {@const expired = isExpired(link)}
          {@const isAlbum = link.type === SharedLinkType.Album}
          <li class="sl-card" data-expired={expired || undefined}>
            {#if isAlbum && link.album}
              <a
                class="sl-cover"
                href={Route.viewAlbum({ id: link.album.id })}
                aria-label={$t('frameleaf_sharing.open_album_named', { values: { name: title } })}
              >
                <ShareCover sharedLink={link} />
                {#if expired}<span class="sl-cover-flag">{$t('expired')}</span>{/if}
              </a>
            {:else}
              <a
                class="sl-cover"
                href={asUrl(link)}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={$t('frameleaf_sharing.open_shared_page_for', { values: { name: title } })}
              >
                <ShareCover sharedLink={link} />
                {#if expired}<span class="sl-cover-flag">{$t('expired')}</span>{/if}
              </a>
            {/if}
            <div class="sl-body">
              <div class="sl-heading">
                <h2>{title}</h2>
                <span class="sl-type">{isAlbum ? $t('album') : $t('frameleaf_sharing.type_individual')}</span>
              </div>
              <p class="sl-desc">{link.description || $t('frameleaf_sharing.no_description')}</p>
              <ul class="sl-badges" aria-label={$t('frameleaf_sharing.link_details')}>
                {#each sharedLinkBadges(link) as badge (badge.id)}
                  <li class="sl-badge" data-tone={badge.tone}>
                    <Icon icon={badgeIcons[badge.id]} size="14" aria-hidden={true} />
                    {badgeLabel(badge.id, badge.at)}
                  </li>
                {/each}
              </ul>
              <p class="sl-meta">{createdLabel(link)} · {link.slug ? `/s/${link.slug}` : link.id}</p>
            </div>
            <div class="sl-actions">
              <IconButton
                label={$t('frameleaf_sharing.copy_link_for', { values: { name: title } })}
                onclick={() => void copy(link)}
              >
                <Icon icon={mdiContentCopy} size="18" />
              </IconButton>
              <IconButton
                label={$t('frameleaf_sharing.qr_code_for', { values: { name: title } })}
                onclick={() => openQr(link)}
              >
                <Icon icon={mdiQrcode} size="18" />
              </IconButton>
              <IconButton
                label={$t('frameleaf_sharing.open_public_page_for', { values: { name: title } })}
                onclick={() => openPublic(link)}
              >
                <Icon icon={mdiOpenInNew} size="18" />
              </IconButton>
              <span class="grow"></span>
              <Button onclick={() => openEdit(link)}>
                <Icon icon={mdiPencilOutline} size="18" aria-hidden={true} />
                {$t('edit')}
              </Button>
              <button type="button" class="sl-danger" onclick={() => openDelete(link)}>
                <Icon icon={mdiDeleteOutline} size="18" aria-hidden={true} />
                {$t('delete')}
              </button>
            </div>
          </li>
        {/each}
      </ul>
    {:else}
      <div class="sl-empty">
        <Icon icon={mdiLinkVariant} size="40" aria-hidden={true} />
        <h2>
          {links.length > 0 ? $t('frameleaf_sharing.empty_matches_title') : $t('frameleaf_sharing.empty_links_title')}
        </h2>
        <p>
          {links.length > 0 ? $t('frameleaf_sharing.empty_matches_body') : $t('frameleaf_sharing.empty_links_body')}
        </p>
      </div>
    {/if}
  </div>
</section>

<Dialog title={$t('frameleaf_sharing.pick_album_title')} closeLabel={$t('close')} bind:open={pickOpen}>
  {#if albums.length}
    <label>
      <span>{$t('album')}</span>
      <select bind:value={pickAlbumId}>
        {#each albums as album (album.id)}
          <option value={album.id}>{album.albumName}</option>
        {/each}
      </select>
    </label>
    <p class="muted">{$t('frameleaf_sharing.pick_album_hint')}</p>
    <div class="sl-dialog-actions">
      <Button onclick={() => (pickOpen = false)}>{$t('cancel')}</Button>
      <Button variant="primary" disabled={!pickAlbumId} onclick={startCreateFromAlbum}>{$t('continue')}</Button>
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
  <Dialog
    title={$t('frameleaf_sharing.qr_title', { values: { name: titleOf(dialog.link) } })}
    closeLabel={$t('close')}
    bind:open={qrOpen}
  >
    <p class="muted">{$t('frameleaf_sharing.qr_hint')}</p>
    <QrCode
      value={asUrl(dialog.link)}
      label={$t('frameleaf_sharing.qr_code_for', { values: { name: titleOf(dialog.link) } })}
      copyLabel={$t('copy_link')}
      downloadLabel={$t('download')}
      errorLabel={$t('frameleaf_sharing.qr_error')}
      fileName={dialog.link.slug || dialog.link.id}
    />
  </Dialog>
{/if}

{#if dialog?.kind === 'delete'}
  {@const link = dialog.link}
  <!-- AL-22: the prototype's delete dialog says who loses what, and what is kept. -->
  <!-- The prototype focuses "Delete link" first and keeps both buttons in the dialog footer (SharedLinks.jsx:396-412). -->
  <Dialog title={$t('delete_shared_link')} closeLabel={$t('close')} bind:open={deleteOpen}>
    <p>{$t('frameleaf_sharing.delete_link_body', { values: { name: titleOf(link) } })}</p>
    {#snippet actions()}
      <Button onclick={() => (deleteOpen = false)}>{$t('cancel')}</Button>
      <Button variant="primary" initialFocus onclick={confirmDelete}>{$t('delete_link')}</Button>
    {/snippet}
  </Dialog>
{/if}

<style>
  /* Ported from the design's sharing.css (Shared links screen, lines 4-300 and 1297-1330). */
  .sl-screen {
    color: var(--fl-text);
    padding: 1.625rem 1.875rem 2.25rem;
    max-width: 1400px;
    width: 100%;
    box-sizing: border-box;
    min-width: 0;
    margin: 0 auto;
  }
  .sl-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 1.25rem;
    margin-bottom: 1.375rem;
  }
  h1 {
    margin: 0;
    font-size: 1.625rem;
    letter-spacing: -0.035em;
    font-weight: 600;
  }
  .sl-head p {
    color: var(--fl-muted);
    font-size: 0.8125rem;
    margin: 0.5rem 0 0;
    line-height: 1.6;
    max-width: 62ch;
  }
  .sl-toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.875rem;
    flex-wrap: wrap;
    margin-bottom: 1.125rem;
  }
  .sl-tabs {
    display: inline-flex;
    gap: 2px;
    padding: 3px;
    border-radius: var(--fl-radius-control);
    background: var(--fl-panel);
    border: 1px solid var(--fl-border);
  }
  .sl-tab {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    border: 0;
    background: transparent;
    color: var(--fl-muted);
    font: inherit;
    font-size: 0.8125rem;
    min-height: 32px;
    padding: 4px 12px;
    border-radius: 4px;
    cursor: pointer;
    transition:
      background var(--fl-motion) var(--fl-ease),
      color var(--fl-motion) var(--fl-ease);
  }
  .sl-tab:hover {
    color: var(--fl-text);
  }
  .sl-tab[aria-selected='true'] {
    background: var(--fl-raised);
    color: var(--fl-text);
  }
  .sl-count {
    font-size: var(--fl-font-micro);
    color: var(--fl-muted);
    background: color-mix(in srgb, var(--fl-text), transparent 90%);
    border-radius: var(--fl-radius-pill);
    padding: 1px 7px;
    min-width: 18px;
    text-align: center;
  }
  .sl-search {
    position: relative;
    display: flex;
    align-items: center;
    color: var(--fl-muted);
    min-width: 240px;
    flex: 0 1 300px;
  }
  .sl-search :global(svg) {
    position: absolute;
    left: 10px;
    pointer-events: none;
  }
  .sl-search input {
    width: 100%;
    padding-left: 34px;
    min-height: 34px;
    background: var(--fl-raised);
    color: var(--fl-text);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
  }
  .sl-grid {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
    gap: 1rem;
  }
  .sl-card {
    display: flex;
    flex-direction: column;
    background: var(--fl-panel);
    border-radius: var(--fl-radius-card);
    overflow: hidden;
    min-width: 0;
    transition:
      transform var(--fl-motion) var(--fl-ease),
      box-shadow var(--fl-motion) var(--fl-ease);
  }
  .sl-screen[data-theme='light'] .sl-card {
    border: 1px solid var(--fl-border);
  }
  .sl-card:hover {
    box-shadow: var(--fl-shadow-1);
  }
  .sl-card[data-expired] .sl-cover {
    filter: saturate(0.4);
    opacity: 0.75;
  }
  .sl-cover {
    position: relative;
    display: block;
    width: 100%;
    background: var(--fl-raised);
  }
  .sl-cover-flag {
    position: absolute;
    left: 10px;
    top: 10px;
    font-size: var(--fl-font-micro);
    font-weight: 600;
    letter-spacing: 0.02em;
    color: #fff;
    background: color-mix(in srgb, var(--fl-danger), black 15%);
    border-radius: var(--fl-radius-pill);
    padding: 3px 9px;
  }
  .sl-body {
    padding: 14px 16px 12px;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    flex: 1;
  }
  .sl-heading {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 0.75rem;
  }
  h2 {
    margin: 0;
    font-size: 0.9375rem;
    font-weight: 580;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }
  .sl-type {
    flex-shrink: 0;
    font-size: var(--fl-font-micro);
    color: var(--fl-muted);
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }
  .sl-desc {
    margin: 0;
    font-size: 0.8125rem;
    color: var(--fl-muted);
    overflow: hidden;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
  }
  .sl-meta {
    margin: auto 0 0;
    font-size: var(--fl-font-micro);
    color: var(--fl-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .sl-badges {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .sl-badge {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    font-size: var(--fl-font-micro);
    line-height: 1;
    color: var(--fl-muted);
    background: var(--fl-raised);
    border-radius: var(--fl-radius-pill);
    padding: 5px 9px;
  }
  .sl-badge[data-tone='danger'] {
    color: var(--fl-danger);
    background: color-mix(in srgb, var(--fl-danger), transparent 86%);
  }
  .sl-badge[data-tone='info'] {
    color: var(--fl-teal);
    background: color-mix(in srgb, var(--fl-teal), transparent 86%);
  }
  .sl-actions {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 10px 12px;
    border-top: 1px solid var(--fl-border);
  }
  .sl-actions .grow {
    flex: 1;
  }
  .sl-danger {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.4375rem 0.6875rem;
    color: var(--fl-danger);
    background: var(--fl-raised);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
  }
  .sl-danger:hover {
    border-color: color-mix(in srgb, var(--fl-danger), transparent 50%);
  }
  .sl-empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.375rem;
    padding: 60px 20px;
    color: var(--fl-muted);
    text-align: center;
  }
  .sl-empty h2 {
    color: var(--fl-text);
    white-space: normal;
  }
  .sl-empty p {
    margin: 0;
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
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    margin: -1px;
    padding: 0;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
    border: 0;
  }
  @media (max-width: 700px) {
    .sl-screen {
      padding: 18px 16px 32px;
    }
    .sl-head {
      flex-direction: column;
    }
    .sl-grid {
      grid-template-columns: 1fr;
    }
    .sl-search {
      flex: 1 1 100%;
      min-width: 0;
    }
    .sl-tabs {
      width: 100%;
      overflow-x: auto;
    }
    .sl-tab {
      flex: 1;
      justify-content: center;
      min-height: 40px;
    }
    .sl-actions {
      flex-wrap: wrap;
    }
  }
</style>
