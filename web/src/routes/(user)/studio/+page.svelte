<script lang="ts">
  /**
   * The Studio route (FL-88, `STU-201`).
   *
   * Svelte owns everything outside the editor: it authenticates, resolves the handoff
   * selection, probes what the deployment can run, builds the typed command bridge and
   * guards navigation while a draft is unsaved. The React editor, when it is part of the
   * build, is mounted by `StudioHost` into a single element and is handed data and
   * callbacks only — never the SDK, never a token, never the API base URL.
   */
  import { beforeNavigate, goto } from '$app/navigation';
  import { locale, t } from 'svelte-i18n';
  import { toastManager } from '@immich/ui';
  import StudioHost from '$lib/components/frameleaf/StudioHost.svelte';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { eventManager } from '$lib/managers/event-manager.svelte';
  import { Route } from '$lib/route';
  import { toStudioAssets } from '$lib/frameleaf/studio/assets';
  import { createStudioBridge } from '$lib/frameleaf/studio/bridge';
  import { probeStudioCapabilities } from '$lib/frameleaf/studio/capabilities';
  import {
    emptyStudioCapabilities,
    type StudioAuthContext,
    type StudioCapabilities,
    type StudioHostServices,
    type StudioProjectHandle,
  } from '$lib/frameleaf/studio/host-contract';
  import { getProfileImageUrl } from '$lib/utils';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  let capabilities = $state<StudioCapabilities>(emptyStudioCapabilities());
  let online = $state(true);
  let dirty = $state(false);
  let accessLost = $state(false);

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
   * The project this session is editing. Durable project storage, the revision chain and
   * the write lease are FL-89/FL-90's contract; until they land the host opens an in-memory
   * draft at revision 0 with an empty graph. Nothing writes it anywhere, and no command that
   * would change it is implemented, so there is no storage here pretending to be a saved
   * project.
   */
  const project = $derived<StudioProjectHandle>({
    id: data.projectId ?? 'draft',
    name: $t('frameleaf_studio_untitled_project'),
    revision: 0,
    graph: null,
    hasLease: true,
  });

  const bridge = createStudioBridge({
    context: () => ({
      revision: project.revision,
      hasLease: project.hasLease,
      hasAccess: !accessLost && authManager.authenticated,
      online,
      capabilities,
    }),
    // No handlers yet: every editing command is a typed extension point owned by a later
    // story, and the bridge rejects each one as `not-implemented` rather than no-op.
  });

  const services: StudioHostServices = {
    submitCommands: (envelopes) => bridge.submit(envelopes),
    reloadProject: () => Promise.resolve(project),
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

  $effect(() => {
    online = globalThis.navigator?.onLine !== false;
    void probeStudioCapabilities().then((next) => {
      capabilities = next;
    });

    // Losing the session or relocking must clear private editor state immediately, not on
    // the next navigation: the host disposes the engine when it hears this.
    const lost = () => {
      accessLost = true;
      dirty = false;
    };
    const unsubscribe = eventManager.on({
      AuthLogout: lost,
      SessionDelete: lost,
      SessionLocked: lost,
    });

    return () => unsubscribe();
  });

  beforeNavigate((navigation) => {
    if (!dirty || accessLost) {
      return;
    }
    // The engine holds work that is not persisted anywhere. Confirm before it is lost.
    if (!globalThis.confirm($t('frameleaf_studio_unsaved_confirm'))) {
      navigation.cancel();
    }
  });
</script>

<!--
  `droppedAssetCount` keeps the handoff honest: items the person selected that this session
  cannot read are reported in the chrome rather than quietly missing from the bin.
  `onOpenActivity` is deliberately not supplied — the Activity route is FL-104's, so the
  host renders no link to it.
-->
<StudioHost
  {project}
  {assets}
  {handoffAssetIds}
  {auth}
  {capabilities}
  {services}
  {onBack}
  {dirty}
  {accessLost}
  droppedAssetCount={data.unavailableAssetCount}
/>
