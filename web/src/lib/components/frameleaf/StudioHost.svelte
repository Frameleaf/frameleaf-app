<script lang="ts">
  /**
   * The Svelte lifecycle wrapper for the vendored React editor (FL-88, `STU-201`).
   *
   * This component owns the Studio chrome from the prototype
   * (`design/frameleaf/template/src/Studio.jsx`, `studio.css`), which fills the page below the
   * Frameleaf top bar: the header with the way back to the project library, the project name, the
   * save indicator, who is editing, the project bundle export (FL-91) and the link to Activity
   * where an export or restoration job is followed. Everything below the header is
   * one element handed to the engine, which owns the workspace tabs, the media bin, the
   * program monitor, the inspector and the timeline.
   *
   * The split is deliberate. Authentication, navigation, permissions and job handoff stay
   * in Svelte, so they keep working identically whether or not the editor is present, and
   * the chrome never depends on React having mounted. The only controls rendered here are
   * ones this story actually wires; an Export or Review button with nothing behind it would
   * be a dead control, which the execution guide forbids.
   *
   * Lifecycle: resolve the engine once, mount into the stage element, `update` on every
   * context change, and `dispose` on unmount, on access loss, on a fatal error and when the
   * host leaves a state the engine may run in. `dispose` is called at most once per mount
   * and awaited before a remount, so two engines can never share the page.
   */
  import '$lib/frameleaf/tokens.css';
  import { onDestroy, onMount, untrack } from 'svelte';
  import { t } from 'svelte-i18n';
  import { Icon, Theme as AppTheme, themeManager } from '@immich/ui';
  import {
    mdiAlertCircleOutline,
    mdiArrowLeft,
    mdiCheckCircle,
    mdiCloudOffOutline,
    mdiCommentTextOutline,
    mdiExportVariant,
    mdiPackageVariantClosed,
    mdiLockOutline,
    mdiProgressClock,
  } from '@mdi/js';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import StudioHistoryPanel from '$lib/components/frameleaf/StudioHistoryPanel.svelte';
  import {
    loadStudioEngine as defaultLoadStudioEngine,
    type StudioEngineResolution,
  } from '$lib/frameleaf/studio/engine-loader';
  import type {
    StudioAssetRef,
    StudioAuthContext,
    StudioCapabilities,
    StudioEngineInstance,
    StudioHostContext,
    StudioRenderEvidence,
    StudioHostServices,
    StudioProjectHandle,
    StudioWorkspaceMode,
    StudioWorkspaceView,
  } from '$lib/frameleaf/studio/host-contract';
  import type { Rational } from '$lib/frameleaf/studio/rational-time';
  import {
    initialStudioHostState,
    reduceStudioHost,
    shouldDisposeEngine,
    studioCapabilityLabelKey,
    studioHostCanRetry,
    studioHostHeadingKey,
    type StudioHostEvent,
  } from '$lib/frameleaf/studio/host-state';
  import {
    STUDIO_DRAFT_PROJECT_ID,
    type StudioConflict,
    type StudioProjectAccess,
    type StudioProjectSession,
    type StudioProjectStatus,
  } from '$lib/frameleaf/studio/project-session';
  import { readStudioThemeTokens } from '$lib/frameleaf/studio/theme';
  import { idleStudioPreviewView, type StudioPreviewView } from '$lib/frameleaf/studio/preview';

  let {
    project,
    assets,
    handoffAssetIds = [],
    auth,
    capabilities,
    renderEvidence = [],
    services,
    onBack,
    onOpenActivity,
    onExportBundle,
    onExport,
    onRename,
    mode = $bindable<StudioWorkspaceMode>('basic'),
    workspace,
    unresolvedComments = 0,
    playhead = null,
    accessLost = false,
    dirty = false,
    queuedJobs = 0,
    droppedAssetCount = 0,
    /**
     * The remote preview the host owns (FL-96). It arrives here as data and leaves for the
     * engine as data; neither this component nor the engine ever fetches a frame itself.
     */
    preview = idleStudioPreviewView(),
    session = null,
    saveStatus = 'saved',
    conflict = null,
    access = null,
    onReload,
    onReacquire,
    onTakeOver,
    onSaveCopy,
    /** Injected in tests; production always resolves the registered engine. */
    loadEngine = defaultLoadStudioEngine,
  }: {
    project: StudioProjectHandle;
    assets: readonly StudioAssetRef[];
    handoffAssetIds?: readonly string[];
    auth: StudioAuthContext;
    capabilities: StudioCapabilities;
    /** FL-42: what qualified render workers verified, for the engine's export sheet. */
    renderEvidence?: readonly StudioRenderEvidence[];
    services: StudioHostServices;
    onBack: () => void;
    /**
     * Opens Activity (FL-104), where queued jobs such as bundle exports (FL-91) are followed.
     * When it is absent the host renders no link rather than a control that goes nowhere.
     */
    onOpenActivity?: () => void;
    /**
     * Opens the host's project bundle export dialog (FL-91). The route passes it only while the
     * person owns a saved project, the one case the server exports; otherwise there is no button.
     */
    onExportBundle?: () => void;
    /**
     * Opens the video export dialog (FL-106 server, `Studio.jsx` Export). Passed only for the owner of
     * a saved project this instance may write, the one case the server exports.
     */
    onExport?: () => void;
    /**
     * Renames the project (`Studio.jsx:2590-2607`). When absent the name is shown, not edited. Resolves
     * false when the server refused, and the field goes back to the stored name.
     */
    onRename?: (name: string) => Promise<boolean>;
    /** Basic or Advanced (`Studio.jsx:2626-2633`), handed to the engine as part of its context. */
    mode?: StudioWorkspaceMode;
    /** The account's stored workspace layout (FL-91), handed to the engine as part of its context. */
    workspace?: StudioWorkspaceView;
    /** Open review comments on the head revision, shown on the Review button (`Studio.jsx:2640-2643`). */
    unresolvedComments?: number;
    /** Where the engine's playhead is; new review comments are pinned there. */
    playhead?: Rational | null;
    /** The session lost the project: sign-out, session delete or relock. */
    accessLost?: boolean;
    /** The engine reports a draft it has not persisted. */
    dirty?: boolean;
    /** Jobs this session has handed to Activity. */
    queuedJobs?: number;
    /** Handoff items this session could not read, reported rather than silently missing. */
    droppedAssetCount?: number;
    preview?: StudioPreviewView;
    /** The project session (FL-89). When present the header offers history and review. */
    session?: StudioProjectSession | null;
    /** Persistence state from the session; drives the save indicator and the banner. */
    saveStatus?: StudioProjectStatus;
    conflict?: StudioConflict | null;
    access?: StudioProjectAccess | null;
    /** Discard the draft and load the head. Shown for `conflict`. */
    onReload?: () => void;
    /** Ask for the lease again. Shown for `lease-lost`. */
    onReacquire?: () => void;
    /** Take the lease from another of this account's instances. Explicit; shown for `lease-lost`. */
    onTakeOver?: () => void;
    /** Keep the draft by saving it as a new project. Shown for `conflict` and `lease-lost`. */
    onSaveCopy?: () => void;
    loadEngine?: () => Promise<StudioEngineResolution>;
  } = $props();

  // Not named `state`: that would make `$state` read as a store subscription.
  let host = $state(initialStudioHostState());
  let stage = $state<HTMLDivElement>();
  let root = $state<HTMLElement>();
  let online = $state(true);
  let historyOpen = $state(false);

  const hasSavedProject = $derived(session !== null && project.id !== STUDIO_DRAFT_PROJECT_ID);
  const showBanner = $derived(['conflict', 'lease-lost', 'offline', 'error'].includes(saveStatus));

  /**
   * Held outside `$state`: the engine instance is not reactive data and must never be
   * proxied, because React would then observe a different object than the one it created.
   */
  let engine: StudioEngineInstance | null = null;
  let disposing: Promise<void> | null = null;
  let mountToken = 0;

  const dispatch = (event: StudioHostEvent) => {
    host = reduceStudioHost(host, event);
  };

  const appTheme = $derived(themeManager.value === AppTheme.Dark ? 'dark' : 'light');

  const context = (): StudioHostContext => ({
    project,
    assets,
    handoffAssetIds,
    auth,
    theme: readStudioThemeTokens(appTheme, root ?? null),
    capabilities,
    renderEvidence,
    preview,
    online,
    mode,
    workspace,
  });

  const disposeEngine = async () => {
    const instance = engine;
    engine = null;
    if (!instance) {
      return;
    }
    // A second call while the first is still running must wait for it rather than start
    // another teardown of the same audio, workers and leases.
    disposing = (async () => {
      try {
        await instance.dispose();
      } catch {
        // Teardown failures must not keep the route from leaving; the engine's own
        // reporting covers the detail.
      }
    })();
    await disposing;
    disposing = null;
    dispatch({ type: 'engine-disposed' });
  };

  const mountEngine = async () => {
    const token = ++mountToken;
    if (disposing) {
      await disposing;
    }
    if (engine || token !== mountToken || !stage) {
      return;
    }

    const resolution = await loadEngine();
    if (token !== mountToken) {
      return;
    }

    if (resolution.status === 'absent') {
      dispatch({
        type: 'engine-absent',
        reason: resolution.reason,
        messageKey: resolution.messageKey,
        detail: resolution.detail,
      });
      return;
    }

    try {
      const instance = await resolution.module.mount(stage, context(), services);
      if (token !== mountToken) {
        // The route left while the engine was starting; nothing may be left running.
        await instance.dispose();
        return;
      }
      engine = instance;
      dispatch({ type: 'engine-mounted' });
    } catch (error) {
      dispatch({ type: 'fatal', detail: error instanceof Error ? error.message : String(error) });
    }
  };

  const retry = () => {
    dispatch({ type: 'retry' });
    void mountEngine();
  };

  onMount(() => {
    online = globalThis.navigator?.onLine;
    dispatch({ type: 'connectivity', online });

    const goOnline = () => {
      online = true;
      dispatch({ type: 'connectivity', online: true });
    };
    const goOffline = () => {
      online = false;
      dispatch({ type: 'connectivity', online: false });
    };
    addEventListener('online', goOnline);
    addEventListener('offline', goOffline);

    void mountEngine();

    return () => {
      removeEventListener('online', goOnline);
      removeEventListener('offline', goOffline);
    };
  });

  // Capability changes arrive from the host, not from the engine. `dispatch` reads the
  // state it replaces, so the write is untracked: otherwise the effect would depend on its
  // own result and re-run forever.
  $effect(() => {
    const next = capabilities;
    untrack(() => dispatch({ type: 'capabilities', capabilities: next }));
  });

  // A running engine gets the new context; it is never remounted for a data change. The
  // dependencies are read here, in the effect body, so a change to any of them reaches the
  // engine, while the phase check and the call itself stay untracked.
  $effect(() => {
    const next = context();
    untrack(() => {
      if (engine && host.phase === 'ready') {
        engine.update(next);
      }
    });
  });

  // Leaving a state the engine may run in tears it down rather than leaving it hidden. The
  // phase is read before the (non-reactive) engine check: short-circuiting on a null engine at
  // first run would leave the effect with no dependencies, so it would never run again.
  $effect(() => {
    const phase = host.phase;
    if (engine && shouldDisposeEngine(phase)) {
      void disposeEngine();
    }
  });

  // Access loss is terminal for this mount: the engine is disposed and the state cannot
  // leave `forbidden` without a fresh mount.
  $effect(() => {
    if (accessLost) {
      untrack(() => dispatch({ type: 'access-lost' }));
    }
  });

  $effect(() => {
    const next = dirty;
    untrack(() => dispatch({ type: 'dirty', dirty: next }));
  });

  onDestroy(() => {
    mountToken += 1;
    void disposeEngine();
  });

  const headingKey = $derived(studioHostHeadingKey(host));

  /* Project name (`Studio.jsx:2590-2607`): commit on blur or Enter, Escape puts it back. */
  let nameDraft = $state('');
  let editingName = false;
  $effect(() => {
    const stored = project.name;
    if (!editingName) {
      nameDraft = stored;
    }
  });
  const commitName = async () => {
    editingName = false;
    const next = nameDraft.trim();
    if (!onRename || !next || next === project.name) {
      nameDraft = project.name;
      return;
    }
    if (!(await onRename(next))) {
      nameDraft = project.name;
    }
  };
  const onNameKey = (event: KeyboardEvent & { currentTarget: HTMLInputElement }) => {
    if (event.key === 'Enter') {
      event.currentTarget.blur();
    } else if (event.key === 'Escape') {
      nameDraft = project.name;
      editingName = false;
      event.currentTarget.blur();
    }
  };
  const modes: {
    value: StudioWorkspaceMode;
    label: 'frameleaf_studio_mode_basic' | 'frameleaf_studio_mode_advanced';
  }[] = [
    { value: 'basic', label: 'frameleaf_studio_mode_basic' },
    { value: 'advanced', label: 'frameleaf_studio_mode_advanced' },
  ];

  /**
   * What, if anything, the preview area has to say.
   *
   * `null` means the picture on screen is the current one and needs no explanation. A frame
   * that is genuinely current but tone-mapped still gets a notice, because an 8-bit preview of
   * HDR material is not the colour authority and must never be mistaken for one.
   */
  const previewNoticePhase = $derived(
    ['rendering', 'stale', 'unavailable'].includes(preview.phase)
      ? preview.phase
      : preview.phase === 'ready' && preview.frame?.toneMapped
        ? ('tone-mapped' as const)
        : null,
  );

  const previewNoticeKey = $derived(
    previewNoticePhase === 'tone-mapped' ? 'frameleaf_studio_preview_tone_mapped' : preview.messageKey,
  );
