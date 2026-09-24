<script lang="ts">
  /**
   * The video Versions menu (FL-39), ported from the Versions popover in
   * `design/frameleaf/template/src/Editor.jsx`.
   *
   * Choosing Original or a saved version loads its recipe into the open draft; the editor's Save
   * version then publishes it as a new version rendered from the original. Every retained version
   * lists its render status, and ready masters (saved or exported) can be downloaded. Export master
   * queues a separate render of the current version's master; the playback proxy is never offered.
   */
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { websocketEvents } from '$lib/stores/websocket';
  import {
    VideoEditExportProfile,
    VideoEditVersionPurpose,
    VideoEditVersionStatus,
    exportVideoEditVersion,
    getBaseUrl,
    getVideoEditVersions,
    type AssetResponseDto,
    type VideoEditVersionResponseDto,
  } from '@immich/sdk';
  import { ConfirmModal, Icon, modalManager, toastManager } from '@immich/ui';
  import { mdiDownload, mdiExport, mdiHistory, mdiImageOutline, mdiRestore } from '@mdi/js';
  import { onMount, tick } from 'svelte';
  import { t } from 'svelte-i18n';

  interface Props {
    asset: AssetResponseDto;
    /** The draft recipe, as the JSON of the edits Save version would send. */
    draftKey: string;
    /** The draft differs from what the editor opened with; loading a version asks first. */
    hasUnsavedChanges: boolean;
    /** Loads a recipe into the open draft. */
    onApply: (edits: VideoEditVersionResponseDto['edits']) => void;
  }

  let { asset, draftKey, hasUnsavedChanges, onApply }: Props = $props();

  let open = $state(false);
  let versions = $state<VideoEditVersionResponseDto[]>([]);
  let loading = $state(true);
  let busy = $state(false);
  let error = $state(false);
  let trigger = $state<HTMLButtonElement>();
  let menu = $state<HTMLDivElement>();
  let request = 0;
  let disposed = false;

  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) {
      return value.map((item) => canonical(item));
    }
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value)
          .filter(([, entry]) => entry !== undefined)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, entry]) => [key, canonical(entry)]),
      );
    }
    return value;
  };
  const recipeKey = (edits: unknown) => JSON.stringify(canonical(edits));
  const draftRecipe = $derived.by(() => {
    try {
      return recipeKey(JSON.parse(draftKey));
    } catch {
      return '';
    }
  });

  const current = $derived(versions.find((version) => version.isCurrent));
  // Before any retained version exists, an edit made without history is still not the original.
  const originalIsCurrent = $derived(current ? current.edits.length === 0 : !asset.isEdited);
  const menuId = $derived(`video-versions-${asset.id}`);
  // Saved versions a person can go back to; an empty recipe is the Original entry.
  const saved = $derived(
    versions.filter((version) => version.purpose !== VideoEditVersionPurpose.Export && version.edits.length > 0),
  );
  const downloads = $derived(
    versions.filter(
      (version) =>
        version.status === VideoEditVersionStatus.Ready &&
        (version.purpose === VideoEditVersionPurpose.Export || version.edits.length > 0),
    ),
  );
  const pending = $derived(versions.some((version) => version.status === VideoEditVersionStatus.Pending));
  const canExport = $derived(
    !loading &&
      !busy &&
      !error &&
      !hasUnsavedChanges &&
      !pending &&
      !!current &&
      current.status === VideoEditVersionStatus.Ready &&
      current.edits.length > 0,
  );

  async function refresh() {
    const generation = ++request;
    const id = asset.id;
    loading = true;
    try {
      const result = await getVideoEditVersions({ id });
      if (disposed || generation !== request || id !== asset.id) {
        return;
      }
      versions = result;
      error = false;
    } catch {
      if (!disposed && generation === request) {
        error = true;
      }
    } finally {
      if (!disposed && generation === request) {
        loading = false;
      }
    }
  }

  onMount(() => {
    void refresh();
    const unsubscribeReady = websocketEvents.on('AssetEditReadyV2', (event) => {
      if (event.asset.id === asset.id) {
        void refresh();
      }
    });
    const unsubscribeFailed = websocketEvents.on('VideoEditVersionFailedV1', (event) => {
      if (event.assetId === asset.id) {
        void refresh();
      }
    });
    return () => {
      disposed = true;
      request++;
      unsubscribeReady();
      unsubscribeFailed();
    };
  });

  const items = () => [
    ...(menu?.querySelectorAll<HTMLElement>('[role^="menuitem"]:not([aria-disabled="true"])') ?? []),
  ];

  async function toggle() {
    open = !open;
    if (open) {
      void refresh();
      await tick();
      (items().find((item) => item.getAttribute('aria-checked') === 'true') ?? items()[0])?.focus();
    }
  }

  function close(restoreFocus: boolean) {
    open = false;
    if (restoreFocus) {
      trigger?.focus();
    }
  }

  function onMenuKeyDown(event: KeyboardEvent) {
    const options = items();
    const index = options.indexOf(document.activeElement as HTMLElement);
    const target = new Map([
      ['ArrowDown', index + 1],
      ['ArrowUp', index - 1],
      ['Home', 0],
      ['End', options.length - 1],
    ]).get(event.key);
    if (target !== undefined) {
      event.preventDefault();
      options[(target + options.length) % options.length]?.focus();
    } else if (event.key === 'Escape' || event.key === 'Tab') {
      event.preventDefault();
      event.stopPropagation();
      close(true);
    }
  }

  function onWindowPointerDown(event: PointerEvent) {
    if (open && !menu?.contains(event.target as Node) && !trigger?.contains(event.target as Node)) {
      close(false);
    }
  }

  async function choose(edits: VideoEditVersionResponseDto['edits']) {
    if (recipeKey(edits) === draftRecipe) {
      close(true);
      return;
    }
    close(true);
    const confirmed =
      !hasUnsavedChanges ||
      (await modalManager.show(ConfirmModal, {
        title: $t('editor_discard_edits_title'),
        prompt: $t('editor_discard_edits_prompt'),
        confirmText: $t('editor_discard_edits_confirm'),
      }));
    if (confirmed) {
      onApply(edits);
    }
  }

  async function exportMaster() {
    if (!canExport) {
      return;
    }
    busy = true;
    close(true);
    try {
      await exportVideoEditVersion({ id: asset.id, videoEditExportDto: { profile: VideoEditExportProfile.Master } });
      toastManager.primary($t('editor_video_export_queued'));
      await refresh();
    } catch {
      toastManager.danger($t('editor_video_export_error'));
    } finally {
      busy = false;
    }
  }

  function downloadUrl(versionId: string) {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(authManager.params)) {
      if (value !== undefined && value !== null) {
        search.set(key, value);
      }
    }
    return `${getBaseUrl()}/assets/${encodeURIComponent(asset.id)}/edit-versions/${encodeURIComponent(versionId)}/download?${search.toString()}`;
  }

  const date = (version: VideoEditVersionResponseDto) => new Date(version.createdAt).toLocaleString();

  const note = (version: VideoEditVersionResponseDto) => {
    if (version.isCurrent) {
      return $t('editor_video_version_current');
    }
    switch (version.status) {
      case VideoEditVersionStatus.Pending: {
        return $t('editor_video_version_pending');
      }
      case VideoEditVersionStatus.Failed: {
        return $t('editor_video_version_failed');
      }
      default: {
        return date(version);
      }
    }
  };
