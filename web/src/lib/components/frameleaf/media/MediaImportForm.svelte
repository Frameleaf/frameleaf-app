<script lang="ts">
  import AlbumDestinationPicker from '$lib/components/frameleaf/AlbumDestinationPicker.svelte';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import InlineError from '$lib/components/frameleaf/InlineError.svelte';
  import { libraryReferenceUrl } from '$lib/frameleaf/library-reference';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import {
    createMediaImport,
    createMediaSubscription,
    getAllAlbums,
    getCaptureCatalog,
    getMediaConnections,
    inspectMedia,
    LibraryViewScope,
    MediaConnectionStatus,
    MediaHistoryMode,
    MediaImportState,
    MediaInspectionKind,
    previewMediaSubscription,
    type AlbumResponseDto,
    type MediaConnectionResponseDto,
    type MediaImportResponseDto,
    type MediaSubscriptionResponseDto,
    type TagResponseDto,
  } from '@frameleaf/sdk';
  import { onMount, tick, untrack } from 'svelte';
  import { t, type Translations } from 'svelte-i18n';
  import {
    MEDIA_INTERVALS,
    mediaReceiptKey,
    parseMediaUrls,
    privateMediaParents,
    type MediaInterval,
  } from './boards-media';
  import MediaImportProgress from './MediaImportProgress.svelte';

  let {
    subscription = false,
    initialAlbumId,
    onOpenResult,
    onSaved,
    onSubscribed,
  }: {
    subscription?: boolean;
    initialAlbumId?: string;
    onOpenResult: () => void;
    onSaved: (assetIds: string[], albumId: string) => void;
    onSubscribed: (value: MediaSubscriptionResponseDto) => void;
  } = $props();

  const catalogController = new AbortController();
  const ownerId = authManager.authenticated ? authManager.user.id : '';
  const receipts = new Map<string, string>();
  const id = $props.id();
  const historyModes = [MediaHistoryMode.All, MediaHistoryMode.Since, MediaHistoryMode.New];
  let urls = $state('');
  let connectionId = $state('');
  let albumId = $state<string | null>(untrack(() => (subscription ? null : (initialAlbumId ?? null))));
  let selectedItems = $state<string[]>([]);
  let selectedTags = $state<string[]>([]);
  let tagQuery = $state('');
  let overrideSuppression = $state(false);
  let historyMode = $state<MediaHistoryMode>();
  let since = $state('');
  let interval = $state<MediaInterval>(60);
  let operation = $state<MediaImportResponseDto>();
  let download = $state<MediaImportResponseDto>();
  let connections = $state<MediaConnectionResponseDto[]>([]);
  let albums = $state<AlbumResponseDto[]>([]);
  let tags = $state<TagResponseDto[]>([]);
  let catalogFailed = $state(false);
  let connectionListFailed = $state(false);
  let catalogLoading = $state(true);
  let busy = $state(false);
  let error = $state<Translations | ''>('');
  let previewHeading = $state<HTMLHeadingElement>();
  let urlInput = $state<HTMLInputElement | HTMLTextAreaElement>();

  const ready = $derived(operation?.state === MediaImportState.Ready);
  const eligibleFeed = $derived(operation?.kind === MediaInspectionKind.Feed && !!operation.creatorId);
  const draftUrls = $derived(parseMediaUrls(urls, subscription ? 1 : 20));
  const validAlbum = $derived(!!albumId && albums.some((album) => album.id === albumId));
  const mediaKinds = $derived([...new Set(operation?.items.map(({ kind }) => kind))]);
  const matchingTags = $derived(tags.filter((tag) => tag.value.toLowerCase().includes(tagQuery.trim().toLowerCase())));
  const history = $derived.by(() => {
    if (!historyMode) {
      return;
    }
    if (historyMode !== MediaHistoryMode.Since) {
      return { mode: historyMode };
    }
    const date = new Date(`${since}T00:00:00`);
    if (Number.isFinite(date.getTime())) {
      return { mode: historyMode, since: date.toISOString() };
    }
  });
  const canSubmit = $derived(
    ready && !busy && (subscription ? eligibleFeed && !!history : validAlbum && selectedItems.length > 0),
  );

  const loadCatalog = async () => {
    catalogFailed = false;
    catalogLoading = true;
    const opts = { signal: catalogController.signal };
    try {
      const [catalog, allAlbums] = await Promise.all([
        getCaptureCatalog(opts),
        getAllAlbums({ libraryScope: LibraryViewScope.Design }, opts),
      ]);
      const writable = new Set(catalog.albums.map(({ id }) => id));
      const eligible = subscription ? privateMediaParents(allAlbums, ownerId) : allAlbums;
      albums = eligible.filter(({ id }) => writable.has(id));
      if (albumId && albums.every(({ id }) => id !== albumId)) {
        albumId = null;
      }
      tags = catalog.tags;
    } catch {
      catalogFailed = true;
    } finally {
      catalogLoading = false;
    }
  };

  const loadConnections = async () => {
    connectionListFailed = false;
    try {
      const result = await getMediaConnections({ signal: catalogController.signal });
      connections = result.connections.filter(({ status }) => status === MediaConnectionStatus.Connected);
    } catch {
      connectionListFailed = true;
    }
  };

  onMount(() => {
    void loadCatalog();
    void loadConnections();
    return () => catalogController.abort();
  });

  $effect(() => {
    if (ready || download) {
      void tick().then(() => {
        if (!previewHeading?.closest('[hidden]')) {
          previewHeading?.focus();
        }
      });
    }
  });

  const changeUrls = async () => {
    operation = undefined;
    error = '';
    await tick();
    urlInput?.focus();
  };

  const inspect = async (event: SubmitEvent) => {
    event.preventDefault();
    if (busy || draftUrls.length === 0) {
      return;
    }
    const mediaInspectDto = { urls: [...draftUrls], connectionId: connectionId || undefined };
    busy = true;
    error = '';
    selectedItems = [];
    historyMode = undefined;
    try {
      const preview = subscription ? previewMediaSubscription : inspectMedia;
      operation = await preview({ mediaInspectDto }, { signal: catalogController.signal });
    } catch {
      error = 'frameleaf_boards_media_inspect_error';
    } finally {
      busy = false;
    }
  };

  const submit = async (event: SubmitEvent) => {
    event.preventDefault();
    if (!canSubmit || !operation) {
      return;
    }
    const inspectionId = operation.id;
    busy = true;
    error = '';
    try {
      if (subscription && history) {
        const draft = { inspectionId, history, intervalMinutes: interval, parentId: albumId ?? undefined };
        const result = await createMediaSubscription({
          mediaSubscriptionCreateDto: { ...draft, idempotencyKey: mediaReceiptKey(receipts, draft) },
        });
        if (!catalogController.signal.aborted) {
          onSubscribed(result);
        }
      } else if (albumId) {
        const draft = {
          inspectionId,
          albumId,
          itemIds: [...selectedItems].sort(),
          tagIds: [...selectedTags].sort(),
          overrideSuppression,
        };
        download = await createMediaImport({
          mediaImportCreateDto: { ...draft, idempotencyKey: mediaReceiptKey(receipts, draft) },
        });
      }
    } catch {
      error = 'frameleaf_boards_media_save_error';
    } finally {
      busy = false;
    }
  };
