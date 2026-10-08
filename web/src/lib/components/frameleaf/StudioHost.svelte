<script lang="ts" module>
  /**
   * A drawer over the editor behaves like one: focus moves into it when it opens, Escape closes it,
   * and focus goes back to where it was (the header button, or the editor) when it leaves.
   */
  const studioDrawer = (node: HTMLElement, close: () => void) => {
    const previous = document.activeElement;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) {
        return;
      }
      event.stopPropagation();
      close();
    };
    node.addEventListener('keydown', onKey);
    node.querySelector<HTMLElement>('[data-drawer-focus]')?.focus();
    return {
      destroy() {
        node.removeEventListener('keydown', onKey);
        const active = document.activeElement;
        const lost = !active || active === document.body || node.contains(active);
        if (lost && previous instanceof HTMLElement && previous.isConnected) {
          previous.focus();
        }
      },
    };
  };
</script>

<script lang="ts">
  /**
   * The Svelte lifecycle wrapper for the vendored React editor (FL-88, `STU-201`).
   *
   * This component owns the Studio chrome from the prototype
   * (`design/frameleaf/template/src/Studio.jsx`, `studio.css`), which fills the page below the
   * Frameleaf top bar: the header with the way back to the project library, the project name, the
   * save indicator, who is editing, the export in progress, and the link to Activity where a
   * restoration job is followed. Rare actions (saving the project as a file, FL-91) sit in More. Everything below the header is
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
  import { Icon, Theme as AppTheme, themeManager } from '@frameleaf/ui';
  import {
    mdiAlertCircleOutline,
    mdiArrowLeft,
    mdiAutoFix,
    mdiCheckCircle,
    mdiClose,
    mdiCloudOffOutline,
    mdiCommentTextOutline,
    mdiDotsHorizontal,
    mdiExportVariant,
    mdiMonitorEye,
    mdiPackageVariantClosed,
    mdiLockOutline,
    mdiProgressClock,
    mdiTune,
  } from '@mdi/js';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import IconButton from '$lib/components/frameleaf/IconButton.svelte';
  import Menu from '$lib/components/frameleaf/Menu.svelte';
  import MenuItem from '$lib/components/frameleaf/MenuItem.svelte';
  import Skeleton from '$lib/components/frameleaf/Skeleton.svelte';
  import Spinner from '$lib/components/frameleaf/Spinner.svelte';
  import { pop, reveal } from '$lib/frameleaf/motion';
  import { ICON_SIZE } from '$lib/frameleaf/tokens';
  import {
    studioDockClearance,
    studioExportJobPhase,
    studioProjectSharedKey,
    studioExportPercent,
    type StudioExportJob,
    type StudioOpening,
  } from '$lib/frameleaf/studio/chrome';
  import { bannerIn, bannerOut, drawerIn, drawerOut, overlayOut, revealOut } from '$lib/frameleaf/studio/chrome-motion';
  import StudioHistoryPanel from '$lib/components/frameleaf/StudioHistoryPanel.svelte';
  import StudioRestorePanel, { type StudioRestoreFocus } from '$lib/components/frameleaf/StudioRestorePanel.svelte';
  import type { AssetRestorationResponseDto } from '@frameleaf/sdk';
  import { decodeRefusalMessageKey } from '$lib/frameleaf/decode-refusal';
  import {
    loadStudioEngine as defaultLoadStudioEngine,
    type StudioEngineResolution,
  } from '$lib/frameleaf/studio/engine-loader';
  import {
    emptyStudioCapabilities,
    type StudioAssetRef,
    type StudioAuthContext,
    type StudioCapabilities,
    type StudioEngineInstance,
    type StudioHostContext,
    type StudioProjectImportRef,
    type StudioRenderEvidence,
    type StudioHostServices,
    type StudioProjectHandle,
    type StudioWorkspaceMode,
    type StudioWorkspaceView,
  } from '$lib/frameleaf/studio/host-contract';
  import type { Rational } from '$lib/frameleaf/studio/rational-time';
  import {
    initialStudioHostState,
    reduceStudioHost,
    shouldDisposeEngine,
    studioCapabilityLabelKey,
    studioHostAbandonsMount,
    studioHostCanMount,
    studioHostNeedsMount,
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
  import { StudioRestoredVersionUnavailable, type StudioUnsupportedSourceDto } from '@frameleaf/sdk';
  import type { Translations } from 'svelte-i18n';

  const unavailableRestorationKeys: Record<StudioRestoredVersionUnavailable, Translations> = {
    [StudioRestoredVersionUnavailable.Discarded]: 'frameleaf_studio_restored_unavailable_discarded',
    [StudioRestoredVersionUnavailable.Expired]: 'frameleaf_studio_restored_unavailable_expired',
    [StudioRestoredVersionUnavailable.NotReady]: 'frameleaf_studio_restored_unavailable_not_ready',
    [StudioRestoredVersionUnavailable.Locked]: 'frameleaf_studio_restored_unavailable_locked',
    [StudioRestoredVersionUnavailable.Trashed]: 'frameleaf_studio_restored_unavailable_trashed',
    [StudioRestoredVersionUnavailable.Offline]: 'frameleaf_studio_restored_unavailable_offline',
    [StudioRestoredVersionUnavailable.HiddenContent]: 'frameleaf_studio_restored_unavailable_hidden',
  };
  import { offStudioStreamView, type StudioStreamView } from '$lib/frameleaf/studio/preview-stream';
  import StudioServerPreview from '$lib/components/frameleaf/StudioServerPreview.svelte';

  let {
    project,
    assets,
    projectImports = [],
    handoffAssetIds = [],
    auth,
    capabilities,
    renderEvidence = [],
    services,
    onBack,
    onRetry,
    onBackToEditor,
    quickEditWaiting = false,
    handoffPlayhead = null,
    draftHeld = false,
    onOpenActivity,
    onExportBundle,
    onExport,
    onRename,
    mode = 'basic',
    workspace,
    opening = null,
    exportJob = null,
    onOpenExport,
    unresolvedComments = 0,
    playhead = null,
    accessLost = false,
    dirty = false,
    queuedJobs = 0,
    droppedAssetCount = 0,
    unavailableRestorations = [],
    unsupportedSources = [],
    onUseRestoration,
    restoreRequest = null,
    /**
     * The remote preview the host owns (FL-96). It arrives here as data and leaves for the
     * engine as data; neither this component nor the engine ever fetches a frame itself.
     */
    preview = idleStudioPreviewView(),
    /** Streamed playback (FL-96), shown with the exact frames in the host's server preview panel. */
    stream = offStudioStreamView(),
    serverPreviewOpen = $bindable(false),
    localPreviewWithoutWebGpu = false,
    onStreamVideoSize,
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
    /** Files kept with the project (FL-103 / FL-105), offered to the editor under their media ids. */
    projectImports?: readonly StudioProjectImportRef[];
    handoffAssetIds?: readonly string[];
    auth: StudioAuthContext;
    /** Null until the route's capability probe has answered; nothing is judged missing before. */
    capabilities: StudioCapabilities | null;
    /** FL-42: what qualified render workers verified, for the engine's export sheet. */
    renderEvidence?: readonly StudioRenderEvidence[];
    services: StudioHostServices;
    onBack: () => void;
    /** Refresh authenticated worker admission before retrying the existing engine lifecycle. */
    onRetry?: () => Promise<boolean>;
    /**
     * Back to the quick editor that opened Studio (FL-113), with the draft the person left there.
     * Absent when Studio was not opened from a quick editor.
     */
    onBackToEditor?: () => void;
    /**
     * The quick editor that opened Studio still holds edits that were not saved as a version
     * (`editor-continuity.ts`). Studio shows the saved picture, so it says once that they are waiting.
     */
    quickEditWaiting?: boolean;
    /** Where the quick editor's playhead was (FL-113), so the engine starts at the same instant. */
    handoffPlayhead?: { num: number; den: number } | null;
    /** The session holds undecided edits (a conflict or a lost lease): the engine keeps what it shows. */
    draftHeld?: boolean;
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
    /**
     * Basic or Advanced (`Studio.jsx:2626-2633`), handed to the engine as part of its context. The
     * header offers no switch for it: the editor does not read the value yet, and a control with
     * nothing behind it is not shown.
     */
    mode?: StudioWorkspaceMode;
    /** The card this project was opened from in the library, shown while the editor starts. */
    opening?: (Pick<StudioOpening, 'name' | 'posterUrl'> & Partial<Pick<StudioOpening, 'projectId'>>) | null;
    /** The newest video export this session started, followed in the header until it is done. */
    exportJob?: StudioExportJob | null;
    /** Opens the finished export in the library. Without it the pill offers Activity only. */
    onOpenExport?: () => void;
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
    /**
     * Restored versions the project places that can no longer be used (FL-115): discarded, expired, or
     * their original was trashed or locked. Said plainly; the original is never swapped in silently.
     */
    unavailableRestorations?: readonly { name: string; reason: StudioRestoredVersionUnavailable }[];
    /**
     * The Restore tab (FL-115, FL-162): restoration and Smooth motion of one of the project's photos or
     * videos, preview first; Use in Studio hands a finished version back to the route for the bin.
     * Without it there is no Restore button.
     */
    onUseRestoration?: (restoration: AssetRestorationResponseDto) => void;
    /** A command or clip asked for the Restore tab on this source; each new request opens it. */
    restoreRequest?: { assetId: string | null; focus: StudioRestoreFocus; nonce: number } | null;
    /**
     * FL-101: placed videos the server refused when the project's sources were admitted, because it
     * cannot decode them. They stay on the timeline as the person placed them, but will not render.
     */
    unsupportedSources?: readonly StudioUnsupportedSourceDto[];
    preview?: StudioPreviewView;
    stream?: StudioStreamView;
    /** The server preview panel is open; the engine then asks for exact frames on its behalf. */
    serverPreviewOpen?: boolean;
    /**
     * The editor reported no WebGPU (FL-96, FL-112): its own picture leaves out GPU effects, and the
     * notice saying so stays up rather than letting that picture pass for the full one.
     */
    localPreviewWithoutWebGpu?: boolean;
    /** The streamed picture's size, so the route can hold the session to its bounds. */
    onStreamVideoSize?: (width: number, height: number) => void;
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
  let restoreOpen = $state(false);
  const closeDrawers = () => {
    historyOpen = false;
    restoreOpen = false;
  };
  const toggleHistory = () => {
    historyOpen = !historyOpen;
    restoreOpen = false;
  };
  const toggleRestore = () => {
    restoreOpen = !restoreOpen;
    historyOpen = false;
  };
  /** The note about edits waiting in the quick editor is said once; dismissing it lasts for this visit. */
  let quickEditNoteDismissed = $state(false);
  const showQuickEditNote = $derived(
    quickEditWaiting && onBackToEditor !== undefined && !accessLost && !quickEditNoteDismissed,
  );
  // One drawer at a time: opening one closes the other.
  $effect(() => {
    if (restoreRequest) {
      untrack(() => {
        restoreOpen = true;
        historyOpen = false;
      });
    }
  });

  const hasSavedProject = $derived(session !== null && project.id !== STUDIO_DRAFT_PROJECT_ID);
  /** One sentence per distinct reason, so three profile 7 clips are explained once. */
  const unsupportedReasons = $derived([
    ...new Set(unsupportedSources.map((source) => decodeRefusalMessageKey(source.refusal))),
  ]);

  /**
   * The editor is on screen and usable. Offline keeps a running engine (`host-state.ts`), so a
   * connection that drops mid-edit leaves the person in their project with a banner, not locked out.
   */
  const editorUp = $derived(host.mounted && (host.phase === 'ready' || host.phase === 'offline'));
  /** Studio could not open: the header then shows no project controls that the body contradicts. */
  const blocked = $derived(!editorUp && host.phase !== 'loading');
  const showState = $derived(!editorUp);
  const offline = $derived(saveStatus === 'offline' || (!online && editorUp));
  /** The save states the person has to act on; each has its own banner. */
  type SaveTrouble = Extract<StudioProjectStatus, 'conflict' | 'lease-lost' | 'error'>;
  const SAVE_TROUBLE: readonly StudioProjectStatus[] = ['conflict', 'lease-lost', 'error'];
  const bannerStatus = $derived(
    SAVE_TROUBLE.includes(saveStatus) ? (saveStatus as SaveTrouble) : offline ? ('offline' as const) : null,
  );

  /** What the save indicator says; one word of state so a change can crossfade. */
  const pill = $derived(
    saveStatus === 'saving'
      ? 'saving'
      : offline
        ? 'offline'
        : saveStatus === 'conflict' || saveStatus === 'lease-lost'
          ? saveStatus
          : host.dirty || saveStatus === 'dirty'
            ? 'unsaved'
            : project.hasLease
              ? 'saved'
              : 'read-only',
  );
  // Not $state: only the step from Saving to saved is remembered, for the tick's one settle.
  let lastPill = '';
  let settled = $state(false);
  $effect.pre(() => {
    const next = pill;
    settled = lastPill === 'saving' && next === 'saved';
    lastPill = next;
  });

  const exportPhase = $derived(exportJob ? studioExportJobPhase(exportJob) : null);
  const exportPercent = $derived(exportJob ? studioExportPercent(exportJob) : 0);
  const exportPhaseKey = $derived(
    exportPhase === 'ready'
      ? ('frameleaf_studio_export_job_ready' as const)
      : exportPhase === 'failed'
        ? ('frameleaf_studio_export_job_failed' as const)
        : exportPhase === 'queued'
          ? ('frameleaf_studio_export_job_queued' as const)
          : ('frameleaf_studio_export_job_working' as const),
  );

  /** How far an open drawer reaches in, so the server preview moves clear of it. */
  const drawerWidth = $derived(historyOpen ? '22rem' : restoreOpen ? '24rem' : '0rem');

  /**
   * The upload and download dock is fixed to the window's lower inline-end corner, above every page.
   * Studio's own chrome lives there too (a drawer, the comment field at its foot, the server preview),
   * so the host publishes how much room it needs and the dock keeps out of it: `--fl-dock-right` is
   * the width of an open drawer, `--fl-dock-clearance` the height the dock has to rise above.
   */
  $effect(() => {
    const host = root;
    const previewOpen = serverPreviewOpen && editorUp;
    const drawerOpen = historyOpen || restoreOpen;
    if (!host) {
      return;
    }
    const style = document.documentElement.style;
    const measure = () => {
      const drawer = drawerOpen ? host.querySelector<HTMLElement>('.fl-studio-drawer') : null;
      const panel = previewOpen ? host.querySelector<HTMLElement>('[data-studio-dock-clear]') : null;
      const foot = drawer?.querySelector<HTMLElement>('[data-studio-drawer-foot]') ?? null;
      const body = panel?.offsetParent instanceof HTMLElement ? panel.offsetParent : null;
      const { right, clearance } = studioDockClearance({
        viewportHeight: innerHeight,
        // The dock spans the window at this width (PanelDock), so a drawer cannot be stepped around.
        stretched: typeof matchMedia === 'function' && matchMedia('(max-width: 700px)').matches,
        hostBottom: host.getBoundingClientRect().bottom,
        drawerWidth: drawer?.offsetWidth ?? 0,
        // Layout sizes, not the painted box: the panel is scaled while it pops in.
        panelReach: panel && body ? body.offsetHeight - panel.offsetTop : 0,
        footTop: foot ? foot.getBoundingClientRect().top : null,
      });
      style.setProperty('--fl-dock-right', `${right}px`);
      style.setProperty('--fl-dock-clearance', `${clearance}px`);
    };
    measure();
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null;
    observer?.observe(host);
    const panel = previewOpen ? host.querySelector('[data-studio-dock-clear]') : null;
    if (panel) {
      observer?.observe(panel);
    }
    // The foot of a drawer comes and goes with the view inside it (Comments has one, Versions none).
    const drawer = drawerOpen ? host.querySelector('.fl-studio-drawer') : null;
    const mutations = drawer && typeof MutationObserver === 'function' ? new MutationObserver(measure) : null;
    if (drawer) {
      mutations?.observe(drawer, { childList: true, subtree: true });
    }
    return () => {
      observer?.disconnect();
      mutations?.disconnect();
      style.removeProperty('--fl-dock-right');
      style.removeProperty('--fl-dock-clearance');
    };
  });

  /**
   * Held outside `$state`: the engine instance is not reactive data and must never be
   * proxied, because React would then observe a different object than the one it created.
   */
  let engine: StudioEngineInstance | null = null;
  let disposing: Promise<void> | null = null;
  let mountToken = 0;
  let destroyed = false;
  /** The mount in progress, so a second request for the same mount joins it instead of racing it. */
  let mounting: { token: number; done: Promise<void> } | null = null;

  /**
   * Every state change goes through here, and the engine's lifecycle follows the transition,
   * not a later effect: entering a phase the engine must not run in abandons a mount that is
   * still starting and tears down a running one at once, and becoming mountable again (the
   * required workers came online, or Try again) starts exactly one mount. Doing both in the
   * same synchronous step is what keeps capabilities that flap (met, missing, met) from leaving
   * the old engine running or starting two.
   */
  const dispatch = (event: StudioHostEvent) => {
    const previous = host;
    const next = reduceStudioHost(previous, event);
    host = next;
    if (studioHostAbandonsMount(previous, next)) {
      mountToken += 1;
    }
    if (engine && shouldDisposeEngine(next.phase)) {
      void disposeEngine();
    }
    if (studioHostNeedsMount(previous, next)) {
      void mountEngine();
    }
  };

  const appTheme = $derived(themeManager.value === AppTheme.Dark ? 'dark' : 'light');

  const context = (): StudioHostContext => ({
    project,
    assets,
    projectImports,
    handoffAssetIds,
    auth,
    theme: readStudioThemeTokens(appTheme, root ?? null),
    capabilities: capabilities ?? emptyStudioCapabilities(),
    renderEvidence,
    preview,
    // FL-96: the host shows the server preview itself; the engine's own panel stays out of sight.
    serverPreviewOpen,
    online,
    mode,
    workspace,
    handoffPlayhead,
    draftHeld,
    // The adapter's own chrome (its server preview panel) speaks the host's language (FL-96).
    strings: {
      previewTitle: $t('frameleaf_studio_server_preview'),
      previewShow: $t('frameleaf_studio_server_preview_show'),
      previewHide: $t('frameleaf_studio_server_preview_hide'),
      previewRendering: $t('frameleaf_studio_preview_rendering'),
      previewStale: $t('frameleaf_studio_preview_stale'),
      previewUnavailable: $t('frameleaf_studio_preview_unavailable'),
      previewToneMapped: $t('frameleaf_studio_preview_tone_mapped'),
      previewNoWorker: $t('frameleaf_studio_server_preview_no_worker'),
      previewWithoutWebGpu: $t('frameleaf_studio_local_preview_without_webgpu'),
      editSuperseded: $t('frameleaf_studio_edit_superseded'),
      // The adapter fills these in; the host keeps them as markers.
      importNotKept: $t('frameleaf_studio_import_not_kept', { values: { file: '{file}', reason: '{reason}' } }),
    },
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

  const mountEngine = (): Promise<void> => {
    if (mounting && mounting.token === mountToken) {
      return mounting.done;
    }
    const token = ++mountToken;
    const done = startMount(token).finally(() => {
      if (mounting?.token === token) {
        mounting = null;
      }
    });
    mounting = { token, done };
    return done;
  };

  const startMount = async (token: number) => {
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
      const instance = await resolution.module.mount(stage, context(), {
        ...services,
        reportFatal: (error) => {
          services.reportFatal(error);
          dispatch({ type: 'fatal', detail: error instanceof Error ? error.message : String(error) });
        },
      });
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

  // The reducer decides whether a retry can mount (the probe may still say the workers are
  // missing); `dispatch` starts the mount when it can.
  const retry = async () => {
    if (destroyed || accessLost || !studioHostCanRetry(host)) {
      return;
    }
    if (onRetry && !(await onRetry())) {
      return;
    }
    if (destroyed || accessLost || !online || !studioHostCanRetry(host)) {
      return;
    }
    dispatch({ type: 'retry' });
  };

  onMount(() => {
    online = globalThis.navigator?.onLine;
    dispatch({ type: 'connectivity', online });

    const goOnline = () => {
      if (online) {
        return;
      }
      online = true;
      // Join the route's refresh before mounting from a pre-offline capability snapshot.
      if (onRetry) {
        void onRetry().then((applied) => {
          if (!applied || destroyed || accessLost || !online) {
            return;
          }
          dispatch({ type: 'connectivity', online: true });
        });
        return;
      }
      dispatch({ type: 'connectivity', online: true });
    };
    const goOffline = () => {
      online = false;
      dispatch({ type: 'connectivity', online: false });
    };
    addEventListener('online', goOnline);
    addEventListener('offline', goOffline);

    // Normally the probe's answer starts the mount through `dispatch`; this covers the case where
    // the answer was already known before the stage element existed.
    if (studioHostCanMount(host)) {
      void mountEngine();
    }

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
  // engine. The phase is tracked too: a change made while the engine was still starting (the
  // engine reporting it has no WebCodecs, so the server preview opens) reaches it once it is
  // ready, instead of being lost because there was no engine to update at the time.
  $effect(() => {
    const next = context();
    // Offline keeps the engine running and on screen, so it still hears about changes (`online` among them).
    const ready = editorUp;
    untrack(() => {
      if (engine && ready) {
        engine.update(next);
      }
    });
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
    destroyed = true;
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
    <!--
      One way back. From a photo's quick editor it returns there with the draft (FL-113); otherwise it
      goes to the project list, where the person opened this film.
    -->
    {#if onBackToEditor && !accessLost}
      <Button variant="quiet" label={$t('frameleaf_studio_back_to_quick_edit')} onclick={onBackToEditor}>
        <Icon icon={mdiArrowLeft} size={ICON_SIZE.lg} />
        <span class="fl-studio-label">{$t('frameleaf_studio_back_to_quick_edit')}</span>
      </Button>
    {:else}
      <Button variant="quiet" label={$t('frameleaf_studio_back_to_projects')} onclick={onBack}>
        <Icon icon={mdiArrowLeft} size={ICON_SIZE.lg} />
        <span class="fl-studio-label keep">{$t('frameleaf_studio_back_to_projects')}</span>
      </Button>
    {/if}

    <div class="fl-studio-project">
      {#if blocked && !hasSavedProject}
        <!-- Nothing was opened, so there is no project to name: the header says where the person is. -->
        <h1>{$t('frameleaf_studio_title')}</h1>
      {:else if editorUp && onRename && !accessLost}
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
      {#if editorUp}
        <span class="fl-studio-save" role="status" aria-live="polite" data-state={pill}>
          {#key pill}
            <span class="fl-studio-save-inner" class:settled={pill === 'saved' && settled} in:reveal>
              {#if pill === 'saving'}
                <Icon icon={mdiProgressClock} size={ICON_SIZE.sm} />
                {$t('frameleaf_studio_saving')}
              {:else if pill === 'offline'}
                <Icon icon={mdiCloudOffOutline} size={ICON_SIZE.sm} />
                {$t('frameleaf_studio_offline_pill')}
              {:else if pill === 'conflict'}
                <Icon icon={mdiAlertCircleOutline} size={ICON_SIZE.sm} />
                {$t('frameleaf_studio_conflict_title')}
              {:else if pill === 'lease-lost'}
                <Icon icon={mdiLockOutline} size={ICON_SIZE.sm} />
                {$t('frameleaf_studio_lease_lost_title')}
              {:else if pill === 'unsaved'}
                {$t('frameleaf_studio_unsaved')}
              {:else if pill === 'read-only'}
                <Icon icon={mdiLockOutline} size={ICON_SIZE.sm} />
                {$t('frameleaf_studio_read_only')}
              {:else}
                <Icon icon={mdiCheckCircle} size={ICON_SIZE.sm} />
                {$t('frameleaf_studio_all_saved')}
              {/if}
            </span>
          {/key}
        </span>
      {/if}
    </div>

    <div class="fl-studio-tools">
      {#if droppedAssetCount > 0}
        <span class="fl-studio-dropped" role="status">
          {$t('frameleaf_studio_handoff_dropped', { values: { count: droppedAssetCount } })}
        </span>
      {/if}

      {#if exportJob}
        <!-- The film being made: its progress, then the way to it. The percentage is not read out on every change. -->
        <span class="fl-studio-job" data-phase={exportPhase} data-testid="studio-export-job">
          <span class="sr-only" role="status">{$t(exportPhaseKey)}</span>
          {#key exportPhase}
            <span class="fl-studio-job-label" aria-hidden="true" in:reveal>
              {#if exportPhase === 'ready'}
                <span class="fl-studio-job-done fl-pop"><Icon icon={mdiCheckCircle} size={ICON_SIZE.sm} /></span>
                {$t('frameleaf_studio_export_job_ready')}
              {:else if exportPhase === 'failed'}
                <Icon icon={mdiAlertCircleOutline} size={ICON_SIZE.sm} />
                {$t('frameleaf_studio_export_job_failed')}
              {:else if exportPhase === 'queued'}
                <Spinner size="sm" decorative />
                {$t('frameleaf_studio_export_job_queued')}
              {:else}
                <Spinner size="sm" decorative />
                {$t('frameleaf_studio_export_job_progress', { values: { percent: exportPercent } })}
              {/if}
            </span>
          {/key}
          {#if exportPhase === 'working'}
            <span class="fl-studio-job-bar" style:transform="scaleX({exportPercent / 100})"></span>
          {/if}
        </span>
        {#if exportPhase === 'ready' && onOpenExport}
          <Button variant="quiet" onclick={onOpenExport}>{$t('frameleaf_studio_export_job_open')}</Button>
        {:else if exportPhase !== 'ready' && onOpenActivity}
          <Button variant="quiet" onclick={onOpenActivity}>{$t('frameleaf_studio_bundle_open_activity')}</Button>
        {/if}
      {/if}

      {#if queuedJobs > 0 && onOpenActivity}
        <Button variant="quiet" onclick={onOpenActivity}>
          <Icon icon={mdiProgressClock} size={ICON_SIZE.md} />
          {$t('frameleaf_studio_queued_open_activity', { values: { count: queuedJobs } })}
        </Button>
      {/if}

      {#if editorUp}
        <span class="fl-studio-editor-as">
          {#if auth.avatarUrl}
            <img class="fl-studio-avatar" src={auth.avatarUrl} alt="" />
          {:else}
            <span class="fl-studio-avatar" aria-hidden="true">{auth.name.slice(0, 1).toUpperCase()}</span>
          {/if}
          <span class="fl-studio-label wide">{$t('frameleaf_studio_editing_as', { values: { name: auth.name } })}</span>
        </span>

        {#if capabilities?.renderWorker === true}
          <!-- The server preview is opened from here, so nothing floats over the timeline to offer it. -->
          <button
            type="button"
            class="fl-studio-tool"
            aria-pressed={serverPreviewOpen}
            aria-label={$t('frameleaf_studio_server_preview_toggle')}
            data-testid="studio-server-preview-show"
            onclick={() => (serverPreviewOpen = !serverPreviewOpen)}
          >
            <Icon icon={mdiMonitorEye} size={ICON_SIZE.md} />
            <span class="fl-studio-label">{$t('frameleaf_studio_server_preview_toggle')}</span>
          </button>
        {/if}
      {/if}

      {#if hasSavedProject}
        <!-- Comments and versions are read from the server, so they stay reachable without the editor. -->
        <Button variant="quiet" pressed={historyOpen} onclick={toggleHistory}>
          <Icon icon={mdiCommentTextOutline} size={ICON_SIZE.md} />
          {$t('frameleaf_studio_review')}
          {#if unresolvedComments > 0}
            {#key unresolvedComments}
              <span class="fl-studio-count" in:pop>{unresolvedComments}</span>
            {/key}
            <span class="sr-only"
              >{$t('frameleaf_studio_review_open_count', { values: { count: unresolvedComments } })}</span
            >
          {/if}
        </Button>
      {/if}

      {#if editorUp && onUseRestoration && !accessLost}
        <Button
          variant="quiet"
          pressed={restoreOpen}
          label={$t('frameleaf_studio_restore_title')}
          onclick={toggleRestore}
        >
          <Icon icon={mdiAutoFix} size={ICON_SIZE.md} />
          <span class="fl-studio-label">{$t('frameleaf_studio_restore_title')}</span>
        </Button>
      {/if}

      {#if editorUp && onExport && !accessLost}
        <Button variant="primary" onclick={onExport}>
          <Icon icon={mdiExportVariant} size={ICON_SIZE.md} />
          {$t('frameleaf_studio_export_action')}
        </Button>
      {/if}

      {#if editorUp && onExportBundle && !accessLost}
        <!-- Rare actions live here, so the header keeps one primary button at every width. -->
        <Menu label={$t('more')} align="end">
          {#snippet trigger()}
            <Icon icon={mdiDotsHorizontal} size={ICON_SIZE.lg} />
          {/snippet}
          <MenuItem onSelect={onExportBundle}>
            <Icon icon={mdiPackageVariantClosed} size={ICON_SIZE.md} />
            {$t('frameleaf_studio_bundle_export_action')}
          </MenuItem>
        </Menu>
      {/if}
    </div>
  </header>

  {#if bannerStatus}
    <!--
      Persistence trouble is the person's to resolve, so it is stated in plain terms with the
      choices spelled out. Nothing here discards the draft on its own: reload and save-as-copy
      are explicit, and taking a lease away from another window is never implied by a retry.
    -->
    <div
      class="fl-studio-banner"
      role="alert"
      data-testid="studio-save-banner"
      data-status={bannerStatus}
      in:bannerIn
      out:bannerOut
    >
      <Icon icon={bannerStatus === 'offline' ? mdiCloudOffOutline : mdiAlertCircleOutline} size={ICON_SIZE.lg} />
      <p>
        {#if bannerStatus === 'conflict'}
          {$t('frameleaf_studio_conflict_body')}
        {:else if bannerStatus === 'lease-lost'}
          {$t('frameleaf_studio_lease_lost_body')}
        {:else if bannerStatus === 'offline'}
          {$t('frameleaf_studio_offline_saving')}
        {:else}
          {$t('frameleaf_studio_save_failed')}
        {/if}
      </p>
      <div class="fl-studio-banner-actions">
        {#if bannerStatus === 'conflict' && onReload}
          <Button variant="quiet" onclick={onReload}>{$t('frameleaf_studio_conflict_reload')}</Button>
        {/if}
        {#if bannerStatus === 'lease-lost' && onReacquire}
          <Button variant="quiet" onclick={onReacquire}>{$t('frameleaf_studio_lease_lost_reacquire')}</Button>
        {/if}
        {#if bannerStatus === 'lease-lost' && conflict?.lease?.heldByAnother && onTakeOver}
          <Button variant="quiet" onclick={onTakeOver}>{$t('frameleaf_studio_lease_lost_take_over')}</Button>
        {/if}
        {#if (bannerStatus === 'conflict' || bannerStatus === 'lease-lost') && onSaveCopy}
          <Button variant="primary" onclick={onSaveCopy}>{$t('frameleaf_studio_conflict_save_copy')}</Button>
        {/if}
      </div>
    </div>
  {/if}

  {#if unavailableRestorations.length > 0}
    <!-- FL-115: a restored version the project places cannot be used; it is named, never replaced. -->
    <div class="fl-studio-banner" role="alert" data-testid="studio-restored-unavailable" in:bannerIn out:bannerOut>
      <Icon icon={mdiAlertCircleOutline} size={ICON_SIZE.lg} />
      <ul class="fl-studio-restored-list">
        {#each unavailableRestorations as item, index (index)}
          <li>{$t(unavailableRestorationKeys[item.reason], { values: { name: item.name } })}</li>
        {/each}
      </ul>
    </div>
  {/if}

  {#if unsupportedSources.length > 0}
    <!--
      FL-101: a video the server cannot decode is refused as soon as it is admitted, and said here with
      the reason, rather than left to fail when a preview or export is rendered.
    -->
    <div class="fl-studio-banner" role="status" data-testid="studio-unsupported-sources" in:bannerIn out:bannerOut>
      <Icon icon={mdiAlertCircleOutline} size={ICON_SIZE.lg} />
      <p>
        {$t('frameleaf_studio_sources_unsupported', { values: { count: unsupportedSources.length } })}
        {unsupportedReasons.map((key) => $t(key)).join(' ')}
      </p>
    </div>
  {/if}

  {#if showQuickEditNote}
    <!--
      Finding 35: Studio opens the saved photo or clip, not the quick editor's unsaved draft. One line
      says the draft is still there and how to get back to it; it goes away for good when dismissed.
    -->
    <div
      class="fl-studio-strip fl-studio-quick-edit"
      data-testid="studio-quick-edit-waiting"
      role="status"
      in:bannerIn
      out:bannerOut
    >
      <Icon icon={mdiTune} size={ICON_SIZE.md} />
      <span>{$t('frameleaf_studio_quick_edit_waiting')}</span>
      <Button variant="quiet" onclick={onBackToEditor}>{$t('frameleaf_studio_back_to_quick_edit')}</Button>
      <IconButton label={$t('dismiss')} onclick={() => (quickEditNoteDismissed = true)}>
        <Icon icon={mdiClose} size={ICON_SIZE.md} />
      </IconButton>
    </div>
  {/if}

  {#if editorUp && localPreviewWithoutWebGpu}
    <!--
      FL-96, FL-112: a standing fact about this browser, so it has a quiet strip of its own under the
      header instead of a chip over the timeline.
    -->
    <div
      class="fl-studio-strip"
      data-testid="studio-local-preview-without-webgpu"
      role="status"
      in:bannerIn
      out:bannerOut
    >
      <Icon icon={mdiAlertCircleOutline} size={ICON_SIZE.md} />
      <span>{$t('frameleaf_studio_local_preview_without_webgpu')}</span>
    </div>
  {/if}

  <div class="fl-studio-body" style:--fl-studio-drawer-width={drawerWidth}>
    <!--
      The engine's only surface. It is always in the DOM so the mount target exists before
      the engine resolves, and it is hidden from assistive technology until the engine is
      actually running.
    -->
    <div
      class="fl-studio-stage"
      bind:this={stage}
      data-testid="studio-stage"
      aria-hidden={editorUp ? undefined : 'true'}
    ></div>

    <!--
      The preview area (FL-96). It says what is true and nothing more: while a frame is being
      rendered it says so; once the project revision moves past the frame on screen it says the
      picture is out of date instead of leaving it looking current; and when the frame cannot be
      produced it says that, with the stable code kept for diagnostics rather than shown as the
      message. There is deliberately no state here that presents an old frame as the live one.
    -->
    {#if editorUp}
      <StudioServerPreview
        bind:open={serverPreviewOpen}
        {preview}
        {stream}
        available={capabilities?.renderWorker === true}
        onVideoSize={onStreamVideoSize}
      />
    {/if}

    <!-- With the panel open the panel says it; the notice covers the frame the engine asked for otherwise. -->
    {#if editorUp && previewNoticePhase && !serverPreviewOpen}
      <div
        class="fl-studio-preview"
        data-testid="studio-preview-state"
        data-preview-phase={previewNoticePhase}
        role="status"
        aria-live="polite"
        in:reveal
        out:revealOut
      >
        <Icon
          icon={previewNoticePhase === 'rendering' ? mdiProgressClock : mdiAlertCircleOutline}
          size={ICON_SIZE.md}
        />
        <span>{previewNoticeKey ? $t(previewNoticeKey) : ''}</span>
        {#if previewNoticePhase === 'stale' && preview.staleFrame}
          <span class="fl-studio-preview-note">{$t('frameleaf_studio_preview_showing_previous')}</span>
        {/if}
      </div>
    {/if}

    {#if historyOpen && session && hasSavedProject}
      <div class="fl-studio-drawer" use:studioDrawer={closeDrawers} in:drawerIn out:drawerOut>
        <StudioHistoryPanel
          {session}
          revision={project.revision}
          userId={auth.userId}
          {access}
          canRestore={project.hasLease && saveStatus !== 'conflict' && saveStatus !== 'lease-lost'}
          {playhead}
          onClose={closeDrawers}
        />
      </div>
    {/if}

    {#if restoreOpen && onUseRestoration && !accessLost}
      <div class="fl-studio-drawer" use:studioDrawer={closeDrawers} in:drawerIn out:drawerOut>
        <StudioRestorePanel
          {assets}
          assetId={restoreRequest?.assetId ?? null}
          focus={restoreRequest?.focus ?? 'restore'}
          theme={appTheme}
          onUseInStudio={onUseRestoration}
          onClose={closeDrawers}
        />
      </div>
    {/if}

    {#if showState && headingKey}
      <div class="fl-studio-state" data-testid="studio-state" data-phase={host.phase} out:overlayOut>
        {#if host.phase === 'loading'}
          <!--
            Opening: the poster the person clicked grows into place here (the card and this picture share
            a `data-fl-shared` key, which the root layout pairs), with the film's name under it. Without
            one, the shape of the workspace.
          -->
          {#if opening?.posterUrl}
            <img
              class="fl-studio-opening-poster"
              src={opening.posterUrl}
              alt=""
              data-fl-shared={opening.projectId ? studioProjectSharedKey(opening.projectId) : undefined}
              data-fl-shared-page={opening.projectId ? '' : undefined}
            />
          {:else}
            <div class="fl-studio-opening-poster" aria-hidden="true">
              <Skeleton variant="block" aspect="16 / 9" />
              <Skeleton variant="text" lines={3} />
            </div>
          {/if}
          <div class="fl-studio-opening-title">
            <Spinner size="md" decorative />
            <h2>
              {opening ? $t('frameleaf_studio_opening_named', { values: { name: opening.name } }) : $t(headingKey)}
            </h2>
          </div>
        {:else}
          <span class="fl-studio-state-icon" aria-hidden="true">
            <Icon
              icon={host.phase === 'offline'
                ? mdiCloudOffOutline
                : host.phase === 'forbidden'
                  ? mdiLockOutline
                  : mdiAlertCircleOutline}
              size={ICON_SIZE.hero}
            />
          </span>
          <h2>{$t(headingKey)}</h2>

          {#if host.messageKey}
            <p>{$t(host.messageKey)}</p>
          {/if}

          <div class="fl-studio-state-actions">
            {#if studioHostCanRetry(host)}
              <Button onclick={() => void retry()}>{$t('frameleaf_studio_retry')}</Button>
            {/if}
            <Button variant={studioHostCanRetry(host) ? 'quiet' : 'primary'} onclick={onBack}>
              <Icon icon={mdiArrowLeft} size={ICON_SIZE.md} />
              {$t('frameleaf_studio_back_to_projects')}
            </Button>
          </div>

          {#if host.phase === 'unavailable' && host.missingCapabilities.length > 0}
            <!--
              What the server is missing, in the words whoever runs it will look for. Folded away: the
              sentence above is the part a person at home can act on.
            -->
            <details class="fl-studio-admin">
              <summary>{$t('frameleaf_studio_missing_capabilities')}</summary>
              <ul aria-label={$t('frameleaf_studio_missing_capabilities')}>
                {#each host.missingCapabilities as capability (capability)}
                  <li>{$t(studioCapabilityLabelKey(capability))}</li>
                {/each}
              </ul>
            </details>
          {/if}
        {/if}
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
    position: relative;
    /* Above the body, so the More menu opens over the editor and its drawers. */
    z-index: 1;
    display: flex;
    /* Wraps rather than pushing Export off the edge when a narrow window cannot hold one row. */
    flex-wrap: wrap;
    align-items: center;
    gap: var(--fl-space-1) var(--fl-space-2);
    min-width: 0;
    padding: var(--fl-space-2) var(--fl-space-3);
    border-bottom: 1px solid var(--fl-border);
    background: var(--fl-panel);
  }
  .fl-studio-project {
    display: flex;
    align-items: center;
    gap: var(--fl-space-3);
    flex: 1 1 12rem;
    min-width: 0;
  }
  .fl-studio-project h1 {
    margin: 0;
    min-width: 0;
    font: var(--fl-type-callout);
    font-size: var(--fl-font-size);
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  /* studio.css `.fls-project-name`: the name reads as a title until it is edited. */
  .fl-studio-project-name {
    flex: 0 1 22rem;
    min-width: 6rem;
    padding: var(--fl-space-1) var(--fl-space-2);
    border: 1px solid transparent;
    border-radius: var(--fl-radius-control);
    background: transparent;
    color: var(--fl-text);
    font: inherit;
    font-size: var(--fl-font-size);
    font-weight: 600;
    text-overflow: ellipsis;
    transition:
      border-color var(--fl-motion-fast) var(--fl-ease),
      background-color var(--fl-motion-fast) var(--fl-ease);
  }
  .fl-studio-project-name:hover,
  .fl-studio-project-name:focus {
    border-color: var(--fl-border);
    background: var(--fl-canvas);
  }
  /* Without hover there is nothing to reveal the field, so it always shows its edge. */
  @media (hover: none) {
    .fl-studio-project-name {
      border-color: var(--fl-border);
    }
  }
  .fl-studio-tools {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: var(--fl-space-1);
    flex: 0 1 auto;
    min-width: 0;
    margin-inline-start: auto;
  }
  .fl-studio-tools .fl-studio-dropped {
    max-width: 16rem;
    white-space: normal;
  }
  /* A quiet header control that carries a test hook, drawn as the quiet Button is. */
  .fl-studio-tool {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: var(--fl-space-2);
    flex-shrink: 0;
    padding: var(--fl-space-2) var(--fl-space-3);
    border: 1px solid transparent;
    border-radius: var(--fl-radius-control);
    background: transparent;
    color: var(--fl-text);
    white-space: nowrap;
    cursor: pointer;
  }
  .fl-studio-tool:hover {
    background: var(--fl-raised);
  }
  .fl-studio-tool[aria-pressed='true'] {
    background: color-mix(in srgb, var(--fl-text) 12%, var(--fl-raised));
    border-color: color-mix(in srgb, var(--fl-text) 28%, var(--fl-border));
  }
  /* A person's round avatar (people photos are the squircles), as `PersonAvatar` draws it. */
  .fl-studio-avatar {
    display: inline-grid;
    place-items: center;
    flex-shrink: 0;
    width: 26px;
    height: 26px;
    border-radius: 50%;
    object-fit: cover;
    background: var(--fl-raised);
    color: var(--fl-text);
    font-size: var(--fl-font-small);
    font-weight: 600;
  }
  .fl-studio-count {
    display: inline-block;
    min-width: 1.25rem;
    padding: 0 var(--fl-space-1);
    border-radius: var(--fl-radius-pill);
    background: var(--fl-accent);
    color: var(--fl-accent-text);
    font-size: var(--fl-font-small);
    font-variant-numeric: var(--fl-numeric);
    text-align: center;
  }
  .fl-studio-save,
  .fl-studio-save-inner,
  .fl-studio-dropped,
  .fl-studio-editor-as,
  .fl-studio-job-label {
    display: inline-flex;
    align-items: center;
    gap: var(--fl-space-1);
    font-size: var(--fl-font-callout);
    color: var(--fl-muted);
    white-space: nowrap;
  }
  .fl-studio-save {
    flex-shrink: 0;
  }
  .fl-studio-editor-as {
    gap: var(--fl-space-2);
    padding-inline: var(--fl-space-2);
  }
  /* "All changes saved" arriving after "Saving…": the tick settles once. */
  .fl-studio-save-inner.settled :global(svg) {
    color: var(--fl-success);
    animation: fl-pop-in var(--fl-duration) var(--fl-spring) both;
  }
  .fl-studio-save[data-state='offline'] {
    color: var(--fl-warning);
  }
  /* The export being made: a capsule with a hairline of progress along its lower edge. */
  .fl-studio-job {
    position: relative;
    display: inline-flex;
    align-items: center;
    overflow: hidden;
    padding: var(--fl-space-1) var(--fl-space-3);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-pill);
    background: var(--fl-raised);
  }
  .fl-studio-job-label {
    color: var(--fl-text);
    font-variant-numeric: var(--fl-numeric);
  }
  .fl-studio-job[data-phase='ready'] {
    border-color: color-mix(in srgb, var(--fl-success) 45%, var(--fl-border));
  }
  .fl-studio-job-done {
    display: inline-flex;
  }
  .fl-studio-job[data-phase='ready'] .fl-studio-job-label :global(svg) {
    color: var(--fl-success);
  }
  .fl-studio-job[data-phase='failed'] .fl-studio-job-label {
    color: var(--fl-warning);
  }
  .fl-studio-job-bar {
    position: absolute;
    inset: auto 0 0;
    height: 2px;
    background: var(--fl-accent);
    transform-origin: left center;
    transition: transform var(--fl-motion-slow) linear;
  }
  :global([dir='rtl']) .fl-studio-job-bar {
    transform-origin: right center;
  }
  .fl-studio-banner,
  .fl-studio-strip {
    display: flex;
    align-items: center;
    gap: var(--fl-space-3);
    flex-wrap: wrap;
    padding: var(--fl-space-2) var(--fl-space-3);
    border-bottom: 1px solid var(--fl-border);
    background: var(--fl-warning);
    color: var(--fl-warning-text);
    font-size: var(--fl-font-size);
  }
  .fl-studio-strip {
    flex-wrap: nowrap;
    gap: var(--fl-space-2);
    background: var(--fl-panel);
    color: var(--fl-muted);
    font-size: var(--fl-font-callout);
  }
  .fl-studio-strip > :global(svg) {
    flex-shrink: 0;
    color: var(--fl-warning);
  }
  /* Not a warning: the draft is safe, so the mark is the accent and the line keeps to one row. */
  .fl-studio-quick-edit {
    padding-block: var(--fl-space-1);
  }
  .fl-studio-quick-edit > :global(svg) {
    color: var(--fl-accent);
  }
  .fl-studio-quick-edit > span {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .fl-studio-banner p {
    margin: 0;
    flex: 1 1 16rem;
  }
  .fl-studio-restored-list {
    margin: 0;
    padding: 0;
    list-style: none;
    flex: 1 1 16rem;
  }
  .fl-studio-banner-actions {
    display: flex;
    gap: var(--fl-space-2);
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
    inset-inline-end: 0;
    bottom: 0;
    z-index: 2;
    display: flex;
    max-width: 100%;
    box-shadow: var(--fl-shadow-3);
  }
  .fl-studio-stage {
    position: absolute;
    inset: 0;
    /* The engine lays itself out inside this box and never escapes it. */
    overflow: hidden;
  }
  .fl-studio-preview {
    position: absolute;
    top: var(--fl-space-2);
    left: 50%;
    transform: translateX(-50%);
    display: flex;
    align-items: center;
    gap: var(--fl-space-2);
    max-width: calc(100% - var(--fl-space-4));
    padding: var(--fl-space-1) var(--fl-space-3);
    font-size: var(--fl-font-callout);
    color: var(--fl-text);
    background: var(--fl-panel);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-pill);
    box-shadow: var(--fl-shadow-1);
    pointer-events: none;
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
    z-index: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: var(--fl-space-3);
    padding: var(--fl-space-8) var(--fl-space-4);
    text-align: center;
    background: var(--fl-canvas);
  }
  .fl-studio-state-icon {
    color: var(--fl-muted);
  }
  .fl-studio-state h2 {
    margin: 0;
    font: var(--fl-type-headline);
  }
  .fl-studio-state p {
    margin: 0;
    max-width: 34rem;
    color: var(--fl-muted);
  }
  .fl-studio-state-actions {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: var(--fl-space-2);
    margin-top: var(--fl-space-1);
  }
  .fl-studio-admin {
    margin-top: var(--fl-space-2);
    color: var(--fl-muted);
    font-size: var(--fl-font-callout);
  }
  .fl-studio-admin summary {
    display: inline-block;
    padding: var(--fl-space-2) var(--fl-space-3);
    border-radius: var(--fl-radius-control);
    cursor: pointer;
    text-decoration: underline;
    text-underline-offset: 3px;
  }
  .fl-studio-admin ul {
    margin: var(--fl-space-2) 0 0;
    padding: 0;
    list-style: none;
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: var(--fl-space-2);
  }
  .fl-studio-admin li {
    padding: var(--fl-space-1) var(--fl-space-2);
    color: var(--fl-text);
    background: var(--fl-raised);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
  }
  .fl-studio-opening-poster {
    display: grid;
    gap: var(--fl-space-3);
    width: min(28rem, 80%);
    aspect-ratio: 16 / 9;
    object-fit: cover;
    border-radius: var(--fl-radius-card);
  }
  img.fl-studio-opening-poster {
    box-shadow: var(--fl-shadow-3);
  }
  div.fl-studio-opening-poster {
    aspect-ratio: auto;
  }
  .fl-studio-opening-title {
    display: flex;
    align-items: center;
    gap: var(--fl-space-2);
    color: var(--fl-muted);
  }
  /* 1280px: the editor's name gives way first. */
  @media (max-width: 80rem) {
    .fl-studio-label.wide {
      display: none;
    }
    .fl-studio-project-name {
      flex-basis: 14rem;
    }
  }
  /* 1100px, a tablet on its side: secondary controls keep their icon and their accessible name. */
  @media (max-width: 68.75rem) {
    .fl-studio-label:not(.keep) {
      display: none;
    }
  }
  /* 700px: the header wraps and the title takes a row of its own, as the prototype did. */
  @media (max-width: 43.75rem) {
    .fl-studio-project {
      order: 3;
      flex-basis: 100%;
    }
    .fl-studio-project-name {
      flex: 1 1 auto;
    }
    .fl-studio-tools {
      flex: 1 1 auto;
      flex-wrap: wrap;
    }
  }
  /* Tailwind's `md`, where the top bar becomes its two-row phone grid. */
  @media (max-width: 47.99rem) {
    .fl-studio {
      height: calc(100dvh - var(--fl-topbar-height-phone));
    }
  }
</style>
