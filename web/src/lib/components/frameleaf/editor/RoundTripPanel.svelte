<script lang="ts">
  /**
   * Edit in another app (FL-64): the round trip of an original through a RAW developer or any
   * other application, inside the Versions panel.
   *
   * Export original records the original's SHA-256 and downloads it. Bringing the finished file
   * back names that export; the server keeps the file as a new version only when it arrived
   * intact and was developed from the original the photo still has, and it becomes the working
   * version once its preview renders. The original is never replaced.
   */
  import { downloadUrl, getAssetMediaUrl } from '$lib/utils';
  import { RETURN_ACCEPT, sha256Hex, shortChecksum } from '$lib/frameleaf/photo-tools';
  import { getServerErrorMessage, handleError } from '$lib/utils/handle-error';
  import {
    AssetMediaSize,
    createAssetDevelopExport,
    getAssetDevelopExports,
    importAssetDevelopRendition,
    type AssetDevelopRevisionResponseDto,
    type AssetResponseDto,
    type DevelopExportResponseDto,
  } from '@immich/sdk';
  import { Icon, toastManager } from '@immich/ui';
  import { mdiExport, mdiImport } from '@mdi/js';
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';

  let {
    asset,
    onImported,
  }: {
    asset: AssetResponseDto;
    onImported: (revision: AssetDevelopRevisionResponseDto) => void;
  } = $props();

  let exports = $state<DevelopExportResponseDto[]>([]);
  let loadError = $state<string | null>(null);
  let exporting = $state(false);
  let exportId = $state<string | null>(null);
  let file = $state<File | null>(null);
  let software = $state('');
  let phase = $state<'idle' | 'checking' | 'uploading'>('idle');
  let importError = $state<string | null>(null);
  let fileInput = $state<HTMLInputElement>();

  const usable = $derived(exports.filter((item) => item.isCurrentOriginal));

  onMount(async () => {
    try {
      exports = await getAssetDevelopExports({ id: asset.id });
      exportId = exports.find((item) => item.isCurrentOriginal)?.id ?? null;
    } catch (error) {
      loadError = $t('frameleaf_editor_roundtrip_load_error');
      handleError(error, loadError);
    }
  });

  const exportOriginal = async () => {
    exporting = true;
    try {
      const created = await createAssetDevelopExport({ id: asset.id });
      exports = [created, ...exports];
      exportId = created.id;
      downloadUrl(
        getAssetMediaUrl({ id: asset.id, size: AssetMediaSize.Original, edited: false }),
        asset.originalFileName,
      );
      toastManager.primary($t('frameleaf_editor_roundtrip_exported'));
    } catch (error) {
      handleError(error, $t('frameleaf_editor_roundtrip_export_error'));
    } finally {
      exporting = false;
    }
  };

  const bringBack = async (event: SubmitEvent) => {
    event.preventDefault();
    if (!file || !exportId || phase !== 'idle') {
      return;
    }
    importError = null;
    try {
      phase = 'checking';
      const renditionChecksum = await sha256Hex(file);
      phase = 'uploading';
      const revision = await importAssetDevelopRendition({
        id: asset.id,
        assetDevelopImportDto: {
          file,
          exportId,
          renditionChecksum,
          software: software.trim() || undefined,
        },
      });
      file = null;
      software = '';
      if (fileInput) {
        fileInput.value = '';
      }
      onImported(revision);
      toastManager.primary($t('frameleaf_editor_roundtrip_imported', { values: { revision: revision.revision } }));
    } catch (error) {
      importError = getServerErrorMessage(error) ?? $t('frameleaf_editor_roundtrip_import_error');
    } finally {
      phase = 'idle';
    }
  };
</script>

<h3>{$t('frameleaf_editor_roundtrip_heading')}</h3>
<p>{$t('frameleaf_editor_roundtrip_help')}</p>
<button type="button" class="ed-button" disabled={exporting} onclick={exportOriginal}>
  <Icon icon={mdiExport} size="18" />
  {$t('frameleaf_editor_roundtrip_export')}
</button>

{#if loadError}
  <p class="ed-empty">{loadError}</p>
{:else if exports.length > 0}
  <ul class="ed-preset-list" aria-label={$t('frameleaf_editor_roundtrip_exports')}>
    {#each exports as item (item.id)}
      <li class="ed-version">
        <strong>{item.fileName}</strong>
        <span class={['ed-status', !item.isCurrentOriginal && 'failed']}>
          {item.isCurrentOriginal ? $t('frameleaf_editor_roundtrip_matches') : $t('frameleaf_editor_roundtrip_changed')}
        </span>
        <small>
          {new Date(item.createdAt).toLocaleString()} · {$t('frameleaf_editor_checksum', {
            values: { checksum: shortChecksum(item.sourceChecksum) },
          })}
        </small>
      </li>
    {/each}
  </ul>
{/if}

<form class="ed-form" onsubmit={bringBack} aria-label={$t('frameleaf_editor_roundtrip_import')}>
  {#if usable.length === 0}
    <p class="ed-note">{$t('frameleaf_editor_roundtrip_export_first')}</p>
  {:else}
    {#if usable.length > 1}
      <label class="rs-field">
        <span>{$t('frameleaf_editor_roundtrip_developed_from')}</span>
        <select value={exportId ?? ''} onchange={(event) => (exportId = event.currentTarget.value || null)}>
          {#each usable as item (item.id)}
            <option value={item.id}>{new Date(item.createdAt).toLocaleString()}</option>
          {/each}
        </select>
      </label>
    {/if}
    <label class="rs-field">
      <span>{$t('frameleaf_editor_roundtrip_file')}</span>
      <input
        bind:this={fileInput}
        class="ed-text"
        type="file"
        accept={RETURN_ACCEPT}
        disabled={phase !== 'idle'}
        onchange={(event) => {
          file = event.currentTarget.files?.[0] ?? null;
          importError = null;
        }}
      />
    </label>
    <label class="rs-field">
      <span>{$t('frameleaf_editor_roundtrip_software')}</span>
      <input class="ed-text" type="text" maxlength="120" bind:value={software} disabled={phase !== 'idle'} />
    </label>
    {#if importError}
      <p class="ed-error" role="alert">{importError}</p>
    {/if}
    <button type="submit" class="ed-button" disabled={!file || !exportId || phase !== 'idle'}>
      <Icon icon={mdiImport} size="18" />
      {phase === 'checking'
        ? $t('frameleaf_editor_roundtrip_checking')
        : phase === 'uploading'
          ? $t('frameleaf_editor_roundtrip_uploading')
          : $t('frameleaf_editor_roundtrip_import')}
    </button>
  {/if}
</form>
