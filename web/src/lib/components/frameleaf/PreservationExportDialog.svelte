<script lang="ts">
  /**
   * Preservation export (FL-74, `IMP-006`).
   *
   * Ported from the design's "Preservation export" workflow (`WorkflowDialog` with the
   * `preservation` workflow in `design/frameleaf/template/src/CommandCenter.jsx`, opened by
   * "Preview preservation manifest" on Import & protection → Originals & preservation): Include →
   * Verify → Manifest, in a wide dialog with the design's stepper and facts list.
   *
   * - **Include.** What to preserve — the whole library, favourites, a range of dates, chosen
   *   albums, a typed search (the search palette's operators and free text, compiled to the server's
   *   filter) or the items chosen in the selection bar ("Export for preservation…") — and whether
   *   metadata sidecars and edit recipes travel with the originals. Checksums and the manifest
   *   always do (the prototype's "Include checksums and a manifest" is shown on and locked).
   *   Locked items only from an unlocked session.
   * - **Verify.** The server counts the selection, measures it and checks it fits in one package
   *   and in the free space where it is written. Nothing is written.
   * - **Manifest.** What the package holds and, category by category, what a restoration brings
   *   back, keeps only as provenance or leaves out.
   *
   * Starting the export makes a durable job: closing the page does not stop it, and Activity and
   * the package list follow it. The original files stay in the library.
   */
  import Badge from '$lib/components/frameleaf/Badge.svelte';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Chip from '$lib/components/frameleaf/Chip.svelte';
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import SegmentedControl from '$lib/components/frameleaf/SegmentedControl.svelte';
  import SettingToggle from '$lib/components/frameleaf/settings/SettingToggle.svelte';
  import {
    EXPORT_STEPS,
    MANIFEST_FACTS,
    PRESERVATION_MAX_SELECTED,
    asBytes,
    defaultPackageName,
    emptyScope,
    groupSupport,
    hasRoomFor,
    newRequestKey,
    scopeToRequest,
    searchScope,
    selectionShortfall,
    supportCategoryKey,
    supportLevelKey,
    supportTone,
    type ScopeChoice,
    type ScopeKind,
  } from '$lib/frameleaf/preservation';
  import {
    buildPaletteCatalog,
    emptyPaletteCatalog,
    MAX_PALETTE_TEXT,
    tokenLabel,
  } from '$lib/frameleaf/search-palette';
  import { loadFilterPanelOptions } from '$lib/frameleaf/search-options';
  import { Route } from '$lib/route';
  import { getByteUnitString } from '$lib/utils/byte-units';
  import { handleError } from '$lib/utils/handle-error';
  import {
    createPreservationPackage,
    getAllAlbums,
    previewPreservationExport,
    type AlbumResponseDto,
    type PreservationPackageDto,
    type PreservationPreviewResponseDto,
  } from '@immich/sdk';
  import { page } from '$app/state';
  import { untrack } from 'svelte';
  import { locale, t } from 'svelte-i18n';

  type Props = {
    open?: boolean;
    /** The section's "Include metadata and edit recipes" choice, carried into the export. */
    includeMetadata?: boolean;
    /**
     * The selection bar's items ("Export for preservation…"): the account's own, and how many known
     * to be someone else's were left out. When set, the dialog opens on "Selected items".
     */
    selection?: { assetIds: string[]; leftOut: number } | null;
    /** Start with "Include Locked items" on: the selection was made in the Locked view. */
    includeLockedDefault?: boolean;
    onCreated?: (created: PreservationPackageDto) => void;
  };

  let {
    open = $bindable(false),
    includeMetadata = $bindable(true),
    selection = null,
    includeLockedDefault = false,
    onCreated,
  }: Props = $props();

  let step = $state(0);
  let scope = $state<ScopeChoice>(emptyScope());
  let name = $state('');
  let includeLocked = $state(false);
  let albums = $state<AlbumResponseDto[]>([]);
  let albumsLoaded = $state(false);
  let preview = $state<PreservationPreviewResponseDto | null>(null);
  let previewing = $state(false);
  let starting = $state(false);
  let requestKey = $state(newRequestKey());
  let searchInput = $state('');
  let catalog = $state(emptyPaletteCatalog());
  let catalogLoaded = $state(false);

  const search = $derived(searchScope(searchInput, catalog));
  const selectedCount = $derived(selection?.assetIds.length ?? 0);
  const request = $derived(
    scopeToRequest({ ...scope, searchFilter: search.filter, assetIds: selection?.assetIds ?? [] }),
  );
  const shortfall = $derived(preview && scope.kind === 'selection' ? selectionShortfall(selectedCount, preview) : 0);
  const bytes = (value: string | null | undefined) => {
    const parsed = asBytes(value);
    return parsed === null ? '—' : getByteUnitString(parsed, $locale ?? undefined);
  };
  const albumCount = (count: number) => $t('frameleaf_preservation_scope_album_count', { values: { count } });
  const room = $derived(preview ? hasRoomFor(preview.includedBytes, preview.freeBytes) : null);
  const canStart = $derived(
    !!preview && !!request && preview.withinLimit && preview.includedItems > 0 && room !== false && !starting,
  );
  const unlockHref = $derived(Route.pinPrompt({ continue: `${page.url.pathname}${page.url.search}` }));

  const scopeOptions = $derived([
    { value: 'library', label: $t('frameleaf_preservation_scope_library') },
    { value: 'favorites', label: $t('frameleaf_preservation_scope_favorites') },
    { value: 'dates', label: $t('frameleaf_preservation_scope_dates') },
    { value: 'albums', label: $t('frameleaf_preservation_scope_albums') },
    { value: 'search', label: $t('frameleaf_preservation_scope_search') },
    ...(selection ? [{ value: 'selection', label: $t('frameleaf_preservation_scope_selection') }] : []),
  ]);

  /** The account's own people, tags, places and cameras, so `person:Jamie` resolves as in Search. */
  const loadCatalog = async () => {
    if (catalogLoaded) {
      return;
    }
    catalogLoaded = true;
    try {
      catalog = buildPaletteCatalog(await loadFilterPanelOptions());
    } catch (error) {
      catalogLoaded = false;
      handleError(error, $t('frameleaf_preservation_search_error'));
    }
  };

  const loadAlbums = async () => {
    if (albumsLoaded) {
      return;
    }
    try {
      albums = (await getAllAlbums({ isOwned: true })).sort((a, b) => a.albumName.localeCompare(b.albumName));
      albumsLoaded = true;
    } catch (error) {
      handleError(error, $t('frameleaf_preservation_albums_error'));
    }
  };

  const setKind = (value: string) => {
    scope = { ...scope, kind: value as ScopeKind };
    preview = null;
    if (value === 'albums') {
      void loadAlbums();
    } else if (value === 'search') {
      void loadCatalog();
    }
  };

  const toggleAlbum = (id: string) => {
    scope = {
      ...scope,
      albumIds: scope.albumIds.includes(id) ? scope.albumIds.filter((item) => item !== id) : [...scope.albumIds, id],
    };
    preview = null;
  };

  const runPreview = async () => {
    if (!request) {
      return;
    }
    previewing = true;
    try {
      preview = await previewPreservationExport({ preservationPreviewDto: { scope: request, includeLocked } });
      if (includeLocked && !preview.lockedAllowed) {
        includeLocked = false;
      }
      step = 1;
    } catch (error) {
      handleError(error, $t('frameleaf_preservation_preview_error'));
    } finally {
      previewing = false;
    }
  };

  const start = async () => {
    if (!request || !canStart) {
      return;
    }
    starting = true;
    try {
      const created = await createPreservationPackage({
        preservationExportCreateDto: {
          name: name.trim() || defaultPackageName(scope),
          scope: request,
          includeLocked: includeLocked && !!preview?.lockedAllowed,
          includeMetadata,
          requestKey,
        },
      });
      onCreated?.(created);
      open = false;
    } catch (error) {
      handleError(error, $t('frameleaf_preservation_start_error'));
    } finally {
      starting = false;
    }
  };

  const back = () => {
    if (step === 0) {
      open = false;
    } else {
      step--;
    }
  };

  // A fresh dialog each time it opens: a new request key, the first step, nothing measured yet.
  $effect(() => {
    if (!open) {
      return;
    }

    step = 0;
    preview = null;
    requestKey = newRequestKey();
    untrack(() => {
      scope = { ...scope, kind: selection ? 'selection' : scope.kind === 'selection' ? 'library' : scope.kind };
      includeLocked = includeLockedDefault;
    });
  });
