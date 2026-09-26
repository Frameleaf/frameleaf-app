<script lang="ts">
  /**
   * The Studio route (FL-88, `STU-201`; project persistence FL-89, `STU-202`).
   *
   * Svelte owns everything outside the editor: it authenticates, resolves the handoff
   * selection, probes what the deployment can run, builds the typed command bridge, owns the
   * project session (load, lease, autosave, history, review) and guards navigation while a
   * draft is unsaved. The React editor, when it is part of the build, is mounted by
   * `StudioHost` into a single element and is handed data and callbacks only — never the
   * SDK, never a token, never the API base URL.
   */
  import { beforeNavigate, goto, replaceState } from '$app/navigation';
  import { onDestroy, onMount, untrack } from 'svelte';
  import { locale, t } from 'svelte-i18n';
  import { toastManager } from '@immich/ui';
  import StudioBundleExportDialog from '$lib/components/frameleaf/StudioBundleExportDialog.svelte';
  import StudioExportDialog, { type StudioExportChoice } from '$lib/components/frameleaf/StudioExportDialog.svelte';
  import StudioHost from '$lib/components/frameleaf/StudioHost.svelte';
  import NavigationBar from '$lib/components/shared-components/navigation-bar/NavigationBar.svelte';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { eventManager } from '$lib/managers/event-manager.svelte';
  import { Route } from '$lib/route';
  import { toStudioAssets } from '$lib/frameleaf/studio/assets';
  import { createStudioBridge } from '$lib/frameleaf/studio/bridge';
  import { decideStudioDraft, studioDraftHeld } from '$lib/frameleaf/studio/draft-staging';
  import { createStudioEngineCommandHandlers, createStudioGraphHistory } from '$lib/frameleaf/studio/engine-commands';
  import { registerFrameStudioEngine } from '$lib/frameleaf/studio/frame-engine';
  import { createStudioBundleHandlers } from '$lib/frameleaf/studio/bundles';
  import { createStudioCommandEnvelope, type StudioCommandPayloads } from '$lib/frameleaf/studio/commands';
  import { probeStudioHost } from '$lib/frameleaf/studio/capabilities';
  import { loadStudioEngine, pinnedFreecutRevision } from '$lib/frameleaf/studio/engine-loader';
  import {
    emptyStudioCapabilities,
    type StudioAuthContext,
    type StudioCapabilities,
    type StudioCommandEngine,
    type StudioDraftResult,
    type StudioRenderEvidence,
    type StudioHostServices,
    type StudioProjectHandle,
    type StudioWorkspaceMode,
    type StudioWorkspaceView,
  } from '$lib/frameleaf/studio/host-contract';
  import type { Rational } from '$lib/frameleaf/studio/rational-time';
  import {
    createStudioPreviewClient,
    idleStudioPreviewView,
    unsavedStudioPreviewView,
    type StudioPreviewClient,
    type StudioPreviewView,
  } from '$lib/frameleaf/studio/preview';
  import { createStudioPreviewTransport } from '$lib/frameleaf/studio/preview-transport';
  import {
    createStudioProjectSession,
    STUDIO_DRAFT_PROJECT_ID,
    type StudioProjectSessionState,
  } from '$lib/frameleaf/studio/project-session';
  import { loadStudioWorkspace, saveStudioWorkspaceLayout } from '$lib/frameleaf/studio/workspace';
  import { reportStudioPlayhead } from '$lib/frameleaf/editor-continuity';
  import { getProfileImageUrl } from '$lib/utils';
  import { handleError } from '$lib/utils/handle-error';
  import { createStudioExport, isHttpError } from '@immich/sdk';
  import { studioRenderRefusalFromError, studioRenderRefusalKey } from '$lib/frameleaf/studio/render-output';
  import { openFileUploadDialog } from '$lib/utils/file-uploader';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  // The built Freecut editor (studio/adapters/web), when this deployment has it (FL-88). Without the
  // build the loader answers `not-built` and the unavailable state says so.
  registerFrameStudioEngine();

  let capabilities = $state<StudioCapabilities>(emptyStudioCapabilities());
  let renderEvidence = $state<StudioRenderEvidence[]>([]);
  let online = $state(true);
  let dirty = $state(false);
  let accessLost = $state(false);
  let preview = $state<StudioPreviewView>(idleStudioPreviewView());
  let sessionState = $state<StudioProjectSessionState | null>(null);
  /** Bundle and export jobs this session handed to Activity (FL-91, FL-106). */
  let queuedJobs = $state(0);
  /** Where the engine's playhead is, for pinning review comments (`Studio.jsx:1759`). */
  let playhead = $state<Rational | null>(null);
  /** Open review comments on the project, for the Review button's count. */
  let unresolvedComments = $state(0);
  /**
   * The account's workspace layout (FL-91, `STU-204`), stored on the server rather than in
   * Freecut's workspace folder. Undefined until read; the engine then starts from its defaults.
   */
  let workspace = $state<StudioWorkspaceView | undefined>(undefined);

  const assets = $derived(toStudioAssets(data.assets));
  const handoffAssetIds = $derived(assets.map((asset) => asset.id));

  const user = $derived(authManager.user);

  const auth = $derived<StudioAuthContext>({
    userId: user.id,
    name: user.name,
    avatarUrl: user.profileImagePath ? getProfileImageUrl(user) : null,
    // The shell's resolved locale, so the editor formats times the same way the rest of
    // the app does rather than following the browser when the person chose otherwise.
    locale: $locale ?? globalThis.navigator?.language ?? 'en',
  });

  /**
   * One editor instance. The lease is held per instance, so two tabs of the same account are
   * two clients; the id is never persisted, because a reload is a new instance by design.
   */
  const clientId =
    typeof globalThis.crypto?.randomUUID === 'function'
      ? crypto.randomUUID()
      : `tab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

  /**
   * The project session (FL-89): durable storage, the immutable revision chain, the write
   * lease and autosave. `?project=` reopens a saved project; without it the host starts an
   * in-memory draft that the first save creates on the server.
   */
  const session = createStudioProjectSession({
    clientId,
    projectId: data.projectId,
    name: $t('frameleaf_studio_untitled_project'),
    engineRevision: pinnedFreecutRevision,
    onChange: (next) => {
      sessionState = next;
    },
  });

  const project = $derived<StudioProjectHandle>(
    sessionState?.project ?? {
      id: data.projectId ?? STUDIO_DRAFT_PROJECT_ID,
      name: $t('frameleaf_studio_untitled_project'),
      revision: 0,
      graph: null,
      // Nothing may be written before the session has decided who holds the lease.
      hasLease: false,
    },
  );

  const saveStatus = $derived(sessionState?.status ?? 'loading');
  const forbidden = $derived(saveStatus === 'forbidden');
  /** Writes are refused while a conflict or a lost lease waits for the person's decision. */
  const writable = $derived(
    project.hasLease && saveStatus !== 'conflict' && saveStatus !== 'lease-lost' && saveStatus !== 'loading',
  );

  /**
   * The remote preview (FL-96). The host owns it: it holds the transport, the frame cache and
   * the revision binding, and hands the engine only the resulting view. The engine asks for a
   * frame with a `preview.request` envelope and never touches the API.
   *
   * Preview is bound to the project session's *stored* revision (FL-89): the request names the
   * project and that revision number, and the server reads the graph from storage and resolves
   * it for this account. Nothing the host invents, and no graph, travels with it. An unsaved
   * draft has no stored revision, so it has nothing to preview.
   */
  const storedRevision = $derived(
    project.id !== STUDIO_DRAFT_PROJECT_ID && project.revision > 0 ? project.revision : null,
  );

  const createPreviewClient = (): StudioPreviewClient => {
    const client = createStudioPreviewClient({
      transport: createStudioPreviewTransport(),
      onChange: (next) => {
        // A client retired for another project may still be settling; only the live one paints.
        if (client === previewClient) {
          preview = next;
        }
      },
    });
    return client;
  };

  let previewClient = createPreviewClient();

  /** Retire the client and everything it cached, and start a fresh one. */
  const resetPreview = (): Promise<void> => {
    const outgoing = previewClient;
    previewClient = createPreviewClient();
    preview = idleStudioPreviewView();
    return outgoing.dispose();
  };

  /**
   * Keep the preview on the session's stored revision. When autosave, a restore or a reload
   * moves the head, every cached frame of the previous revision is released and the one on
   * screen is labelled stale; when the project itself changes (save as copy), nothing cached
   * for the old project survives.
   */
  let previewProjectId: string | null = null;
  $effect(() => {
    const projectId = project.id;
    const revision = storedRevision;
    untrack(() => {
      // A draft's first save only gives it an id; nothing was ever previewed for the draft, and
      // the request that triggered the save may already be in flight on this client.
      const replaced =
        previewProjectId !== null && previewProjectId !== STUDIO_DRAFT_PROJECT_ID && previewProjectId !== projectId;
      if (replaced) {
        void resetPreview();
      }
      previewProjectId = projectId;
      if (revision !== null) {
        previewClient.revisionAdvanced(revision);
      }
    });
  });

  /**
   * The editor's bundle export dialog (FL-91). It opens from the header's Export bundle button, or
   * when the editor asks for an export without saying whether to include copies of owned media;
   * then the editor's command waits here for the answer.
   */
  let exportDialogOpen = $state(false);
  /** Not reactive: the resolver of the editor command waiting for the dialog, if one is. */
  let pendingExportChoice: ((includeMedia: boolean | null) => void) | null = null;

  const settleExportChoice = (choice: boolean | null): boolean => {
    const resolve = pendingExportChoice;
    pendingExportChoice = null;
    resolve?.(choice);
    return resolve !== null;
  };

  const askIncludeMedia = () =>
    new Promise<boolean | null>((resolve) => {
      // One question at a time: an older one still waiting is answered as cancelled.
      settleExportChoice(null);
      pendingExportChoice = resolve;
      exportDialogOpen = true;
    });

  // Closing the dialog any way but Export answers a waiting editor command with a cancel.
  $effect(() => {
    if (!exportDialogOpen) {
      settleExportChoice(null);
    }
  });

  /**
   * Portable bundles (FL-91). Both commands queue a durable job and leave the open graph alone: an
   * export writes the stored revision, an import creates a new project. The person follows either
   * in Activity.
   */
  const bundleHandlers = createStudioBundleHandlers({
    project: () => ({
      id: project.id,
      revision: storedRevision ?? 0,
      saved: storedRevision !== null,
    }),
    askIncludeMedia,
    onQueued: () => {
      queuedJobs += 1;
      toastManager.primary($t('frameleaf_studio_bundle_queued'));
    },
    onRefused: (messageKey) => toastManager.danger($t(messageKey)),
  });

  /**
   * Canonical commands (FL-92). The engine's command runtime applies them to the session's graph in
   * its own document, apart from the editor; the result is staged like any other draft. Every graph
   * this session replaced is kept for `history.undo` / `history.redo`.
   */
  const history = createStudioGraphHistory();
  let commandEngine: Promise<StudioCommandEngine | null> | null = null;
  const engineForCommands = () => {
    commandEngine ??= loadStudioEngine()
      .then((resolution) =>
        resolution.status === 'available' && resolution.module.createCommandEngine
          ? resolution.module.createCommandEngine()
          : null,
      )
      .catch(() => null)
      .then((engine) => {
        // A runtime that could not start is tried again on the next command, not remembered.
        if (!engine) {
          commandEngine = null;
        }
        return engine;
      });
    return commandEngine;
  };
  const releaseCommandEngine = () => {
    const pending = commandEngine;
    commandEngine = null;
    void pending?.then((engine) => engine?.dispose());
  };

  const engineHandlers = createStudioEngineCommandHandlers({
    graph: () => project.graph,
    revision: () => project.revision,
    assets: () => assets,
    stage: (graph, commandIds, envelopes) => session.stage(graph, commandIds, envelopes),
    restore: (revision) => session.restore(revision),
    engine: engineForCommands,
    history,
  });

  // A different project, or a reload that discarded the draft, starts a fresh history.
  let historyProjectId: string | null = null;
  $effect(() => {
    const id = project.id;
    untrack(() => {
      if (historyProjectId !== null && historyProjectId !== STUDIO_DRAFT_PROJECT_ID && historyProjectId !== id) {
        history.clear();
      }
      historyProjectId = id;
    });
  });

  const bridge = createStudioBridge({
    context: () => ({
      revision: project.revision,
      hasLease: writable,
      hasAccess: !accessLost && !forbidden && authManager.authenticated,
      online,
      capabilities,
    }),
    // Implemented here: the engine's graph commands and history (FL-92), the preview pair (FL-96)
    // and the bundle pair (FL-91). Every other row stays a typed extension point owned by a later
    // story and is rejected as `not-implemented` rather than silently no-oped.
    handlers: {
      ...engineHandlers,
      'preview.request': async (envelope) => {
        const payload = envelope.payload as StudioCommandPayloads['preview.request'];

        // The server renders stored revisions only. Edits still waiting for the autosave
        // debounce are stored first, so the frame shows what the person is looking at rather
        // than the revision before their last change. A failed save leaves its own status.
        if (sessionState?.hasDraft && writable) {
          await session.flush().catch(() => {});
        }

        const revision = storedRevision;
        if (revision === null) {
          preview = unsavedStudioPreviewView();
          return project.revision;
        }

        previewClient.request({
          projectId: project.id,
          revision,
          time: payload.at,
          quality: payload.quality,
          viewportWidth: payload.viewportWidth,
          viewportHeight: payload.viewportHeight,
        });
        // Preview changes nothing about the project, so the revision the bridge reports back is
        // the one the editor already holds.
        return project.revision;
      },
      'preview.release': async () => {
        // Retired and replaced rather than only disposed, so a later request still renders.
        await resetPreview();
        return project.revision;
      },
      'project.exportBundle': async (envelope) => {
        // A bundle is made from the stored revision, so edits waiting for autosave go first.
        if (sessionState?.hasDraft && writable) {
          await session.flush().catch(() => {});
        }
        return bundleHandlers['project.exportBundle'](envelope);
      },
      'project.importBundle': (envelope) => bundleHandlers['project.importBundle'](envelope),
    },
  });

  /**
   * The editor's own saves (FL-89 autosave; FL-92's "replace graph" draft primitive). The same rules
   * as a command decide it: access, connectivity, then the lease. The server checks the envelope
   * again before it stores anything.
   */
  const stageDraft = (
    graph: unknown,
    commandIds: readonly string[],
    baseRevision?: number,
  ): Promise<StudioDraftResult> => {
    // Offline, after a lost lease or in a conflict the session keeps the draft and sends it when the
    // connection or the lease is back; only a session that may not hold a draft refuses it.
    const decision = decideStudioDraft(
      {
        accessLost,
        forbidden,
        authenticated: authManager.authenticated,
        access: sessionState?.access ?? null,
        status: saveStatus,
      },
      graph,
    );
    if (!decision.stage) {
      return Promise.resolve(decision.result);
    }
    // The session keeps `project.graph` on the newest draft (in a conflict too, never the head), so
    // history records this edit against the draft's own previous graph.
    const before = project.graph;
    session.stage(graph, commandIds.length > 0 ? commandIds : ['editor.save'], [], baseRevision);
    if (!session.state.hasDraft) {
      return Promise.resolve({ status: 'rejected', reason: 'lease-lost' });
    }
    if (before) {
      history.record(before, graph);
    }
    return Promise.resolve({ status: 'staged' });
  };

  const services: StudioHostServices = {
    submitCommands: (envelopes) => bridge.submit(envelopes),
    stageDraft,
    reloadProject: () => session.reload(),
    resolveAsset: (assetId) => assets.find((asset) => asset.id === assetId),
    notify: (message, tone) => {
      if (tone === 'error') {
        toastManager.danger(message);
      } else {
        toastManager.primary(message);
      }
    },
    navigate: (target) => {
      switch (target.kind) {
        case 'library': {
          void goto(Route.photos());
          break;
        }
        case 'activity': {
          // Bundle jobs (FL-91) are followed on the Activity page (FL-104).
          void goto(Route.activity());
          break;
        }
        case 'asset': {
          void goto(Route.viewAsset({ id: target.assetId }));
          break;
        }
      }
    },
    setDirty: (next) => {
      dirty = next;
    },
    reportFatal: (error) => {
      toastManager.danger(error instanceof Error ? error.message : $t('frameleaf_studio_error_body'));
    },
    reportPlayhead: (time) => {
      playhead = { num: time.num, den: time.den };
    },
    saveWorkspace: (layout) => saveStudioWorkspaceLayout(layout, pinnedFreecutRevision),
    // The editor's own Export control opens the same dialog as the header's (FL-106).
    requestExport: () => {
      if (canExportVideo) {
        videoExportOpen = true;
      } else {
        toastManager.danger($t('frameleaf_studio_export_unavailable'));
      }
    },
  };

  /**
   * Back to the library, as the prototype's header does (`Studio.jsx:2586-2588`). The project
   * library stays one click away under Tools > Studio in the rail.
   */
  const onBack = () => void goto(Route.photos());

  /**
   * Back to the quick editor that opened Studio (FL-113). Studio's playhead goes with the person, and
   * the draft they left there is waiting for them (`editor-continuity.ts`); the unsaved-work guard
   * still runs for anything Studio holds.
   */
  const returnTo = data.returnTo;
  const onBackToEditor = returnTo
    ? () => {
        reportStudioPlayhead(returnTo, playhead);
        void goto(`${Route.viewAsset({ id: returnTo })}?edit=1`);
      }
    : undefined;
  const onOpenActivity = () => void goto(Route.activity());

  /** Only an owner's saved project can be exported, so the header offers nothing otherwise. */
  const canExportBundle = $derived(
    storedRevision !== null && sessionState?.access === 'owner' && !accessLost && !forbidden,
  );
  const onExportBundle = () => {
    exportDialogOpen = true;
  };

  /**
   * The person chose Export. A waiting editor command takes the answer and carries on; otherwise the
   * header started it, and the choice travels as a `project.exportBundle` command through the same
   * bridge and handler, so both starts share one path to the export endpoint.
   */
  const onConfirmExport = async (includeMedia: boolean) => {
    const answered = settleExportChoice(includeMedia);
    exportDialogOpen = false;
    if (answered) {
      return;
    }
    const [result] = await bridge.submit([
      createStudioCommandEnvelope('project.exportBundle', { includeMedia }, project.revision),
    ]);
    // The handler shows its own refusals; the bridge's (offline, access) have not been shown yet.
    if (result?.status === 'rejected' && result.reason !== 'failed') {
      toastManager.danger($t(result.messageKey));
    }
  };

  /* Rename (`Studio.jsx:2590-2607`): the owner's, for a draft or a saved project. */
  const canRename = $derived(
    !accessLost && !forbidden && (project.id === STUDIO_DRAFT_PROJECT_ID || sessionState?.access === 'owner'),
  );
  const onRename = async (name: string) => {
    const renamed = await session.rename(name);
    if (!renamed) {
      toastManager.danger($t('frameleaf_studio_rename_failed'));
    }
    return renamed;
  };

  /* Basic and Advanced (`Studio.jsx:2626-2633`): remembered per project in this browser. */
  const modeKey = $derived(`frameleaf.studio.mode.${project.id}`);
  let mode = $state<StudioWorkspaceMode>('basic');
  $effect(() => {
    const key = modeKey;
    untrack(() => {
      try {
        mode = globalThis.localStorage?.getItem(key) === 'advanced' ? 'advanced' : 'basic';
      } catch {
        mode = 'basic';
      }
    });
  });
  $effect(() => {
    const value = mode;
    const key = untrack(() => modeKey);
    try {
      globalThis.localStorage?.setItem(key, value);
    } catch {
      // A private window without storage keeps the choice for this page only.
    }
  });

  /* Review count (`Studio.jsx:2640-2643`): open comments, re-read when the head moves. */
  $effect(() => {
    const saved = storedRevision;
    if (saved === null) {
      unresolvedComments = 0;
      return;
    }
    void session
      .comments(0, 100)
      .then((page) => {
        unresolvedComments = page.items.filter((comment) => !comment.resolvedAt).length;
      })
      .catch(() => {
        unresolvedComments = 0;
      });
  });

  /* Video export (FL-106 server; `Studio.jsx` ExportDialog): the owner's saved, writable project. */
  let videoExportOpen = $state(false);
  let exporting = $state(false);
  const canExportVideo = $derived(canExportBundle && writable);
  const onExportVideo = async (choice: StudioExportChoice) => {
    if (sessionState?.hasDraft && writable) {
      await session.flush().catch(() => {});
    }
    const revision = storedRevision;
    if (revision === null) {
      return;
    }
    exporting = true;
    try {
      await createStudioExport({
        id: project.id,
        studioExportCreateDto: {
          ...choice,
          expectedRevision: revision,
          requestKey: crypto.randomUUID(),
        },
      });
      videoExportOpen = false;
      queuedJobs += 1;
      toastManager.primary($t('frameleaf_studio_export_queued', { values: { name: project.name } }));
    } catch (error) {
      // A 409 studio_export_unsupported names why no qualified render worker can take it (FL-42).
      const refusal = isHttpError(error) ? studioRenderRefusalFromError(error.data) : null;
      if (refusal) {
        toastManager.danger($t(studioRenderRefusalKey(refusal)));
      } else {
        handleError(error, $t('frameleaf_studio_export_failed'));
      }
    } finally {
      exporting = false;
    }
  };

  const onReload = () => {
    history.clear();
    void session.reload();
  };
  const onReacquire = () => void session.reacquire();
  const onTakeOver = () => void session.takeOver();
  const onSaveCopy = async () => {
    const id = await session.saveAsCopy($t('frameleaf_studio_copy_name', { values: { name: project.name } }));
    if (!id) {
      return;
    }
    // Same route, new project: the URL follows without re-running the load or remounting.
    replaceState(Route.studio({ projectId: id, assetIds: handoffAssetIds }), {});
    toastManager.primary($t('frameleaf_studio_copy_saved'));
  };

  onMount(() => {
    online = globalThis.navigator?.onLine;
    void session.open();
    void loadStudioWorkspace().then((view) => {
      workspace = view;
    });

    const goOnline = () => {
      online = true;
      session.setOnline(true);
    };
    const goOffline = () => {
      online = false;
      session.setOnline(false);
    };
    addEventListener('online', goOnline);
    addEventListener('offline', goOffline);

    return () => {
      removeEventListener('online', goOnline);
      removeEventListener('offline', goOffline);
    };
  });

  // `onMount`, not `$effect`: `eventManager.on` reads and replaces the manager's listener list, so a
  // tracking effect would depend on its own subscription and re-run until Svelte stops it
  // (effect_update_depth_exceeded), leaving the page's later updates unapplied.
  onMount(() => {
    void probeStudioHost().then((next) => {
      capabilities = next.capabilities;
      renderEvidence = next.renderEvidence;
    });

    // Losing the session or relocking must clear private editor state immediately, not on
    // the next navigation: the host disposes the engine when it hears this, and the project
    // session gives the lease back and stops listening for responses.
    const lost = () => {
      accessLost = true;
      dirty = false;
      // Nothing may be exported for a session that no longer has the project.
      exportDialogOpen = false;
      settleExportChoice(null);
      void previewClient.dispose();
      preview = idleStudioPreviewView();
      history.clear();
      releaseCommandEngine();
      void session.dispose();
    };
    const unsubscribe = eventManager.on({
      AuthLogout: lost,
      SessionDelete: lost,
      SessionLocked: lost,
    });

    return () => unsubscribe();
  });

  onDestroy(() => {
    settleExportChoice(null);
    releaseCommandEngine();
    void previewClient.dispose();
    void session.dispose();
  });

  beforeNavigate((navigation) => {
    if (accessLost || forbidden) {
      return;
    }
    if (!dirty && !sessionState?.hasDraft) {
      return;
    }
    // The engine, or the session's draft, holds work that is not persisted anywhere. Confirm
    // before it is lost.
    if (!confirm($t('frameleaf_studio_unsaved_confirm'))) {
      navigation.cancel();
    }
  });
</script>

<!--
  The Frameleaf top bar stays above the editor, as on the prototype's Studio screen, so Library,
  Studio and Activity are one click away (FL-30). Studio has no library rail. Leaving through the
  bar goes through the same unsaved-work guard as any other navigation.
-->
<header>
  <NavigationBar onUploadClick={() => openFileUploadDialog()} hasRail={false} />
</header>

<!--
  `droppedAssetCount` keeps the handoff honest: items the person selected that this session
  cannot read are reported in the chrome rather than quietly missing from the bin.
  `onOpenActivity` follows the bundle jobs this session queued (FL-91) to Activity (FL-104).
  `accessLost` also covers a project this account can no longer read, so the forbidden state is
  shown and the engine disposed.
-->
<StudioHost
  {project}
  {assets}
  {handoffAssetIds}
  {auth}
  {capabilities}
  {renderEvidence}
  {services}
  {onBack}
  {onBackToEditor}
  handoffPlayhead={data.at}
  draftHeld={studioDraftHeld(sessionState?.status, sessionState?.hasDraft === true)}
  {onOpenActivity}
  onExportBundle={canExportBundle ? onExportBundle : undefined}
  onExport={canExportVideo ? () => (videoExportOpen = true) : undefined}
  onRename={canRename ? onRename : undefined}
  bind:mode
  {workspace}
  {unresolvedComments}
  {playhead}
  {queuedJobs}
  dirty={dirty || (sessionState?.hasDraft ?? false)}
  accessLost={accessLost || forbidden}
  {preview}
  droppedAssetCount={data.unavailableAssetCount}
  {session}
  {saveStatus}
  conflict={sessionState?.conflict ?? null}
  access={sessionState?.access ?? null}
  {onReload}
  {onReacquire}
  {onTakeOver}
  {onSaveCopy}
/>

<StudioExportDialog
  bind:open={videoExportOpen}
  sequenceName={project.name}
  busy={exporting}
  {renderEvidence}
  onExport={(choice) => void onExportVideo(choice)}
/>

<!-- The host-side export dialog: the header's Export bundle and the editor's own export both ask here. -->
<StudioBundleExportDialog
  bind:open={exportDialogOpen}
  projectName={project.name}
  onConfirm={(includeMedia) => void onConfirmExport(includeMedia)}
/>