</script>

{#if error}<InlineError compact message={$t(error)} />{/if}
{#if download}
  <h3 tabindex="-1" bind:this={previewHeading}>{$t('frameleaf_boards_media_download_progress')}</h3>
  <p class="media-secondary">{$t('frameleaf_boards_media_runs_on_library')}</p>
  <MediaImportProgress bind:operation={download} {onOpenResult} {onSaved} />
{:else if operation && !ready}
  <MediaImportProgress bind:operation details={false} />
  <div><Button onclick={() => void changeUrls()}>{$t('frameleaf_boards_media_change_addresses')}</Button></div>
{:else if operation && ready}
  <h3 tabindex="-1" bind:this={previewHeading}>{$t('frameleaf_boards_media_preview')}</h3>
  <p class="media-secondary">{$t('frameleaf_boards_media_preview_limit')}</p>
  <div>
    <Button disabled={busy} onclick={() => void changeUrls()}>{$t('frameleaf_boards_media_change_addresses')}</Button>
  </div>
  {#if operation.limitation}
    <p class="media-secondary">{operation.limitation}</p>
  {:else if !operation.complete}
    <p class="media-secondary">{$t('frameleaf_boards_media_incomplete_preview')}</p>
  {/if}
  {#if subscription && !eligibleFeed}
    <InlineError compact message={$t('frameleaf_boards_media_feed_required')} />
  {:else}
    <form class="media-fields" onsubmit={(event) => void submit(event)}>
      {#if subscription}
        <p><strong>{operation.creator ?? operation.creatorId} · {operation.provider}</strong></p>
        {#if mediaKinds.length}
          <ul class="media-kinds" aria-label={$t('frameleaf_boards_media_types')}>
            {#each mediaKinds as kind (kind)}<li>{$t(`frameleaf_boards_media_kind_${kind}`)}</li>{/each}
          </ul>
        {/if}
        <p class="media-secondary">
          {$t('frameleaf_boards_media_access', {
            values: {
              name:
                connections.find(({ id }) => id === operation?.connectionId)?.label ??
                $t('frameleaf_boards_media_public_access'),
            },
          })}
        </p>
        <fieldset class="media-options" disabled={busy}>
          <legend>{$t('frameleaf_boards_media_history_choice')}</legend>
          {#each historyModes as mode (mode)}
            <label class="media-check">
              <input type="radio" name="{id}-history" value={mode} bind:group={historyMode} />
              {$t(`frameleaf_boards_media_history_${mode}`)}
            </label>
          {/each}
          {#if historyMode === MediaHistoryMode.Since}
            <label class="media-field">
              {$t('frameleaf_boards_media_since_date')}
              <input type="date" bind:value={since} required />
            </label>
          {/if}
        </fieldset>
        <label class="media-field">
          {$t('frameleaf_boards_media_interval')}
          <select bind:value={interval} disabled={busy}>
            {#each MEDIA_INTERVALS as value (value)}
              <option {value}>{$t(`frameleaf_boards_media_interval_${value}`)}</option>
            {/each}
          </select>
        </label>
        <p class="media-secondary">{$t('frameleaf_boards_media_private_collection')}</p>
      {:else}
        {#if operation.kind === MediaInspectionKind.Feed}
          <p>{$t('frameleaf_boards_media_feed_selection')}</p>
        {/if}
        {#if operation.items.length}
          <fieldset class="media-options" disabled={busy}>
            <legend>
              {$t('frameleaf_boards_media_selected', { values: { count: selectedItems.length } })}
            </legend>
            <div class="media-scroll">
              {#each operation.items as item (item.id)}
                {@const pageUrl = libraryReferenceUrl(item.pageUrl)}
                <div class="media-item">
                  <label class="media-check">
                    <input type="checkbox" value={item.id} bind:group={selectedItems} />
                    <span>
                      <strong>{item.title || $t(`frameleaf_boards_media_kind_${item.kind}`)}</strong>
                      <small class="media-secondary"
                        >{$t(`frameleaf_boards_media_kind_${item.kind}`)}{item.creator
                          ? ` · ${item.creator}`
                          : ''}</small
                      >
                    </span>
                  </label>
                  {#if pageUrl}
                    <a href={pageUrl} target="_blank" rel="noopener noreferrer"
                      >{$t('frameleaf_boards_media_open_source')}</a
                    >
                  {/if}
                </div>
              {/each}
            </div>
          </fieldset>
        {:else}
          <p>{$t('frameleaf_boards_media_no_attachments')}</p>
        {/if}
      {/if}
      {#if catalogFailed}
        <InlineError compact message={$t('frameleaf_boards_media_catalog_error')} onRetry={loadCatalog} />
      {:else if catalogLoading}
        <p role="status">{$t('loading')}</p>
      {:else if albums.length}
        <details open={!subscription}>
          <summary>{$t(subscription ? 'frameleaf_boards_media_parent' : 'frameleaf_boards_media_destination')}</summary>
          <AlbumDestinationPicker
            {albums}
            value={albumId}
            onChange={(id) => (albumId = id)}
            allowTop={subscription}
            topLabel={$t('frameleaf_boards_media_top_level')}
            name="{id}-album"
            label={$t(subscription ? 'frameleaf_boards_media_parent' : 'frameleaf_boards_media_destination')}
            recent={7}
          />
        </details>
      {:else if !subscription}
        <p>{$t('frameleaf_boards_media_no_destination')}</p>
      {/if}
      {#if !subscription}
        {#if tags.length}
          <details>
            <summary>{$t('frameleaf_boards_media_tags_selected', { values: { count: selectedTags.length } })}</summary>
            <label class="media-field">
              {$t('frameleaf_boards_media_find_tags')}
              <input type="search" bind:value={tagQuery} />
            </label>
            <div class="media-scroll">
              {#each matchingTags as tag (tag.id)}
                <label class="media-check">
                  <input
                    type="checkbox"
                    value={tag.id}
                    disabled={busy || (selectedTags.length >= 500 && !selectedTags.includes(tag.id))}
                    checked={selectedTags.includes(tag.id)}
                    onchange={(event) => {
                      selectedTags = event.currentTarget.checked
                        ? [...selectedTags, tag.id]
                        : selectedTags.filter((id) => id !== tag.id);
                    }}
                  />
                  {tag.value}
                </label>
              {:else}
                <p>{$t('frameleaf_boards_media_no_matching_tags')}</p>
              {/each}
            </div>
          </details>
        {/if}
        <label class="media-check">
          <input type="checkbox" bind:checked={overrideSuppression} disabled={busy} aria-describedby="{id}-restore" />
          {$t('frameleaf_boards_media_reimport')}
        </label>
        <p class="media-secondary" id="{id}-restore">{$t('frameleaf_boards_media_reimport_hint')}</p>
      {/if}
      <div>
        <Button type="submit" variant="primary" disabled={!canSubmit}>
          {$t(subscription ? 'frameleaf_boards_media_subscribe' : 'frameleaf_boards_media_start_download')}
        </Button>
      </div>
    </form>
  {/if}
{:else}
  <form class="media-fields" onsubmit={(event) => void inspect(event)}>
    <label class="media-field">
      {$t(subscription ? 'frameleaf_boards_media_creator_url' : 'frameleaf_boards_media_urls')}
      {#if subscription}
        <input
          type="url"
          bind:this={urlInput}
          bind:value={urls}
          maxlength="8192"
          required
          data-initial-focus
          disabled={busy}
        />
      {:else}
        <textarea
          rows="4"
          bind:this={urlInput}
          bind:value={urls}
          aria-describedby="{id}-url-hint"
          required
          data-initial-focus
          disabled={busy}></textarea>
      {/if}
    </label>
    {#if !subscription}
      <p id="{id}-url-hint" class="media-secondary">{$t('frameleaf_boards_media_urls_hint')}</p>
    {/if}
    {#if connectionListFailed}
      <InlineError compact message={$t('frameleaf_boards_media_connections_error')} onRetry={loadConnections} />
    {/if}
    {#if connections.length}
      <label class="media-field">
        {$t('frameleaf_boards_media_connection')}
        <select bind:value={connectionId} disabled={busy}>
          <option value="">{$t('frameleaf_boards_media_public_access')}</option>
          {#each connections as connection (connection.id)}
            <option value={connection.id}>{connection.label} · {connection.domains.join(', ')}</option>
          {/each}
        </select>
      </label>
    {/if}
    <div>
      <Button type="submit" variant="primary" disabled={busy || draftUrls.length === 0}>
        {$t(subscription ? 'frameleaf_boards_media_preview_creator' : 'frameleaf_boards_media_inspect')}
      </Button>
    </div>
  </form>
{/if}

<style>
  .media-item {
    padding-block: var(--fl-space-1);
    border-bottom: 1px solid var(--fl-border);
  }
  .media-item small {
    display: block;
  }
  .media-kinds {
    display: flex;
    gap: var(--fl-space-3);
    margin: 0;
    padding: 0;
    list-style: none;
  }
</style>