</script>

<Dialog bind:open title={$t('frameleaf_preservation_export_title')} closeLabel={$t('close')} wide>
  <div class="workflow">
    <ol class="stepper">
      {#each EXPORT_STEPS as key, index (key)}
        <li aria-current={step === index ? 'step' : undefined}>
          <span>{index + 1}</span>{$t(key)}
        </li>
      {/each}
    </ol>
    <p>{$t('frameleaf_preservation_export_intro')}</p>

    {#if step === 0}
      <fieldset class="scope">
        <legend>{$t('frameleaf_preservation_scope_label')}</legend>
        <SegmentedControl
          label={$t('frameleaf_preservation_scope_label')}
          options={scopeOptions}
          value={scope.kind}
          onChange={setKind}
        />
        {#if scope.kind === 'dates'}
          <div class="dates">
            <label>
              {$t('frameleaf_preservation_scope_from')}
              <input type="date" bind:value={scope.from} onchange={() => (preview = null)} />
            </label>
            <label>
              {$t('frameleaf_preservation_scope_to')}
              <input type="date" bind:value={scope.to} onchange={() => (preview = null)} />
            </label>
          </div>
        {:else if scope.kind === 'albums'}
          {#if albums.length === 0 && albumsLoaded}
            <p class="hint">{$t('frameleaf_preservation_scope_no_albums')}</p>
          {:else}
            <ul class="albums" aria-label={$t('frameleaf_preservation_scope_albums')}>
              {#each albums as album (album.id)}
                <li>
                  <label>
                    <input
                      type="checkbox"
                      checked={scope.albumIds.includes(album.id)}
                      onchange={() => toggleAlbum(album.id)}
                    />
                    <span>{album.albumName}</span>
                    <small>{albumCount(album.assetCount)}</small>
                  </label>
                </li>
              {/each}
            </ul>
          {/if}
        {:else if scope.kind === 'search'}
          <!-- The search palette's typed operators (SearchPalette.jsx), in the dialog's field style. -->
          <label class="name">
            {$t('frameleaf_preservation_scope_search_label')}
            <input
              type="search"
              bind:value={searchInput}
              oninput={() => (preview = null)}
              placeholder={$t('frameleaf_preservation_scope_search_placeholder')}
              aria-describedby="preservation-search-hint"
            />
            <small id="preservation-search-hint">{$t('frameleaf_preservation_scope_search_hint')}</small>
          </label>
          {#if search.tokens.length > 0 || search.text}
            <ul class="chips" aria-label={$t('frameleaf_preservation_scope_search_understood')}>
              {#each search.tokens as token, index (`${index}:${token.raw}`)}
                <li><Chip label={tokenLabel($t, token)} /></li>
              {/each}
              {#if search.text}
                <li>
                  <Chip label={$t('frameleaf_preservation_scope_search_text', { values: { text: search.text } })} />
                </li>
              {/if}
            </ul>
          {/if}
          {#if search.tooComplex}
            <p class="note" role="alert">{$t('frameleaf_preservation_scope_search_too_complex')}</p>
          {:else if search.truncated}
            <p class="hint">
              {$t('frameleaf_preservation_scope_search_truncated', { values: { count: MAX_PALETTE_TEXT } })}
            </p>
          {/if}
        {:else if scope.kind === 'selection' && selection}
          <p class="hint">
            {$t('frameleaf_preservation_scope_selection_count', { values: { count: selectedCount } })}
          </p>
          {#if selection.leftOut > 0}
            <p class="note">
              {$t('frameleaf_preservation_scope_selection_left_out', { values: { count: selection.leftOut } })}
            </p>
          {/if}
          {#if selectedCount > PRESERVATION_MAX_SELECTED}
            <p class="note" role="alert">
              {$t('frameleaf_preservation_scope_selection_too_many', { values: { max: PRESERVATION_MAX_SELECTED } })}
            </p>
          {/if}
        {/if}
      </fieldset>

      <label class="name">
        {$t('frameleaf_preservation_name')}
        <input
          type="text"
          maxlength="120"
          bind:value={name}
          placeholder={defaultPackageName(scope)}
          aria-describedby="preservation-name-hint"
        />
        <small id="preservation-name-hint">{$t('frameleaf_preservation_name_hint')}</small>
      </label>

      <div class="controls">
        <SettingToggle
          title={$t('frameleaf_preservation_include_metadata')}
          subtitle={$t('frameleaf_preservation_include_metadata_help')}
          bind:checked={includeMetadata}
        />
        <SettingToggle
          title={$t('frameleaf_preservation_include_checksums')}
          subtitle={$t('frameleaf_preservation_include_checksums_help')}
          checked={true}
          disabled={true}
        >
          <small class="policy">{$t('frameleaf_preservation_always_protected')}</small>
        </SettingToggle>
        <SettingToggle
          title={$t('frameleaf_preservation_include_locked')}
          subtitle={$t('frameleaf_preservation_include_locked_help')}
          bind:checked={includeLocked}
        >
          {#if includeLocked && preview && !preview.lockedAllowed}
            <small class="policy">
              <a href={unlockHref}>{$t('frameleaf_preservation_unlock_to_include')}</a>
            </small>
          {/if}
        </SettingToggle>
      </div>
    {:else if step === 1 && preview}
      <dl class="facts">
        <dt>{$t('frameleaf_preservation_verify_items')}</dt>
        <dd>
          {$t('frameleaf_preservation_verify_items_value', {
            values: { count: preview.includedItems, size: bytes(preview.includedBytes) },
          })}
        </dd>
        {#if scope.kind === 'selection' && selection}
          <dt>{$t('frameleaf_preservation_verify_left_out')}</dt>
          <dd>
            {#if selection.leftOut === 0 && shortfall === 0}
              {$t('frameleaf_preservation_verify_left_out_none')}
            {:else}
              {#if selection.leftOut > 0}
                <span class="line">
                  {$t('frameleaf_preservation_scope_selection_left_out', { values: { count: selection.leftOut } })}
                </span>
              {/if}
              {#if shortfall > 0}
                <span class="line">
                  {$t('frameleaf_preservation_verify_left_out_unavailable', { values: { count: shortfall } })}
                </span>
              {/if}
            {/if}
          </dd>
        {/if}
        <dt>{$t('frameleaf_preservation_verify_locked')}</dt>
        <dd>
          {#if !preview.lockedAllowed}
            {$t('frameleaf_preservation_verify_locked_hidden')}
            <a href={unlockHref}>{$t('frameleaf_preservation_unlock_to_include')}</a>
          {:else if includeLocked}
            {$t('frameleaf_preservation_verify_locked_included', { values: { count: preview.lockedItems } })}
          {:else}
            {$t('frameleaf_preservation_verify_locked_excluded', { values: { count: preview.lockedItems } })}
          {/if}
        </dd>
        <dt>{$t('frameleaf_preservation_verify_space')}</dt>
        <dd>
          {#if preview.freeBytes === null}
            {$t('frameleaf_preservation_verify_space_unknown')}
          {:else}
            {$t('frameleaf_preservation_verify_space_value', { values: { size: bytes(preview.freeBytes) } })}
          {/if}
        </dd>
        <dt>{$t('frameleaf_preservation_verify_checksums')}</dt>
        <dd>{$t('frameleaf_preservation_verify_checksums_value')}</dd>
      </dl>
      {#if preview.includedItems === 0}
        <p class="note" role="alert">{$t('frameleaf_preservation_verify_empty')}</p>
      {:else if !preview.withinLimit}
        <p class="note" role="alert">
          {$t('frameleaf_preservation_verify_too_many', { values: { max: preview.maxItems } })}
        </p>
      {:else if room === false}
        <p class="note" role="alert">{$t('frameleaf_preservation_verify_no_room')}</p>
      {/if}
    {:else if step === 2 && preview}
      <dl class="facts">
        {#each MANIFEST_FACTS as fact (fact.labelKey)}
          <dt>{$t(fact.labelKey)}</dt>
          <dd>{$t(fact.valueKey)}</dd>
        {/each}
      </dl>
      <section class="support" aria-labelledby="preservation-support-heading">
        <h3 id="preservation-support-heading">{$t('frameleaf_preservation_support_heading')}</h3>
        {#each groupSupport(preview.support) as group (group.level)}
          <div class="support-group">
            <Badge
              tone={supportTone(group.level)}
              value={group.categories.length}
              label={$t('frameleaf_preservation_support_count', { values: { count: group.categories.length } })}
            />
            <strong>{$t(supportLevelKey(group.level))}</strong>
            <span>{group.categories.map((category) => $t(supportCategoryKey(category))).join(', ')}</span>
          </div>
        {/each}
        {#if !includeMetadata}
          <p class="note">{$t('frameleaf_preservation_support_originals_only')}</p>
        {/if}
      </section>
      <p class="notice">{$t('frameleaf_preservation_export_final')}</p>
    {/if}

    <footer>
      <Button onclick={back}>{step === 0 ? $t('cancel') : $t('back')}</Button>
      {#if step === 0}
        <Button variant="primary" disabled={!request || previewing} onclick={runPreview}>
          {previewing ? $t('frameleaf_preservation_checking') : $t('continue')}
        </Button>
      {:else if step === 1}
        <Button disabled={previewing} onclick={runPreview}>{$t('frameleaf_preservation_check_again')}</Button>
        <Button
          variant="primary"
          disabled={!preview || !preview.withinLimit || preview.includedItems === 0 || room === false}
          onclick={() => (step = 2)}
        >
          {$t('continue')}
        </Button>
      {:else}
        <Button variant="primary" disabled={!canStart} onclick={start}>
          {starting ? $t('frameleaf_preservation_starting') : $t('frameleaf_preservation_start')}
        </Button>
      {/if}
    </footer>
  </div>
</Dialog>

<style>
  .workflow {
    display: flex;
    flex-direction: column;
    gap: 0.875rem;
    margin-top: 1rem;
    font-size: var(--fl-font-size);
  }
  .workflow > p {
    margin: 0;
  }
  .stepper {
    display: flex;
    flex-wrap: wrap;
    gap: 1.25rem;
    margin: 0 0 0.5rem;
    padding: 0;
    list-style: none;
  }
  .stepper li {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  .stepper li > span {
    display: grid;
    place-items: center;
    width: 22px;
    height: 22px;
    font-size: var(--fl-font-micro);
    background: var(--fl-raised);
    border: 1px solid var(--fl-border);
    border-radius: 50%;
  }
  .stepper li[aria-current] {
    color: var(--fl-text);
  }
  .stepper li[aria-current] > span {
    color: var(--fl-accent-text);
    background: var(--fl-accent);
    border-color: var(--fl-accent);
  }
  .scope {
    display: flex;
    flex-direction: column;
    gap: 0.625rem;
    margin: 0;
    padding: 0;
    border: 0;
  }
  .scope legend,
  .name {
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  .dates {
    display: flex;
    flex-wrap: wrap;
    gap: 1rem;
  }
  .dates label,
  .name {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }
  input[type='date'],
  input[type='search'],
  input[type='text'] {
    padding: 0.375rem 0.5rem;
    color: var(--fl-text);
    background: var(--fl-raised);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
  }
  .albums {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
    max-height: 14rem;
    margin: 0;
    padding: 0;
    overflow-y: auto;
    list-style: none;
  }
  .albums label {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  .albums input {
    accent-color: var(--fl-accent);
  }
  .albums small,
  .name small,
  .hint {
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: 0.375rem;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .facts .line {
    display: block;
  }
  .controls {
    display: flex;
    flex-direction: column;
  }
  .policy {
    display: block;
    margin-top: 0.25rem;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  .facts {
    display: grid;
    grid-template-columns: minmax(7rem, 11rem) 1fr;
    gap: 0.625rem 1rem;
    margin: 0;
  }
  .facts dt {
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  .facts dd {
    margin: 0;
    font-size: var(--fl-font-small);
    line-height: 1.6;
    overflow-wrap: anywhere;
  }
  .support {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  .support h3 {
    margin: 0;
    font-size: var(--fl-font-size);
  }
  .support-group {
    display: grid;
    grid-template-columns: auto minmax(8rem, 12rem) 1fr;
    gap: 0.5rem;
    align-items: baseline;
    font-size: var(--fl-font-small);
  }
  .support-group span {
    color: var(--fl-muted);
  }
  .note,
  .notice {
    margin: 0;
    padding: 0.625rem 0.875rem;
    font-size: var(--fl-font-small);
    line-height: 1.6;
    background: var(--fl-raised);
    border-left: 2px solid var(--fl-accent);
  }
  .note {
    border-left-color: var(--fl-warning);
  }
  footer {
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: 0.5rem;
    margin-top: 0.5rem;
  }
  @media (max-width: 40rem) {
    .facts,
    .support-group {
      grid-template-columns: 1fr;
    }
  }
</style>
