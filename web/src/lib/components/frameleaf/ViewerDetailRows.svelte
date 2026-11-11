<script lang="ts">
  import type { Translations } from 'svelte-i18n';
  /**
   * The information panel's Details list (FL-36): file name, path, image, camera, lens,
   * exposure, video and checksum, ported from `DetailsSection` in
   * `design/frameleaf/template/src/MediaViewer.jsx`.
   *
   * Which rows exist is decided by `infoDetailRows`, which also keeps the path and the
   * checksum owner-only — they are facts about someone else's storage otherwise. Camera and
   * lens stay links into the existing search, "Show in folder" is the production folder
   * action (hidden, not disabled, when it is unavailable), and the checksum offers a copy so
   * it can be pasted into a duplicate or integrity report.
   */
  import {
    FILE_DETAIL_ROWS,
    infoDetailRows,
    type InfoDetailRow,
    type InfoDetailRowId,
  } from '$lib/frameleaf/info-panel';
  import { Route } from '$lib/route';
  import { getAssetActions } from '$lib/services/asset.service';
  import { copyToClipboard, isEnabled } from '$lib/utils';
  import type { AssetResponseDto } from '@frameleaf/sdk';
  import { Icon } from '@frameleaf/ui';
  import {
    mdiAspectRatio,
    mdiCameraIris,
    mdiCameraOutline,
    mdiChevronRight,
    mdiContentCopy,
    mdiFileDocumentOutline,
    mdiFolderOpenOutline,
    mdiFolderOutline,
    mdiHarddisk,
    mdiTune,
    mdiVideoOutline,
  } from '@mdi/js';
  import { t } from 'svelte-i18n';

  type Props = {
    asset: AssetResponseDto;
    isOwner: boolean;
  };

  let { asset, isOwner }: Props = $props();

  const rows = $derived(infoDetailRows(asset, { isOwner }));
  const mainRows = $derived(rows.filter((row) => !FILE_DETAIL_ROWS.has(row.id)));
  const fileRows = $derived(rows.filter((row) => FILE_DETAIL_ROWS.has(row.id)));
  const { ShowInFolder } = $derived(getAssetActions($t, asset));

  const ICONS: Record<InfoDetailRowId, string> = {
    filename: mdiFileDocumentOutline,
    path: mdiFolderOutline,
    image: mdiAspectRatio,
    camera: mdiCameraOutline,
    lens: mdiCameraIris,
    exposure: mdiTune,
    video: mdiVideoOutline,
    checksum: mdiHarddisk,
    'bit-depth': mdiTune,
    'color-space': mdiTune,
    profile: mdiTune,
  };

  const LABEL_KEYS: Record<InfoDetailRowId, Translations> = {
    filename: 'frameleaf_info_detail_filename',
    path: 'frameleaf_info_detail_path',
    image: 'frameleaf_info_detail_image',
    camera: 'frameleaf_info_detail_camera',
    lens: 'frameleaf_info_detail_lens',
    exposure: 'frameleaf_info_detail_exposure',
    video: 'frameleaf_info_detail_video',
    checksum: 'frameleaf_info_detail_checksum',
    'bit-depth': 'frameleaf_camera_bit_depth',
    'color-space': 'frameleaf_camera_color_space',
    profile: 'frameleaf_camera_profile',
  };
</script>

