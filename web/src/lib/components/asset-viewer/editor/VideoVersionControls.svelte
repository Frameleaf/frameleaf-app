<script lang="ts">
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { eventManager } from '$lib/managers/event-manager.svelte';
  import { websocketEvents } from '$lib/stores/websocket';
  import {
    Profile,
    exportVideoEditVersion,
    getBaseUrl,
    getVideoEditVersions,
    removeAssetEdits,
    restoreVideoEditVersion,
    type AssetResponseDto,
    type VideoEditVersionResponseDto,
  } from '@immich/sdk';
  import { Button, ConfirmModal, modalManager, toastManager } from '@immich/ui';
  import { onMount } from 'svelte';
  import { SvelteURLSearchParams } from 'svelte/reactivity';
  import { t } from 'svelte-i18n';

  interface Props {
    asset: AssetResponseDto;
    hasUnsavedChanges: boolean;
    disabled?: boolean;
    onRestore: () => void;
  }
  let { asset, hasUnsavedChanges, disabled = false, onRestore }: Props = $props();
  let versions = $state<VideoEditVersionResponseDto[]>([]);
  let loading = $state(true);
  let busy = $state(false);
  let error = $state(false);
  let request = 0;
  let disposed = false;
  const current = $derived(versions.find((version) => version.isCurrent));
  const pending = $derived(versions.some((version) => version.isRequested && version.status === 'pending'));
  const exporting = $derived(versions.some((version) => version.purpose === 'export' && version.status === 'pending'));
  const unavailable = $derived(disabled || loading || busy || error);

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

  async function restore(version?: VideoEditVersionResponseDto) {
    if (unavailable) {
      return;
    }
    busy = true;
    try {
      if (
        hasUnsavedChanges &&
        !(await modalManager.show(ConfirmModal, {
          title: $t('editor_discard_edits_title'),
          prompt: $t('editor_discard_edits_prompt'),
          confirmText: $t('editor_discard_edits_confirm'),
        }))
      ) {
        return;
      }
      if (version) {
        await restoreVideoEditVersion({ id: asset.id, versionId: version.id });
      } else {
        await removeAssetEdits({ id: asset.id });
      }
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
    if (unavailable || hasUnsavedChanges || pending || exporting || !current) {
      return;
    }
    busy = true;
    try {
      await exportVideoEditVersion({ id: asset.id, videoEditExportDto: { profile: Profile.Master } });
      toastManager.primary($t('editor_video_export_queued'));
      await refresh();
    } catch {
      toastManager.danger($t('editor_video_export_error'));
    } finally {
      busy = false;
    }
  }

  function downloadUrl(versionId: string) {
    const query = new SvelteURLSearchParams();
    for (const [key, value] of Object.entries(authManager.params)) {
      if (value !== undefined && value !== null) {
        query.set(key, value);
      }
    }
    return `${getBaseUrl()}/assets/${encodeURIComponent(asset.id)}/edit-versions/${encodeURIComponent(versionId)}/download?${query}`;
  }
</script>

<section class="mx-4 mt-3 space-y-3 border-b border-immich-dark-gray pb-3" aria-label={$t('editor_video_versions')}>
  <div class="flex flex-wrap gap-2">
    <Button
      variant="outline"
      size="small"
      onclick={() => restore()}
      disabled={unavailable || (!asset.isEdited && !hasUnsavedChanges && !current)}
    >
      {$t('editor_video_revert_original')}
    </Button>
    <Button
      variant="outline"
      size="small"
      onclick={exportMaster}
      disabled={unavailable || hasUnsavedChanges || pending || exporting || !current}
    >
      {$t('editor_video_export_master')}
    </Button>
  </div>
  {#if hasUnsavedChanges}
    <p class="text-sm text-immich-dark-fg">{$t('editor_video_export_save_first')}</p>
  {:else if !current && !loading && !error}
    <p class="text-sm text-immich-dark-fg">{$t('editor_video_export_version_first')}</p>
  {/if}
  {#if pending || exporting}
    <p class="text-sm" role="status">{$t('editor_video_version_pending_hint')}</p>
  {/if}
  {#if error}
    <p class="text-sm text-red-400" role="alert">{$t('editor_video_versions_error')}</p>
  {/if}
  <details>
    <summary class="cursor-pointer rounded-sm py-2 text-sm focus-visible:outline-2 focus-visible:outline-immich-primary"
      >{$t('editor_video_versions')}</summary
    >
    <Button variant="ghost" size="small" onclick={refresh} disabled={loading || busy}>{$t('refresh')}</Button>
    {#if !loading && !error && versions.length === 0}
      <p class="py-2 text-sm">{$t('editor_video_versions_empty')}</p>
    {/if}
    <ul class="max-h-64 space-y-2 overflow-y-auto py-2">
      {#each versions as version (version.id)}
        <li class="rounded-sm border border-immich-dark-gray p-3 text-sm">
          <p class="font-medium">
            {version.purpose === 'export'
              ? $t('editor_video_export_master')
              : version.edits.length === 0
                ? $t('original')
                : $t('editor_video_saved_version')}
            {#if version.isCurrent}<span class="ms-2 text-immich-primary">{$t('editor_video_version_current')}</span
              >{/if}
          </p>
          <p>
            <time datetime={version.createdAt}>{new Date(version.createdAt).toLocaleString()}</time> · {$t(
              `editor_video_version_${version.status}`,
            )}
          </p>
          {#if version.status === 'ready'}
            <div class="mt-2 flex flex-wrap items-center gap-3">
              {#if !version.isCurrent && version.purpose !== 'export'}
                <Button variant="ghost" size="small" onclick={() => restore(version)} disabled={unavailable}
                  >{$t('restore')}</Button
                >
              {/if}
              {#if version.purpose === 'export' || version.edits.length > 0}
                <a
                  class="rounded-sm text-immich-primary underline focus-visible:outline-2 focus-visible:outline-immich-primary"
                  href={downloadUrl(version.id)}
                  download
                >
                  {$t('download')}
                </a>
              {/if}
            </div>
          {/if}
        </li>
      {/each}
    </ul>
  </details>
</section>