</script>

<section class="frameleaf fl-studio" data-theme={appTheme} bind:this={root} aria-label={$t('frameleaf_studio_title')}>
  <header class="fl-studio-header">
    <Button variant="quiet" onclick={onBack}>
      <Icon icon={mdiArrowLeft} size="18" />
      {$t('frameleaf_studio_back_to_library')}
    </Button>

    <div class="fl-studio-project">
      {#if onRename && !accessLost}
        <h1 class="sr-only">{project.name}</h1>
        <input
          class="fl-studio-project-name"
          aria-label={$t('frameleaf_studio_project_name')}
          maxlength="120"
          bind:value={nameDraft}
          onfocus={() => (editingName = true)}
          onblur={() => void commitName()}
          onkeydown={onNameKey}
        />
      {:else}
        <h1>{project.name}</h1>
      {/if}
      <span class="fl-studio-save" role="status" aria-live="polite">
        {#if saveStatus === 'saving'}
          <Icon icon={mdiProgressClock} size="14" />
          {$t('frameleaf_studio_saving')}
        {:else if saveStatus === 'offline'}
          <Icon icon={mdiCloudOffOutline} size="14" />
          {$t('frameleaf_studio_offline_title')}
        {:else if saveStatus === 'conflict'}
          <Icon icon={mdiAlertCircleOutline} size="14" />
          {$t('frameleaf_studio_conflict_title')}
        {:else if saveStatus === 'lease-lost'}
          <Icon icon={mdiLockOutline} size="14" />
          {$t('frameleaf_studio_lease_lost_title')}
        {:else if host.dirty || saveStatus === 'dirty'}
          {$t('frameleaf_studio_unsaved')}
        {:else if !project.hasLease}
          <Icon icon={mdiLockOutline} size="14" />
          {$t('frameleaf_studio_read_only')}
        {:else}
          <Icon icon={mdiCheckCircle} size="14" />
          {$t('frameleaf_studio_all_saved')}
        {/if}
      </span>
    </div>

    <span class="fl-studio-grow"></span>

    {#if droppedAssetCount > 0}
      <span class="fl-studio-dropped" role="status">
        {$t('frameleaf_studio_handoff_dropped', { values: { count: droppedAssetCount } })}
      </span>
    {/if}

    {#if queuedJobs > 0 && onOpenActivity}
      <Button variant="quiet" onclick={onOpenActivity}>
        <Icon icon={mdiProgressClock} size="16" />
        {$t('frameleaf_studio_queued_open_activity', { values: { count: queuedJobs } })}
      </Button>
    {/if}

    {#if host.phase === 'ready'}
      <!-- Basic and Advanced change the engine's layout, so the choice is offered only while it runs. -->
      <div class="fl-studio-mode" role="radiogroup" aria-label={$t('frameleaf_studio_mode_label')}>
        {#each modes as item (item.value)}
          <button
            type="button"
            role="radio"
            aria-checked={mode === item.value}
            class:is-on={mode === item.value}
            onclick={() => (mode = item.value)}
          >
            {$t(item.label)}
          </button>
        {/each}
      </div>
    {/if}

    <span class="fl-studio-editor-as">
      {#if auth.avatarUrl}
        <img class="fl-studio-avatar" src={auth.avatarUrl} alt="" />
      {:else}
        <span class="fl-studio-avatar" aria-hidden="true">{auth.name.slice(0, 1).toUpperCase()}</span>
      {/if}
      {$t('frameleaf_studio_editing_as', { values: { name: auth.name } })}
    </span>

    {#if onExportBundle && !accessLost}
      <Button variant="quiet" onclick={onExportBundle}>
        <Icon icon={mdiPackageVariantClosed} size="16" />
        {$t('frameleaf_studio_bundle_export_action')}
      </Button>
    {/if}

    {#if hasSavedProject}
      <Button variant="quiet" pressed={historyOpen} onclick={() => (historyOpen = !historyOpen)}>
        <Icon icon={mdiCommentTextOutline} size="16" />
        {$t('frameleaf_studio_review')}
        {#if unresolvedComments > 0}
          <span class="fl-studio-count">{unresolvedComments}</span>
          <span class="sr-only"
            >{$t('frameleaf_studio_review_open_count', { values: { count: unresolvedComments } })}</span
          >
        {/if}
      </Button>
    {/if}

    {#if onExport && !accessLost}
      <Button variant="primary" onclick={onExport}>
        <Icon icon={mdiExportVariant} size="16" />
        {$t('frameleaf_studio_export_action')}
      </Button>
    {/if}
  </header>

  {#if showBanner}
    <!--
      Persistence trouble is the person's to resolve, so it is stated in plain terms with the
      choices spelled out. Nothing here discards the draft on its own: reload and save-as-copy
      are explicit, and taking a lease away from another window is never implied by a retry.
    -->
    <div class="fl-studio-banner" role="alert" data-testid="studio-save-banner" data-status={saveStatus}>
      <Icon icon={saveStatus === 'offline' ? mdiCloudOffOutline : mdiAlertCircleOutline} size="18" />
      <p>
        {#if saveStatus === 'conflict'}
          {$t('frameleaf_studio_conflict_body')}
        {:else if saveStatus === 'lease-lost'}
          {$t('frameleaf_studio_lease_lost_body')}
        {:else if saveStatus === 'offline'}
          {$t('frameleaf_studio_offline_saving')}
        {:else}
          {$t('frameleaf_studio_save_failed')}
        {/if}
      </p>
      <div class="fl-studio-banner-actions">
        {#if saveStatus === 'conflict' && onReload}
          <Button variant="quiet" onclick={onReload}>{$t('frameleaf_studio_conflict_reload')}</Button>
        {/if}
        {#if saveStatus === 'lease-lost' && onReacquire}
          <Button variant="quiet" onclick={onReacquire}>{$t('frameleaf_studio_lease_lost_reacquire')}</Button>
        {/if}
        {#if saveStatus === 'lease-lost' && conflict?.lease?.heldByAnother && onTakeOver}
          <Button variant="quiet" onclick={onTakeOver}>{$t('frameleaf_studio_lease_lost_take_over')}</Button>
        {/if}
        {#if (saveStatus === 'conflict' || saveStatus === 'lease-lost') && onSaveCopy}
          <Button variant="primary" onclick={onSaveCopy}>{$t('frameleaf_studio_conflict_save_copy')}</Button>
        {/if}
      </div>
    </div>
  {/if}

  <div class="fl-studio-body">
    <!--
      The engine's only surface. It is always in the DOM so the mount target exists before
      the engine resolves, and it is hidden from assistive technology until the engine is
      actually running.
    -->
    <div
      class="fl-studio-stage"
      bind:this={stage}
      data-testid="studio-stage"
      aria-hidden={host.phase === 'ready' ? undefined : 'true'}
    ></div>

    <!--
      The preview area (FL-96). It says what is true and nothing more: while a frame is being
      rendered it says so; once the project revision moves past the frame on screen it says the
      picture is out of date instead of leaving it looking current; and when the frame cannot be
      produced it says that, with the stable code kept for diagnostics rather than shown as the
      message. There is deliberately no state here that presents an old frame as the live one.
    -->
    {#if host.phase === 'ready' && previewNoticePhase}
      <div
        class="fl-studio-preview"
        data-testid="studio-preview-state"
        data-preview-phase={previewNoticePhase}
        role="status"
        aria-live="polite"
      >
        <Icon icon={previewNoticePhase === 'rendering' ? mdiProgressClock : mdiAlertCircleOutline} size="16" />
        <span>{previewNoticeKey ? $t(previewNoticeKey) : ''}</span>
        {#if previewNoticePhase === 'stale' && preview.staleFrame}
          <span class="fl-studio-preview-note">{$t('frameleaf_studio_preview_showing_previous')}</span>
        {/if}
      </div>
    {/if}

    {#if historyOpen && session && hasSavedProject}
      <div class="fl-studio-drawer">
        <StudioHistoryPanel
          {session}
          revision={project.revision}
          userId={auth.userId}
          {access}
          canRestore={project.hasLease && saveStatus !== 'conflict' && saveStatus !== 'lease-lost'}
          {playhead}
          onClose={() => (historyOpen = false)}
        />
      </div>
    {/if}

    {#if headingKey}
      <div class="fl-studio-state" data-testid="studio-state" data-phase={host.phase}>
        {#if host.phase !== 'loading'}
          <Icon icon={mdiAlertCircleOutline} size="28" />
        {/if}
        <h2>{$t(headingKey)}</h2>

        {#if host.messageKey}
          <p>{$t(host.messageKey)}</p>
        {/if}

        {#if host.phase === 'unavailable' && host.missingCapabilities.length > 0}
          <!-- Name what is missing; "Studio is unavailable" on its own is not actionable. -->
          <ul aria-label={$t('frameleaf_studio_missing_capabilities')}>
            {#each host.missingCapabilities as capability (capability)}
              <li>{$t(studioCapabilityLabelKey(capability))}</li>
            {/each}
          </ul>
        {/if}

        <div class="fl-studio-state-actions">
          {#if studioHostCanRetry(host)}
            <Button onclick={retry}>{$t('frameleaf_studio_retry')}</Button>
          {/if}
          <Button variant={studioHostCanRetry(host) ? 'quiet' : 'primary'} onclick={onBack}>
            {$t('frameleaf_studio_back_to_library')}
          </Button>
        </div>
      </div>
    {/if}
  </div>
</section>

<style>
  /*
   * The full-screen Studio frame from `design/frameleaf/template/src/studio.css`, expressed
   * in Frameleaf tokens. Scoped to this component, so nothing here can reach the engine's
   * subtree and nothing the engine loads can restyle the shell.
   */
  .fl-studio {
    /*
     * Below the Frameleaf top bar, as the prototype's Studio screen sits in the workspace under
     * `.topbar` (FL-30). Its own stacking context at level 0 keeps the top bar's menus above it.
     */
    position: relative;
    z-index: 0;
    height: calc(100dvh - var(--fl-topbar-height));
    display: flex;
    flex-direction: column;
    background: var(--fl-canvas);
    color: var(--fl-text);
  }
  .fl-studio-header {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.5rem 0.75rem;
    border-bottom: 1px solid var(--fl-border);
    background: var(--fl-panel);
  }
  .fl-studio-project {
    display: flex;
    align-items: baseline;
    gap: 0.75rem;
    min-width: 0;
  }
  .fl-studio-project h1 {
    margin: 0;
    font-size: 0.9375rem;
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  /* studio.css `.fls-project-name`: the name reads as a title until it is edited. */
  .fl-studio-project-name {
    min-width: 8rem;
    max-width: 22rem;
    padding: 0.2rem 0.4rem;
    border: 1px solid transparent;
    border-radius: var(--fl-radius-control);
    background: transparent;
    color: var(--fl-text);
    font: inherit;
    font-size: 0.9375rem;
    font-weight: 600;
    text-overflow: ellipsis;
  }
  .fl-studio-project-name:hover,
  .fl-studio-project-name:focus {
    border-color: var(--fl-border);
    background: var(--fl-canvas);
  }
  /* studio.css `.fls-mode`: a two-segment control. */
  .fl-studio-mode {
    display: inline-flex;
    padding: 2px;
    border: 1px solid var(--fl-border);
    border-radius: 999px;
    background: var(--fl-canvas);
  }
  .fl-studio-mode button {
    min-height: 26px;
    padding: 0 0.75rem;
    border: 0;
    border-radius: 999px;
    background: transparent;
    color: var(--fl-muted);
    font: inherit;
    font-size: 0.8125rem;
    cursor: pointer;
  }
  .fl-studio-mode button.is-on {
    background: var(--fl-panel);
    color: var(--fl-text);
    box-shadow: var(--fl-shadow-1);
  }
  /* A person's round avatar (people photos are the squircles), as `PersonAvatar` draws it. */
  .fl-studio-avatar {
    display: inline-grid;
    place-items: center;
    width: 26px;
    height: 26px;
    border-radius: 50%;
    object-fit: cover;
    background: var(--fl-raised);
    color: var(--fl-text);
    font-size: 0.75rem;
    font-weight: 600;
  }
  .fl-studio-count {
    min-width: 1.25rem;
    padding: 0 0.35rem;
    border-radius: 999px;
    background: var(--fl-accent);
    color: var(--fl-accent-text);
    font-size: 0.75rem;
    font-variant-numeric: tabular-nums;
    text-align: center;
  }
  .fl-studio-save,
  .fl-studio-dropped,
  .fl-studio-editor-as {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    font-size: 0.8125rem;
    color: var(--fl-muted);
    white-space: nowrap;
  }
  .fl-studio-grow {
    flex: 1 1 auto;
  }
  .fl-studio-banner {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    flex-wrap: wrap;
    padding: 0.5rem 0.75rem;
    border-bottom: 1px solid var(--fl-border);
    background: var(--fl-warning);
    color: var(--fl-warning-text);
  }
  .fl-studio-banner p {
    margin: 0;
    flex: 1 1 16rem;
    font-size: 0.875rem;
  }
  .fl-studio-banner-actions {
    display: flex;
    gap: 0.5rem;
    flex-wrap: wrap;
  }
  .fl-studio-body {
    position: relative;
    flex: 1 1 auto;
    min-height: 0;
  }
  .fl-studio-drawer {
    position: absolute;
    top: 0;
    right: 0;
    bottom: 0;
    z-index: 2;
    display: flex;
    box-shadow: var(--fl-shadow-1);
  }
  .fl-studio-stage {
    position: absolute;
    inset: 0;
    /* The engine lays itself out inside this box and never escapes it. */
    overflow: hidden;
  }
  .fl-studio-preview {
    position: absolute;
    top: 0.5rem;
    left: 50%;
    transform: translateX(-50%);
    display: flex;
    align-items: center;
    gap: 0.375rem;
    max-width: calc(100% - 1rem);
    padding: 0.25rem 0.625rem;
    font-size: 0.8125rem;
    color: var(--fl-text);
    background: var(--fl-panel);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
  }
  .fl-studio-preview[data-preview-phase='stale'],
  .fl-studio-preview[data-preview-phase='unavailable'] {
    color: var(--fl-warning);
  }
  .fl-studio-preview-note {
    color: var(--fl-muted);
  }
  .fl-studio-state {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 0.75rem;
    padding: 2rem 1rem;
    text-align: center;
    background: var(--fl-canvas);
  }
  .fl-studio-state h2 {
    margin: 0;
    font-size: 1.0625rem;
    font-weight: 600;
  }
  .fl-studio-state p {
    margin: 0;
    max-width: 34rem;
    color: var(--fl-muted);
  }
  .fl-studio-state ul {
    margin: 0;
    padding: 0;
    list-style: none;
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: 0.375rem;
  }
  .fl-studio-state li {
    padding: 0.1875rem 0.5rem;
    font-size: 0.8125rem;
    color: var(--fl-text);
    background: var(--fl-raised);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
  }
  .fl-studio-state-actions {
    display: flex;
    gap: 0.5rem;
    margin-top: 0.25rem;
  }
  @media (max-width: 48rem) {
    .fl-studio-editor-as {
      display: none;
    }
  }
  /* Tailwind's `md`, where the top bar becomes its two-row phone grid. */
  @media (max-width: 47.99rem) {
    .fl-studio {
      height: calc(100dvh - var(--fl-topbar-height-phone));
    }
  }
</style>
