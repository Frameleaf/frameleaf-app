<script lang="ts">
  /**
   * iCloud Photos (FL-68), ported from the `ICloudPanel` of the design template's
   * `UtilitiesManager.jsx`: independent connections, a sign-in dialog that asks only for the step the
   * server says is next, source libraries and albums, what to include, sync limits, the run controls
   * and the reconciliation results.
   *
   * Everything shown is the server's. A run is a durable media operation — the same row Activity and
   * the notifications panel show — so progress survives closing this page, and the controls act on
   * that row. The Apple password and verification code live only in this component's memory for the
   * one request that uses them, are cleared as soon as it is sent, and are never put in a URL, in
   * storage or in the page's history. Nothing here deletes a photo: disconnecting and removing a
   * connection leave everything it imported in the library.
   */
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import {
    ICLOUD_MAX_CONNECTIONS,
    icloudAuthStep,
    icloudBlankDraft,
    icloudConsentNeeded,
    icloudDraft,
    icloudDraftProblems,
    icloudDraftUpdate,
    icloudErrorKey,
    icloudOutcomeKey,
    icloudReviewReasonKey,
    icloudReviewTarget,
    icloudRunControls,
    icloudRunProgress,
    icloudStatus,
    icloudStatusKey,
    icloudStatusTone,
    icloudSummary,
    isActiveRun,
    isLibrarySelected,
    toggleAlbum,
    toggleLibrary,
    type ICloudDraft,
  } from '$lib/frameleaf/icloud-sync';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { Route } from '$lib/route';
  import { getServerErrorMessage } from '$lib/utils/handle-error';
  import {
    ICloudAuthAction,
    ICloudControlAction,
    ICloudLibraryArea,
    MediaHealthStatus,
    MediaOperationStatus,
    authenticateICloudConnection,
    controlICloudConnection,
    createICloudConnection,
    disconnectICloudConnection,
    getAuthStatus,
    getICloudInventory,
    listICloudConnections,
    removeICloudConnection,
    updateICloudConnection,
    type ICloudAuthDto,
    type ICloudConnectionResponseDto,
    type ICloudConnectionsResponseDto,
    type ICloudInventoryResponseDto,
  } from '@immich/sdk';
  import { Icon } from '@immich/ui';
  import { mdiCheckCircleOutline, mdiClose, mdiCloudOutline } from '@mdi/js';
  import { onMount } from 'svelte';
  import { t, type Translations } from 'svelte-i18n';

  let { initial }: { initial: ICloudConnectionsResponseDto } = $props();

  // svelte-ignore state_referenced_locally
  let connections = $state<ICloudConnectionResponseDto[]>(initial.connections);
  // svelte-ignore state_referenced_locally
  let enabled = $state(initial.enabled);
  // svelte-ignore state_referenced_locally
  let selectedId = $state(initial.connections[0]?.id ?? '');
  // svelte-ignore state_referenced_locally
  let draft = $state<ICloudDraft>(initial.connections[0] ? icloudDraft(initial.connections[0]) : icloudBlankDraft());
  let inventory = $state<ICloudInventoryResponseDto>();
  let albumSearch = $state('');
  let busy = $state(false);
  let notice = $state('');
  let error = $state('');

  // Secrets: this component's memory only, for the one request that sends them.
  let appleId = $state('');
  let password = $state('');
  let code = $state('');
  let authOpen = $state(false);
  let authError = $state('');
  /** Start the sign-in again from a verification or approval step. */
  let signInAgain = $state(false);

  let consentOpen = $state(false);
  /** Consent already given for the draft restored after unlocking; saving does not ask twice. */
  let consentGiven = $state(false);

  /**
   * The draft and its consent, kept for this tab only across the unlock detour that saving hidden
   * photos needs. Preferences only; a password or code is never written here.
   */
  const PENDING_SAVE_KEY = 'frameleaf.icloud.pending-save';

  const selected = $derived(connections.find(({ id }) => id === selectedId));
  const status = $derived(selected ? icloudStatus(selected) : undefined);
  const controls = $derived(selected ? icloudRunControls(selected) : undefined);
  const step = $derived(selected ? (signInAgain ? 'sign-in' : icloudAuthStep(selected)) : 'sign-in');
  const signedIn = $derived(
    !!selected && selected.authenticated && ['connected', 'paused', 'error'].includes(selected.state),
  );
  const run = $derived(selected?.run ?? null);
  const progress = $derived(icloudRunProgress(run));
  const problems = $derived(icloudDraftProblems(draft));
  const summary = $derived(icloudSummary(selected?.counts ?? {}));
  const consent = $derived(selected ? icloudConsentNeeded(draft, selected) : { hidden: false });
  const libraryIds = $derived(inventory?.libraries.map(({ id }) => id) ?? []);
  const visibleAlbums = $derived(
    (inventory?.albums ?? [])
      .filter(
        (album) =>
          (draft.albums.includes(album.id) || isLibrarySelected(draft, album.libraryId)) &&
          album.name.toLocaleLowerCase().includes(albumSearch.trim().toLocaleLowerCase()),
      )
      .slice(0, 200),
  );
  const anyActive = $derived(
    connections.some((connection) => isActiveRun(connection.run) || connection.state === 'authenticating'),
  );

  const failure = (cause: unknown) => $t(icloudErrorKey(getServerErrorMessage(cause)));

  const libraryLabel = (library: ICloudInventoryResponseDto['libraries'][number]) => {
    const base =
      library.area === ICloudLibraryArea.Shared
        ? $t('frameleaf_icloud_library_shared')
        : $t('frameleaf_icloud_library_personal');
    const sameArea = inventory?.libraries.filter(({ area }) => area === library.area).length ?? 0;
    return sameArea > 1 ? `${base} · ${library.name}` : base;
  };

  const subtitle = $derived.by(() => {
    if (!selected) {
      return '';
    }
    const libraries = selected.config.libraries.length;
    const albums = selected.config.albums.length;
    const scope =
      libraries === 0
        ? $t('frameleaf_icloud_scope_all_libraries')
        : $t('frameleaf_icloud_scope_libraries', { values: { count: libraries } });
    const parts = [authManager.user.name, scope];
    if (albums > 0) {
      parts.push($t('frameleaf_icloud_scope_albums', { values: { count: albums } }));
    }
    return parts.join(' · ');
  });

  const clearSecrets = () => {
    appleId = '';
    password = '';
    code = '';
  };

  const act = async (action: () => Promise<void>) => {
    busy = true;
    error = '';
    try {
      await action();
    } catch (error_) {
      error = failure(error_);
    } finally {
      busy = false;
    }
  };

  const accept = (connection: ICloudConnectionResponseDto) => {
    connections = connections.some(({ id }) => id === connection.id)
      ? connections.map((item) => (item.id === connection.id ? connection : item))
      : [...connections, connection];
  };

  const loadInventory = async () => {
    const id = selectedId;
    if (!id) {
      return;
    }
    try {
      const loaded = await getICloudInventory({ id });
      if (id === selectedId) {
        inventory = loaded;
      }
    } catch (error_) {
      if (id === selectedId) {
        error = failure(error_);
      }
    }
  };

  const select = (id: string) => {
    const connection = connections.find((item) => item.id === id);
    selectedId = connection?.id ?? '';
    draft = connection ? icloudDraft(connection) : icloudBlankDraft();
    inventory = undefined;
    albumSearch = '';
    authOpen = false;
    consentOpen = false;
    consentGiven = false;
    signInAgain = false;
    authError = '';
    clearSecrets();
    void loadInventory();
  };

  const refresh = () =>
    act(async () => {
      const response = await listICloudConnections();
      connections = response.connections;
      enabled = response.enabled;
      if (connections.every(({ id }) => id !== selectedId)) {
        select(connections[0]?.id ?? '');
        return;
      }
      await loadInventory();
    });

  /** Follow a running sync without a reload; the drafts being edited are left alone. */
  const poll = async () => {
    if (busy) {
      return;
    }
    try {
      const before = selected?.run;
      const response = await listICloudConnections();
      connections = response.connections;
      enabled = response.enabled;
      const after = connections.find(({ id }) => id === selectedId)?.run;
      if (isActiveRun(before) && !isActiveRun(after)) {
        void loadInventory();
      }
    } catch {
      // The next poll tries again; an explicit action reports its own failure.
    }
  };

  $effect(() => {
    if (!enabled || !anyActive) {
      return;
    }
    const handle = setInterval(() => void poll(), 5000);
    return () => clearInterval(handle);
  });

  /** Take back a draft left before the unlock detour, once. */
  const takePendingSave = (): { connectionId: string; draft: Partial<ICloudDraft> } | undefined => {
    try {
      const raw = sessionStorage.getItem(PENDING_SAVE_KEY);
      sessionStorage.removeItem(PENDING_SAVE_KEY);
      const parsed = raw ? JSON.parse(raw) : undefined;
      return parsed && typeof parsed.connectionId === 'string' && parsed.draft && typeof parsed.draft === 'object'
        ? parsed
        : undefined;
    } catch {
      return undefined;
    }
  };

  onMount(() => {
    const pending = takePendingSave();
    if (pending && connections.some(({ id }) => id === pending.connectionId)) {
      select(pending.connectionId);
      draft = { ...icloudBlankDraft(), ...pending.draft };
      consentGiven = true;
      notice = $t('frameleaf_icloud_notice_unlocked');
      return;
    }
    if (selectedId) {
      void loadInventory();
    }
  });

  const addConnection = () =>
    act(async () => {
      const connection = await createICloudConnection({
        iCloudConnectionCreateDto: {
          label: $t('frameleaf_icloud_default_name', { values: { number: connections.length + 1 } }),
        },
      });
      connections = [...connections, connection];
      select(connection.id);
      notice = $t('frameleaf_icloud_notice_added');
    });

  const openAuth = () => {
    authError = '';
    signInAgain = false;
    clearSecrets();
    authOpen = true;
  };

  const authenticate = async (action: ICloudAuthDto['action']) => {
    const id = selectedId;
    const request: ICloudAuthDto =
      action === ICloudAuthAction.Login
        ? { action, appleId: appleId.trim(), password }
        : action === ICloudAuthAction.TwoFactor
          ? { action, code }
          : { action };
    // Sent once; nothing of it stays behind, whatever the answer.
    password = '';
    code = '';
    busy = true;
    authError = '';
    try {
      const connection = await authenticateICloudConnection({ id, iCloudAuthDto: request });
      accept(connection);
      signInAgain = false;
      const next = icloudAuthStep(connection);
      if (next === 'connected' && connection.state === 'connected') {
        appleId = '';
        authOpen = false;
        notice = $t('frameleaf_icloud_notice_connected');
      } else if (connection.lastError) {
        authError = $t(icloudErrorKey(connection.lastError));
      }
    } catch (error_) {
      authError = failure(error_);
    } finally {
      busy = false;
    }
  };

  const disconnect = () =>
    act(async () => {
      await disconnectICloudConnection({ id: selectedId });
      authOpen = false;
      clearSecrets();
      const response = await listICloudConnections();
      connections = response.connections;
      notice = $t('frameleaf_icloud_notice_disconnected');
    });

  const remove = () =>
    act(async () => {
      await removeICloudConnection({ id: selectedId });
      authOpen = false;
      clearSecrets();
      const response = await listICloudConnections();
      connections = response.connections;
      select(connections[0]?.id ?? '');
      notice = $t('frameleaf_icloud_notice_removed');
    });

  const persist = () =>
    act(async () => {
      if (!selected) {
        return;
      }
      consentOpen = false;
      // Hidden iCloud photos arrive Locked, so the server only accepts this from an unlocked session.
      if (draft.includeHidden) {
        const auth = await getAuthStatus();
        if (!auth.isElevated) {
          try {
            sessionStorage.setItem(
              PENDING_SAVE_KEY,
              JSON.stringify({ connectionId: selected.id, draft: $state.snapshot(draft) }),
            );
          } catch {
            // Without storage the draft is typed again after unlocking; nothing else depends on it.
          }
          await goto(Route.pinPrompt({ continue: page.url.pathname }));
          return;
        }
      }
      const connection = await updateICloudConnection({
        id: selected.id,
        iCloudConnectionUpdateDto: icloudDraftUpdate(draft, selected, inventory),
      });
      accept(connection);
      draft = icloudDraft(connection);
      consentGiven = false;
      notice = $t('frameleaf_icloud_notice_saved');
    });

  const save = () => {
    if (!selected || problems.length > 0) {
      return;
    }
    if (consent.hidden && !consentGiven) {
      consentOpen = true;
      return;
    }
    void persist();
  };

  const NOTICES: Record<ICloudControlAction, Translations> = {
    [ICloudControlAction.Run]: 'frameleaf_icloud_notice_run',
    [ICloudControlAction.Pause]: 'frameleaf_icloud_notice_pause',
    [ICloudControlAction.Resume]: 'frameleaf_icloud_notice_resume',
    [ICloudControlAction.Cancel]: 'frameleaf_icloud_notice_cancel',
    [ICloudControlAction.Retry]: 'frameleaf_icloud_notice_retry',
    [ICloudControlAction.Rescan]: 'frameleaf_icloud_notice_rescan',
  };

  const control = (action: ICloudControlAction) =>
    act(async () => {
      accept(await controlICloudConnection({ id: selectedId, iCloudControlDto: { action } }));
      notice = $t(NOTICES[action]);
    });

  const updateDraft = (next: ICloudDraft) => {
    draft = next;
  };

  // Closing the sign-in dialog, however it closes, forgets what was typed into it.
  $effect(() => {
    if (authOpen) {
      return;
    }

    clearSecrets();
    signInAgain = false;
    authError = '';
  });