</script>

<svelte:window onpointerdown={onWindowPointerDown} />

{#if draftRecipe !== '[]'}
  <button type="button" class="ed-tool labelled" title={$t('editor_video_revert_original')} onclick={() => choose([])}>
    <Icon icon={mdiRestore} size="20" />
    <span>{$t('frameleaf_editor_revert')}</span>
  </button>
{/if}
<div class="ed-menu">
  <button
    bind:this={trigger}
    type="button"
    class="ed-tool labelled"
    aria-haspopup="menu"
    aria-expanded={open}
    aria-controls={menuId}
    title={$t('frameleaf_editor_tool_versions')}
    onclick={toggle}
  >
    <Icon icon={mdiHistory} size="20" />
    <span>{$t('frameleaf_editor_tool_versions')}</span>
  </button>
  <div bind:this={menu} class="ed-menu-popover" hidden={!open}>
    <h3 id="{menuId}-title">{$t('editor_video_versions')}</h3>
    {#if error}
      <p role="alert">{$t('editor_video_versions_error')}</p>
    {:else if !loading && saved.length === 0}
      <p>{$t('frameleaf_editor_no_versions')}</p>
    {/if}
    {#if pending}
      <p role="status">{$t('editor_video_version_pending_hint')}</p>
    {/if}
    <div id={menuId} role="menu" tabindex="-1" aria-labelledby="{menuId}-title" onkeydown={onMenuKeyDown}>
      <div role="group" aria-label={$t('editor_video_versions')}>
        <button type="button" role="menuitemradio" aria-checked={draftRecipe === '[]'} onclick={() => choose([])}>
          <Icon icon={mdiImageOutline} size="18" />
          {$t('frameleaf_editor_version_original')}
          {#if originalIsCurrent}
            <small>{$t('editor_video_version_current')}</small>
          {/if}
        </button>
        {#each saved as version (version.id)}
          <button
            type="button"
            role="menuitemradio"
            aria-checked={recipeKey(version.edits) === draftRecipe}
            title={date(version)}
            onclick={() => choose(version.edits)}
          >
            <Icon icon={mdiHistory} size="18" />
            {$t('editor_video_saved_version')}
            <small>{note(version)}</small>
          </button>
        {/each}
      </div>
      <div role="separator"></div>
      <button
        type="button"
        role="menuitem"
        aria-disabled={!canExport}
        title={hasUnsavedChanges ? $t('editor_video_export_save_first') : undefined}
        onclick={exportMaster}
      >
        <Icon icon={mdiExport} size="18" />
        {$t('editor_video_export_master')}
      </button>
      {#each downloads as version (version.id)}
        <a role="menuitem" href={downloadUrl(version.id)} download onclick={() => close(true)}>
          <Icon icon={mdiDownload} size="18" />
          {$t('frameleaf_editor_download_master')}
          <small>{date(version)}</small>
        </a>
      {/each}
    </div>
  </div>
</div>
