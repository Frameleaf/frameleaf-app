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
  import StudioHost from '$lib/components/frameleaf/StudioHost.svelte';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { eventManager } from '$lib/managers/event-manager.svelte';
  import { Route } from '$lib/route';
  import { toStudioAssets } from '$lib/frameleaf/studio/assets';
  import { createStudioBridge } from '$lib/frameleaf/studio/bridge';
  import type { StudioCommandPayloads } from '$lib/frameleaf/studio/commands';
  import { probeStudioCapabilities } from '$lib/frameleaf/studio/capabilities';
  import { pinnedFreecutRevision } from '$lib/frameleaf/studio/engine-loader';
  import {
    emptyStudioCapabilities,
    type StudioAuthContext,
    type StudioCapabilities,
    type StudioHostServices,
    type StudioProjectHandle,
  } from '$lib/frameleaf/studio/host-contract';
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
  import { getProfileImageUrl } from '$lib/utils';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  let capabilities = $state<StudioCapabilities>(emptyStudioCapabilities());
  let online = $state(true);
  let dirty = $state(false);
  let accessLost = $state(false);
  let preview = $state<StudioPreviewView>(idleStudioPreviewView());
  let sessionState = $state<StudioProjectSessionState | null>(null);

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
      ? globalThis.crypto.randomUUID()
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
      if (previewProjectId !== null && previewProjectId !== projectId) {
        void resetPreview();
      }
      previewProjectId = projectId;
      if (revision !== null) {
        previewClient.revisionAdvanced(revision);
      }
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
    // The only implemented handlers in this slice are the preview pair. Every editing command
    // stays a typed extension point owned by a later story and is rejected as
    // `not-implemented` rather than silently no-oped.
    handlers: {
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
    },
  });

  const services: StudioHostServices = {
    submitCommands: (envelopes) => bridge.submit(envelopes),
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
          // The Activity page is FL-104's route and does not exist yet. No command in this
          // slice can enqueue a job, so nothing can reach this branch today; it refuses
          // rather than sending the person somewhere that is not Activity.
          toastManager.danger($t('frameleaf_studio_activity_unavailable'));
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
  };

  const onBack = () => void goto(Route.photos());

  const onReload = () => void session.reload();
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
    online = globalThis.navigator?.onLine !== false;
    void session.open();

    const goOnline = () => {
      online = true;
      session.setOnline(true);
    };
    const goOffline = () => {
      online = false;
      session.setOnline(false);
    };
    globalThis.addEventListener('online', goOnline);
    globalThis.addEventListener('offline', goOffline);

    return () => {
      globalThis.removeEventListener('online', goOnline);
      globalThis.removeEventListener('offline', goOffline);
    };
  });

  $effect(() => {
    void probeStudioCapabilities().then((next) => {
      capabilities = next;
    });

    // Losing the session or relocking must clear private editor state immediately, not on
    // the next navigation: the host disposes the engine when it hears this, and the project
    // session gives the lease back and stops listening for responses.
    const lost = () => {
      accessLost = true;
      dirty = false;
      void previewClient.dispose();
      preview = idleStudioPreviewView();
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
    if (!globalThis.confirm($t('frameleaf_studio_unsaved_confirm'))) {
      navigation.cancel();
    }
  });
</script>

<!--
  `droppedAssetCount` keeps the handoff honest: items the person selected that this session
  cannot read are reported in the chrome rather than quietly missing from the bin.
  `onOpenActivity` is deliberately not supplied — the Activity route is FL-104's, so the
  host renders no link to it. `accessLost` also covers a project this account can no longer
  read, so the forbidden state is shown and the engine disposed.
-->
<StudioHost
  {project}
  {assets}
  {handoffAssetIds}
  {auth}
  {capabilities}
  {services}
  {onBack}
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