{#snippet detailRow(row: InfoDetailRow)}
  <div class="flex gap-3">
    <dt class="flex w-24 shrink-0 items-start gap-2 text-xs text-gray-500 dark:text-gray-400">
      <Icon icon={ICONS[row.id]} size="16" aria-hidden />
      <span>{$t(LABEL_KEYS[row.id])}</span>
    </dt>
    <dd class="min-w-0 flex-1 wrap-break-word">
      {#if row.id === 'path'}
        <!-- Prototype: the path on one line, truncated in the middle so the file name stays; the
               whole path is its tooltip and the screen-reader text. -->
        {@const cut = row.value.lastIndexOf('/') + 1}
        <span class="fl-info-path" title={row.value}>
          <span class="sr-only">{row.value}</span>
          <span class="fl-info-path-dir" aria-hidden="true">{row.value.slice(0, cut)}</span>
          <span class="fl-info-path-file" aria-hidden="true">{row.value.slice(cut)}</span>
        </span>
        {#if isEnabled(ShowInFolder)}
          <button
            type="button"
            class="mt-1 inline-flex items-center gap-1 text-xs underline hover:text-primary"
            onclick={() => ShowInFolder.onAction(ShowInFolder)}
          >
            <Icon icon={mdiFolderOpenOutline} size="14" aria-hidden />
            {$t('frameleaf_viewer_show_in_folder')}
          </button>
        {/if}
      {:else if row.id === 'checksum'}
        <div class="flex items-start gap-2">
          <span class="min-w-0 flex-1 text-xs break-all">{row.value}</span>
          <button
            type="button"
            class="shrink-0 hover:text-primary"
            aria-label={$t('frameleaf_info_copy_checksum')}
            title={$t('frameleaf_info_copy_checksum')}
            onclick={() => copyToClipboard(row.value)}
          >
            <Icon icon={mdiContentCopy} size="16" aria-hidden />
          </button>
        </div>
      {:else if row.id === 'camera'}
        <a
          href={Route.search({
            make: asset.exifInfo?.make ?? undefined,
            model: asset.exifInfo?.model ?? undefined,
          })}
          title="{$t('search_for')} {row.value}"
          class="hover:text-primary"
        >
          {row.value}
        </a>
      {:else if row.id === 'lens'}
        <a
          href={Route.search({ lensModel: asset.exifInfo?.lensModel ?? undefined })}
          title="{$t('search_for')} {row.value}"
          class="hover:text-primary"
        >
          {row.value}
        </a>
      {:else if row.id === 'bit-depth'}
        {$t('frameleaf_camera_bits_per_sample', { values: { bits: row.value } })}
      {:else}
        {row.value}
      {/if}
    </dd>
  </div>
{/snippet}

{#if rows.length > 0}
  <section data-testid="frameleaf-info-details">
    <div class="fl-info-heading-row">
      <h3 class="fl-info-heading">{$t('frameleaf_info_details')}</h3>
    </div>

    <dl class="flex flex-col gap-3 text-sm">
      {#each mainRows as row (row.id)}
        {@render detailRow(row)}
      {/each}
    </dl>

    <!-- FL-1392 (UI review 2026-11-10, B5; MediaViewer.jsx `.mv-file-details`): where the file is
         stored, its bit depth and its checksum open on request, under the photo's own details. -->
    {#if fileRows.length > 0}
      <details class="fl-file-details" data-testid="frameleaf-info-file-details">
        <summary>
          <Icon icon={mdiChevronRight} size="16" aria-hidden />
          {$t('frameleaf_info_file_details')}
        </summary>
        <dl class="flex flex-col gap-3 text-sm">
          {#each fileRows as row (row.id)}
            {@render detailRow(row)}
          {/each}
        </dl>
      </details>
    {/if}
  </section>
{/if}

<style>
  /* review-1110.css B5 `.mv-file-details`: one quiet line that opens the storage facts. */
  .fl-file-details {
    margin-top: 12px;
  }
  .fl-file-details > summary {
    position: relative;
    display: flex;
    align-items: center;
    gap: 6px;
    min-height: 32px;
    color: var(--fl-viewer-muted);
    font-size: var(--fl-font-small);
    cursor: pointer;
    list-style: none;
  }
  .fl-file-details > summary::-webkit-details-marker {
    display: none;
  }
  /* The line is 32px tall; its click area is the 44px every control gets. */
  .fl-file-details > summary::after {
    content: '';
    position: absolute;
    inset: -6px 0;
  }
  .fl-file-details > summary:hover {
    color: var(--fl-viewer-text);
  }
  .fl-file-details > summary:focus-visible {
    border-radius: var(--fl-radius-xs);
    outline: 2px solid var(--fl-viewer-focus);
    outline-offset: 2px;
  }
  .fl-file-details[open] > summary :global(svg) {
    rotate: 90deg;
  }
  .fl-file-details > dl {
    margin-top: 4px;
  }
  .fl-info-path {
    display: flex;
    min-width: 0;
    font-size: 12px;
    white-space: nowrap;
  }
  .fl-info-path-dir {
    min-width: 1.5em;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .fl-info-path-file {
    flex: 0 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }
</style>