</script>

<div class="icloud">
  {#if error}
    <p role="alert" class="ic-message error">{error}</p>
  {/if}
  {#if notice}
    <div role="status" class="ic-message">
      <Icon icon={mdiCheckCircleOutline} size="1rem" aria-hidden={true} />
      <span>{notice}</span>
      <Button variant="quiet" label={$t('frameleaf_icloud_dismiss')} onclick={() => (notice = '')}>
        <Icon icon={mdiClose} size="1rem" aria-hidden={true} />
      </Button>
    </div>
  {/if}

  {#if !enabled}
    <div class="ic-empty" role="status">
      <Icon icon={mdiCloudOutline} size="2rem" aria-hidden={true} />
      <h3>{$t('frameleaf_icloud_disabled_title')}</h3>
      <p>{$t('frameleaf_icloud_disabled')}</p>
    </div>
  {:else if !selected}
    <div class="ic-empty">
      <Icon icon={mdiCloudOutline} size="2rem" aria-hidden={true} />
      <h3>{$t('frameleaf_icloud_empty_title')}</h3>
      <p>{$t('frameleaf_icloud_empty')}</p>
      <Button variant="primary" disabled={busy} onclick={() => void addConnection()}>
        {$t('frameleaf_icloud_add_connection')}
      </Button>
    </div>
  {:else}
    <div class="ic-toolbar">
      <label>
        {$t('frameleaf_icloud_connection')}
        <select value={selectedId} disabled={busy} onchange={(event) => select(event.currentTarget.value)}>
          {#each connections as connection (connection.id)}
            <option value={connection.id}>{connection.label}</option>
          {/each}
        </select>
      </label>
      <Button disabled={busy || connections.length >= ICLOUD_MAX_CONNECTIONS} onclick={() => void addConnection()}>
        {$t('frameleaf_icloud_add_connection')}
      </Button>
      <Button variant="quiet" disabled={busy} onclick={() => void refresh()}>{$t('frameleaf_icloud_refresh')}</Button>
    </div>

    <div class="ic-connection">
      <Icon icon={mdiCloudOutline} size="2rem" aria-hidden={true} />
      <div>
        <h2>{selected.label}</h2>
        <p>{subtitle}</p>
        {#if status}
          <span class="ic-badge {icloudStatusTone(status)}" role="status">{$t(icloudStatusKey(status))}</span>
        {/if}
      </div>
      <Button onclick={openAuth}>
        {signedIn ? $t('frameleaf_icloud_review_connection') : $t('frameleaf_icloud_connect_account')}
      </Button>
    </div>

    {#if selected.state === 'error' && selected.lastError}
      <p class="ic-message error" role="alert">{$t(icloudErrorKey(selected.lastError))}</p>
    {/if}

    {#if run}
      <section class="ic-run" aria-label={$t('frameleaf_icloud_run')}>
        <div class="ic-run-head">
          <strong>{status ? $t(icloudStatusKey(status)) : ''}</strong>
          {#if run.totalUnits}
            <span>
              {$t('frameleaf_icloud_run_counts', {
                values: { done: run.processedUnits, total: run.totalUnits },
              })}
            </span>
          {:else if isActiveRun(run)}
            <span>{$t('frameleaf_icloud_run_counting')}</span>
          {/if}
          <a href={Route.activity()}>{$t('frameleaf_icloud_open_activity')}</a>
        </div>
        {#if progress !== null}
          <div
            class="ic-bar"
            role="progressbar"
            aria-label={$t('frameleaf_icloud_run')}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={progress}
          >
            <span style:width="{progress}%"></span>
          </div>
        {/if}
        {#if run.errorCode && (run.retrying || run.status === MediaOperationStatus.Failed)}
          <p class="ic-run-note">{$t(icloudErrorKey(run.errorCode))}</p>
        {/if}
        {#if selected.nextRunAt && !isActiveRun(run)}
          <p class="ic-run-note">
            {$t('frameleaf_icloud_next_run', { values: { date: new Date(selected.nextRunAt).toLocaleString() } })}
          </p>
        {/if}
      </section>
    {/if}

    <div class="ic-work-grid">
      <section>
        <h3>{$t('frameleaf_icloud_photo_libraries')}</h3>
        {#if inventory && inventory.libraries.length > 0}
          {#each inventory.libraries as library (library.id)}
            <label class="ic-check">
              <input
                type="checkbox"
                checked={isLibrarySelected(draft, library.id)}
                disabled={busy || (!library.supported && !isLibrarySelected(draft, library.id))}
                onchange={() => updateDraft(toggleLibrary(draft, library.id, libraryIds))}
              />
              {libraryLabel(library)}
            </label>
          {/each}
          {#if problems.includes('libraries')}
            <p class="ic-problem">{$t('frameleaf_icloud_problem_libraries')}</p>
          {/if}
        {:else}
          <p class="ic-hint">{$t('frameleaf_icloud_libraries_pending')}</p>
        {/if}
        {#if inventory && !inventory.complete}
          <p class="ic-hint">{$t('frameleaf_icloud_inventory_partial')}</p>
        {/if}

        <h3>{$t('frameleaf_icloud_source_albums')}</h3>
        <p class="ic-hint">{$t('frameleaf_icloud_albums_hint')}</p>
        <label>
          {$t('frameleaf_icloud_find_albums')}
          <input type="search" bind:value={albumSearch} disabled={!inventory} />
        </label>
        <div class="ic-albums">
          {#each visibleAlbums as album (album.id)}
            <label class="ic-check">
              <input
                type="checkbox"
                checked={draft.albums.includes(album.id)}
                disabled={busy ||
                  (!draft.albums.includes(album.id) &&
                    !inventory?.libraries.find(({ id }) => id === album.libraryId)?.supported)}
                onchange={() => updateDraft(toggleAlbum(draft, album.id))}
              />
              <span>
                {album.name}
                {#if album.parentId}
                  <small>{inventory?.albums.find(({ id }) => id === album.parentId)?.name ?? ''}</small>
                {/if}
              </span>
            </label>
          {/each}
        </div>
        {#if (inventory?.albums.length ?? 0) > 200}
          <p class="ic-hint">{$t('frameleaf_icloud_albums_limit')}</p>
        {/if}

        <h3>{$t('frameleaf_icloud_include')}</h3>
        <label class="ic-check">
          <input type="checkbox" bind:checked={draft.includeEdits} disabled={busy} />
          {$t('frameleaf_icloud_include_edits')}
        </label>
        <label class="ic-check">
          <input type="checkbox" bind:checked={draft.includeHidden} disabled={busy} />
          {$t('frameleaf_icloud_include_hidden')}
        </label>
        <p class="ic-hint">{$t('frameleaf_icloud_external_managed')}</p>
      </section>

      <section>
        <h3>{$t('frameleaf_icloud_sync_limits')}</h3>
        <label>
          {$t('frameleaf_icloud_connection_name')}
          <input bind:value={draft.label} maxlength={100} disabled={busy} aria-invalid={problems.includes('label')} />
        </label>
        <label>
          {$t('frameleaf_icloud_interval')}
          <input
            type="number"
            min="1"
            max="8760"
            step="1"
            value={draft.intervalHours}
            oninput={(event) => (draft.intervalHours = event.currentTarget.value)}
            disabled={busy}
            aria-invalid={problems.includes('interval')}
          />
        </label>
        <label>
          {$t('frameleaf_icloud_concurrency')}
          <input
            type="number"
            min="1"
            max="4"
            step="1"
            value={draft.concurrency}
            oninput={(event) => (draft.concurrency = event.currentTarget.value)}
            disabled={busy}
            aria-invalid={problems.includes('concurrency')}
          />
        </label>
        <label>
          {$t('frameleaf_icloud_staging')}
          <input
            type="number"
            min={1 / 1024}
            max={Number.MAX_SAFE_INTEGER / 1024 ** 3}
            step="any"
            value={draft.stagingGiB}
            oninput={(event) => (draft.stagingGiB = event.currentTarget.value)}
            disabled={busy}
            aria-invalid={problems.includes('staging')}
          />
        </label>
        <p class="ic-hint">{$t('frameleaf_icloud_limits_hint')}</p>
      </section>
    </div>

    <div class="ic-toolbar">
      <Button variant="primary" disabled={busy || problems.length > 0} onclick={save}>
        {$t('frameleaf_icloud_save')}
      </Button>
      <Button disabled={busy || !controls?.syncNow} onclick={() => void control(ICloudControlAction.Run)}>
        {$t('frameleaf_icloud_sync_now')}
      </Button>
      {#if controls?.resume}
        <Button disabled={busy} onclick={() => void control(ICloudControlAction.Resume)}>
          {$t('frameleaf_icloud_resume')}
        </Button>
      {:else}
        <Button disabled={busy || !controls?.pause} onclick={() => void control(ICloudControlAction.Pause)}>
          {$t('frameleaf_icloud_pause')}
        </Button>
      {/if}
      <Button disabled={busy || !controls?.cancel} onclick={() => void control(ICloudControlAction.Cancel)}>
        {$t('frameleaf_icloud_cancel')}
      </Button>
      <Button disabled={busy || !controls?.retry} onclick={() => void control(ICloudControlAction.Retry)}>
        {$t('frameleaf_icloud_retry')}
      </Button>
      <Button disabled={busy || !controls?.rescan} onclick={() => void control(ICloudControlAction.Rescan)}>
        {$t('frameleaf_icloud_rescan')}
      </Button>
    </div>

    <section class="ic-result-panel" aria-labelledby="ic-reconciliation">
      <h3 id="ic-reconciliation">{$t('frameleaf_icloud_reconciliation')}</h3>
      <p>
        {$t('frameleaf_icloud_summary', {
          values: {
            imported: summary.imported,
            matched: summary.matched,
            review: summary.review,
            skipped: summary.skipped,
          },
        })}
      </p>
      {#if summary.repaired > 0 || summary.failed > 0 || summary.sourceRemoved > 0}
        <p class="ic-hint">
          {$t('frameleaf_icloud_summary_more', {
            values: { repaired: summary.repaired, failed: summary.failed, removed: summary.sourceRemoved },
          })}
        </p>
      {/if}
      {#each inventory?.review ?? [] as item (item.resourceId)}
        <div class="ic-result-row">
          <span>{item.fileName ?? $t('frameleaf_icloud_untitled')}</span>
          <span>{$t(icloudReviewReasonKey(item))}</span>
          {#if icloudReviewTarget(item) === 'live-photos'}
            <Button onclick={() => void goto(Route.livePhotosUtility())}>{$t('frameleaf_icloud_review')}</Button>
          {:else if icloudReviewTarget(item) === 'asset' && item.assetId}
            <a href={Route.viewAsset({ id: item.assetId })}>{$t('frameleaf_icloud_open_photo')}</a>
          {/if}
        </div>
      {/each}
      {#each inventory?.recent ?? [] as receipt (receipt.resourceId)}
        <div class="ic-result-row">
          <span>{receipt.fileName}</span>
          <span>{$t(icloudOutcomeKey(receipt.outcome))}</span>
          <a href={Route.viewAsset({ id: receipt.assetId })}>{$t('frameleaf_icloud_open_photo')}</a>
        </div>
      {/each}
      {#if inventory && inventory.review.length === 0 && (inventory.recent?.length ?? 0) === 0}
        <p class="ic-hint">{$t('frameleaf_icloud_reconciliation_empty')}</p>
      {/if}
      {#if authManager.user.isAdmin && summary.repaired > 0}
        <p class="ic-links">
          <a href={Route.missingMediaUtility({ status: MediaHealthStatus.Resolved })}>
            {$t('frameleaf_icloud_resolved_missing')}
          </a>
          <a href={Route.corruptMediaUtility({ status: MediaHealthStatus.Resolved })}>
            {$t('frameleaf_icloud_resolved_corrupt')}
          </a>
        </p>
      {/if}
      <p class="ic-policy">{$t('frameleaf_icloud_policy')}</p>
    </section>
  {/if}
</div>

<Dialog title={$t('frameleaf_icloud_consent_title')} closeLabel={$t('cancel')} bind:open={consentOpen}>
  <div class="ic-dialog">
    {#if consent.hidden}
      <p>{$t('frameleaf_icloud_consent_hidden')}</p>
    {/if}
    <div class="ic-dialog-actions">
      <Button onclick={() => (consentOpen = false)}>{$t('cancel')}</Button>
      <Button variant="primary" disabled={busy} onclick={() => void persist()}>
        {$t('frameleaf_icloud_consent_confirm')}
      </Button>
    </div>
  </div>
</Dialog>

<Dialog title={$t('frameleaf_icloud_auth_title')} closeLabel={$t('cancel')} bind:open={authOpen}>
  {#if selected}
    <div class="ic-dialog">
      <p>{selected.label}{status ? ` · ${$t(icloudStatusKey(status))}` : ''}</p>
      {#if authError}
        <p role="alert" class="ic-message error">{authError}</p>
      {/if}
      {#if step === 'code'}
        <form
          autocomplete="off"
          onsubmit={(event) => {
            event.preventDefault();
            if (/^\d{6}$/.test(code)) {
              void authenticate(ICloudAuthAction.TwoFactor);
            }
          }}
        >
          <label>
            {$t('frameleaf_icloud_code')}
            <input
              bind:value={code}
              autocomplete="off"
              inputmode="numeric"
              pattern={'[0-9]{6}'}
              maxlength={6}
              required
              disabled={busy}
            />
          </label>
          <p class="ic-hint">{$t('frameleaf_icloud_code_hint')}</p>
          <div class="ic-dialog-actions">
            <Button variant="quiet" onclick={() => (signInAgain = true)}>{$t('frameleaf_icloud_start_over')}</Button>
            <Button onclick={() => (authOpen = false)}>{$t('cancel')}</Button>
            <Button type="submit" variant="primary" disabled={busy || !/^\d{6}$/.test(code)}>
              {$t('frameleaf_icloud_verify')}
            </Button>
          </div>
        </form>
      {:else if step === 'approval'}
        <p>{$t('frameleaf_icloud_approval_notice')}</p>
        <div class="ic-dialog-actions">
          <Button variant="quiet" onclick={() => (signInAgain = true)}>{$t('frameleaf_icloud_start_over')}</Button>
          <Button onclick={() => (authOpen = false)}>{$t('cancel')}</Button>
          <Button variant="primary" disabled={busy} onclick={() => void authenticate(ICloudAuthAction.DeviceApproval)}>
            {$t('frameleaf_icloud_check_approval')}
          </Button>
        </div>
      {:else if step === 'connected'}
        <p>{$t('frameleaf_icloud_disconnect_notice')}</p>
        <div class="ic-dialog-actions">
          <Button onclick={() => (authOpen = false)}>{$t('cancel')}</Button>
          <Button disabled={busy} onclick={() => void authenticate(ICloudAuthAction.Validate)}>
            {$t('frameleaf_icloud_check_session')}
          </Button>
          <Button disabled={busy} onclick={() => void disconnect()}>{$t('frameleaf_icloud_disconnect')}</Button>
        </div>
      {:else}
        <form
          autocomplete="off"
          onsubmit={(event) => {
            event.preventDefault();
            if (appleId.trim() && password) {
              void authenticate(ICloudAuthAction.Login);
            }
          }}
        >
          <p>{$t('frameleaf_icloud_sign_in_notice')}</p>
          <p class="ic-hint">{$t('frameleaf_icloud_adp_notice')}</p>
          <label>
            {$t('frameleaf_icloud_apple_id')}
            <input type="email" bind:value={appleId} autocomplete="off" required disabled={busy} />
          </label>
          <label>
            {$t('frameleaf_icloud_password')}
            <input type="password" bind:value={password} autocomplete="off" required disabled={busy} />
          </label>
          <div class="ic-dialog-actions">
            {#if selected.state === 'disconnected'}
              <Button disabled={busy} onclick={() => void remove()}>{$t('frameleaf_icloud_remove')}</Button>
            {:else if selected.authenticated}
              {#if selected.state === 'error'}
                <Button disabled={busy} onclick={() => void authenticate(ICloudAuthAction.Validate)}>
                  {$t('frameleaf_icloud_check_session')}
                </Button>
              {/if}
              <Button disabled={busy} onclick={() => void disconnect()}>{$t('frameleaf_icloud_disconnect')}</Button>
            {/if}
            <Button onclick={() => (authOpen = false)}>{$t('cancel')}</Button>
            <Button type="submit" variant="primary" disabled={busy || !appleId.trim() || !password}>
              {$t('frameleaf_icloud_connect_account')}
            </Button>
          </div>
        </form>
      {/if}
    </div>
  {/if}
</Dialog>

<style>
  .icloud {
    min-width: 0;
    color: var(--fl-text);
    font-size: var(--fl-font-small);
  }
  .ic-toolbar {
    display: flex;
    flex-wrap: wrap;
    align-items: end;
    gap: 12px;
    padding: 14px 0;
  }
  .ic-toolbar > label {
    flex: 1;
    min-width: 140px;
    max-width: 280px;
  }
  label {
    display: flex;
    flex-direction: column;
    gap: 8px;
    font-size: var(--fl-font-micro);
    color: var(--fl-muted);
  }
  input:not([type='checkbox']),
  select {
    width: 100%;
    padding: 10px;
    font-size: var(--fl-font-small);
    color: var(--fl-text);
    background: var(--fl-panel);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
  }
  input[aria-invalid='true'] {
    border-color: var(--fl-danger);
  }
  input[type='checkbox'] {
    flex-shrink: 0;
    width: 15px;
    height: 15px;
    margin: 0;
    accent-color: var(--fl-accent);
  }
  .ic-check {
    flex-direction: row;
    align-items: center;
    gap: 9px;
    margin: 8px 0;
    font-size: var(--fl-font-small);
    color: var(--fl-text);
  }
  .ic-check small {
    display: block;
    font-size: var(--fl-font-micro);
    color: var(--fl-muted);
  }
  .ic-message {
    display: flex;
    align-items: center;
    gap: 12px;
    margin: 0 0 12px;
    padding: 12px 14px;
    background: var(--fl-panel);
    border-left: 2px solid var(--fl-accent);
  }
  .ic-message > span {
    flex: 1;
  }
  .ic-message.error {
    border-color: var(--fl-warning);
  }
  .ic-empty {
    padding: 45px 20px;
    text-align: center;
    color: var(--fl-muted);
  }
  .ic-empty h3 {
    margin: 16px 0 8px;
    color: var(--fl-text);
  }
  .ic-empty p {
    margin-bottom: 16px;
  }
  .ic-connection {
    display: flex;
    align-items: center;
    gap: 18px;
    margin-bottom: 24px;
    padding: 20px 0;
    border-block: 1px solid var(--fl-border);
  }
  .ic-connection > div {
    flex: 1;
    min-width: 0;
  }
  .ic-connection h2 {
    font-size: 1.125rem;
    font-weight: 550;
  }
  .ic-connection p {
    margin: 6px 0 12px;
    color: var(--fl-muted);
  }
  .ic-connection > :global(svg) {
    color: var(--fl-muted);
  }
  .ic-badge {
    display: inline-flex;
    padding: 5px 8px;
    font-size: var(--fl-font-micro);
    color: var(--fl-accent);
    border: 1px solid var(--fl-border);
    border-radius: 3px;
  }
  .ic-badge.warning {
    color: var(--fl-warning-text);
  }
  .ic-badge.danger {
    color: var(--fl-danger-text);
  }
  .ic-badge.neutral {
    color: var(--fl-muted);
  }
  .ic-badge.info {
    color: var(--fl-blue-text);
  }
  .ic-badge.success {
    color: var(--fl-teal-text);
  }
  .ic-run {
    margin-bottom: 24px;
  }
  .ic-run-head {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 8px 16px;
    margin-bottom: 10px;
  }
  .ic-run-head > span {
    flex: 1;
    color: var(--fl-muted);
  }
  .ic-run-head a,
  .ic-result-row a,
  .ic-links a {
    color: var(--fl-accent);
    text-decoration: underline;
  }
  .ic-bar {
    height: 4px;
    overflow: hidden;
    background: var(--fl-raised);
    border-radius: var(--fl-radius-pill);
  }
  .ic-bar > span {
    display: block;
    height: 100%;
    background: var(--fl-accent);
    transition: width var(--fl-motion) var(--fl-ease);
  }
  .ic-run-note {
    margin-top: 8px;
    font-size: var(--fl-font-micro);
    color: var(--fl-muted);
  }
  .ic-work-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 20px;
  }
  .ic-work-grid > section {
    min-width: 0;
    padding: 24px;
    background: var(--fl-panel);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-card);
  }
  .ic-work-grid h3 {
    margin: 18px 0 8px;
    font-size: var(--fl-font-small);
    font-weight: 600;
  }
  .ic-work-grid h3:first-child {
    margin-top: 0;
  }
  .ic-work-grid > section > label {
    margin: 15px 0;
  }
  .ic-albums {
    max-height: 16rem;
    overflow-y: auto;
  }
  .ic-hint {
    margin: 8px 0;
    font-size: var(--fl-font-micro);
    line-height: 1.6;
    color: var(--fl-muted);
  }
  .ic-problem {
    margin: 8px 0;
    font-size: var(--fl-font-micro);
    color: var(--fl-danger-text);
  }
  .ic-result-panel {
    margin: 20px 0;
    padding: 22px;
    background: var(--fl-panel);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-card);
  }
  .ic-result-panel h3 {
    margin-bottom: 8px;
    font-weight: 600;
  }
  .ic-result-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 15px;
    padding: 14px 0;
    border-top: 1px solid var(--fl-border);
  }
  .ic-result-row > span:first-child {
    overflow-wrap: anywhere;
  }
  .ic-result-row > span:nth-child(2) {
    flex: 1;
    font-size: var(--fl-font-micro);
    color: var(--fl-muted);
  }
  .ic-links {
    display: flex;
    flex-wrap: wrap;
    gap: 16px;
    margin-top: 12px;
    font-size: var(--fl-font-micro);
  }
  .ic-policy {
    margin: 16px 0 0;
    padding: 13px 16px;
    font-size: var(--fl-font-micro);
    line-height: 1.7;
    color: var(--fl-muted);
    background: var(--fl-canvas);
    border-left: 2px solid var(--fl-muted);
  }
  .ic-dialog {
    display: flex;
    flex-direction: column;
    gap: 14px;
    min-width: min(28rem, 100%);
  }
  .ic-dialog form {
    display: flex;
    flex-direction: column;
    gap: 14px;
  }
  .ic-dialog-actions {
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: 8px;
  }
  @media (max-width: 700px) {
    .ic-work-grid {
      grid-template-columns: 1fr;
    }
    .ic-work-grid > section {
      padding: 18px;
    }
    .ic-toolbar > label {
      max-width: none;
    }
    .ic-connection {
      flex-wrap: wrap;
    }
  }
</style>
