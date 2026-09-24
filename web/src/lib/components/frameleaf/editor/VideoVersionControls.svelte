<script lang="ts">
  /**
   * Retained video versions (FL-39), in the quick editor's Versions panel.
   *
   * Follows the prototype's Versions surface (`design/frameleaf/template/src/Editor.jsx`: an
   * Original entry plus one entry per saved version, Revert to original) and the photo editor's
   * version cards. Every save, revert and export is its own server-side version rendered from the
   * original; making one current queues a new render of its recipe, and the current video stays
   * available until that render is published. Downloads are the version's edited master, never
   * the playback proxy.
   */
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { eventManager } from '$lib/managers/event-manager.svelte';
  import { websocketEvents } from '$lib/stores/websocket';
  import {
    exportVideoEditVersion,
    getBaseUrl,
    getVideoEditVersions,
    removeAssetEdits,
    restoreVideoEditVersion,
    type AssetResponseDto,
    type VideoEditExportDto,
    type VideoEditVersionResponseDto,
  } from '@immich/sdk';
  import { ConfirmModal, Icon, modalManager, toastManager } from '@immich/ui';
  import { mdiCheck, mdiDownload, mdiExport, mdiImageOutline, mdiRefresh, mdiRestore } from '@mdi/js';
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';

  interface Props {
    asset: AssetResponseDto;
    /** The open video draft differs from what was loaded; version actions confirm before discarding it. */
    hasUnsavedChanges: boolean;
    /** Called after a restore or revert was queued, so the editor can close and the viewer refresh. */
    onRestore: () => void;
  }

  let { asset, hasUnsavedChanges, onRestore }: Props = $props();

  let versions = $state<VideoEditVersionResponseDto[]>([]);
  let loading = $state(true);
  let busy = $state(false);
  let error = $state(false);
  let request = 0;
  let disposed = false;

  const current = $derived(versions.find((version) => version.isCurrent));
  // Before any retained version exists, an edit made without history still counts as not-original.
  const originalIsCurrent = $derived(current ? current.edits.length === 0 : !asset.isEdited);
  const pending = $derived(versions.some((version) => version.isRequested && version.status === 'pending'));
  const exporting = $derived(versions.some((version) => version.purpose === 'export' && version.status === 'pending'));
  const unavailable = $derived(loading || busy || error);
  const canExport = $derived(
    !unavailable && !hasUnsavedChanges && !pending && !exporting && !!current && current.edits.length > 0,
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
    const unsubscribe = websocketEvents.on('AssetEditReadyV2', (event) => {
      if (event.asset.id === asset.id) {
        void refresh();
      }
    });
    return () => {
      disposed = true;
      request++;
      unsubscribe();
    };
  });

  const confirmDiscard = async () =>
    !hasUnsavedChanges ||
    (await modalManager.show(ConfirmModal, {
      title: $t('editor_discard_edits_title'),
      prompt: $t('editor_discard_edits_prompt'),
      confirmText: $t('editor_discard_edits_confirm'),
    }));

  async function restore(version?: VideoEditVersionResponseDto) {
    if (unavailable) {
      return;
    }
    busy = true;
    try {
      if (!(await confirmDiscard())) {
        return;
      }
      await (version
        ? restoreVideoEditVersion({ id: asset.id, versionId: version.id })
        : removeAssetEdits({ id: asset.id }));
      eventManager.emit('AssetEditsApplied', asset.id);
      toastManager.primary($t('editor_video_restore_queued'));
      onRestore();
    } catch {
      toastManager.danger($t('editor_edits_applied_error'));
    } finally {
      busy = false;
    }
  }

  async function exportMaster() {
    if (!canExport) {
      return;
    }
    busy = true;
    try {
      const videoEditExportDto = { profile: 'master' } as VideoEditExportDto;
      await exportVideoEditVersion({ id: asset.id, videoEditExportDto });
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

  const versionLabel = (version: VideoEditVersionResponseDto) => {
    if (version.purpose === 'export') {
      return $t('editor_video_export_master');
    }
    return version.edits.length === 0 ? $t('frameleaf_editor_version_original') : $t('editor_video_saved_version');
  };

  const statusLabel = (version: VideoEditVersionResponseDto) => {
    if (version.isCurrent) {
      return $t('editor_video_version_current');
    }
    switch (version.status) {
      case 'pending': {
        return $t('editor_video_version_pending');
      }
      case 'failed': {
        return $t('editor_video_version_failed');
      }
      default: {
        return $t('editor_video_version_ready');
      }
    }
  };
</script>

<div class="ed-panel-body">
  <div class="ed-panel-head">
    <h2>{$t('editor_video_versions')}</h2>
    <button
      type="button"
      class="ed-icon"
      aria-label={$t('refresh')}
      title={$t('refresh')}
      disabled={loading || busy}
      onclick={refresh}
    >
      <Icon icon={mdiRefresh} size="18" />
    </button>
  </div>
  <p>{$t('frameleaf_editor_versions_help')}</p>

  <div class="ed-row">
    <button type="button" class="ed-chip accent" disabled={!canExport} onclick={exportMaster}>
      <Icon icon={mdiExport} size="16" />
      {$t('editor_video_export_master')}
    </button>
  </div>
  {#if hasUnsavedChanges}
    <p>{$t('editor_video_export_save_first')}</p>
  {:else if !loading && !error && (!current || current.edits.length === 0)}
    <p>{$t('editor_video_export_version_first')}</p>
  {/if}
  {#if pending || exporting}
    <p role="status">{$t('editor_video_version_pending_hint')}</p>
  {/if}
  {#if error}
    <p class="ed-empty" role="alert">{$t('editor_video_versions_error')}</p>
  {/if}

  <div class={['ed-version', originalIsCurrent && 'current']}>
    <strong><Icon icon={mdiImageOutline} size="16" /> {$t('frameleaf_editor_version_original')}</strong>
    {#if originalIsCurrent}
      <span class="ed-status">{$t('editor_video_version_current')}</span>
    {/if}
    <small>{$t('frameleaf_editor_version_original_help')}</small>
    {#if !originalIsCurrent || hasUnsavedChanges}
      <div class="ed-row">
        <button type="button" class="ed-chip" disabled={unavailable} onclick={() => restore()}>
          <Icon icon={mdiRestore} size="16" />
          {$t('editor_video_revert_original')}
        </button>
      </div>
    {/if}
  </div>

  {#each versions as version (version.id)}
    <div class={['ed-version', version.isCurrent && 'current']}>
      <strong>{versionLabel(version)}</strong>
      <span class={['ed-status', version.status === 'pending' && 'busy', version.status === 'failed' && 'failed']}>
        {statusLabel(version)}
      </span>
      <small><time datetime={version.createdAt}>{new Date(version.createdAt).toLocaleString()}</time></small>
      {#if version.status === 'ready'}
        <div class="ed-row">
          {#if !version.isCurrent && version.purpose !== 'export'}
            <button type="button" class="ed-chip" disabled={unavailable} onclick={() => restore(version)}>
              <Icon icon={mdiCheck} size="16" />
              {$t('frameleaf_editor_make_current')}
            </button>
          {/if}
          {#if version.purpose === 'export' || version.edits.length > 0}
            <a class="ed-chip" href={downloadUrl(version.id)} download>
              <Icon icon={mdiDownload} size="16" />
              {$t('frameleaf_editor_download_master')}
            </a>
          {/if}
        </div>
      {/if}
    </div>
  {/each}
  {#if !loading && !error && versions.length === 0}
    <p class="ed-empty">{$t('editor_video_versions_empty')}</p>
  {/if}
</div>
