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
  import { infoDetailRows, type InfoDetailRowId } from '$lib/frameleaf/info-panel';
  import { Route } from '$lib/route';
  import { getAssetActions } from '$lib/services/asset.service';
  import { copyToClipboard, isEnabled } from '$lib/utils';
  import type { AssetResponseDto } from '@immich/sdk';
  import { Icon, Text } from '@immich/ui';
  import {
    mdiAspectRatio,
    mdiCameraIris,
    mdiCameraOutline,
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
  };
</script>

{#if rows.length > 0}
  <section class="px-4 pt-4" data-testid="frameleaf-info-details">
    <div class="flex h-10 w-full items-center text-sm">
      <Text color="muted">{$t('frameleaf_info_details')}</Text>
    </div>

    <dl class="flex flex-col gap-3 text-sm">
      {#each rows as row (row.id)}
        <div class="flex gap-3">
          <dt class="flex w-24 shrink-0 items-start gap-2 text-xs text-gray-500 dark:text-gray-400">
            <Icon icon={ICONS[row.id]} size="16" aria-hidden />
            <span>{$t(LABEL_KEYS[row.id])}</span>
          </dt>
          <dd class="min-w-0 flex-1 wrap-break-word">
            {#if row.id === 'path'}
              <code class="block text-xs break-all">{row.value}</code>
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
                <code class="min-w-0 flex-1 text-xs break-all">{row.value}</code>
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
            {:else}
              {row.value}
            {/if}
          </dd>
        </div>
      {/each}
    </dl>
  </section>
{/if}
