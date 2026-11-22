<script lang="ts">
  /**
   * FL-967: "Add back of print". Recent photos to choose from, an upload, and "Choose from library", which shows
   * more of the library in the same grid (there is no separate library picker to open).
   */
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import { setPrintBack } from '$lib/services/print-back.service.svelte';
  import { getAssetMediaUrl } from '$lib/utils';
  import { openFileUploadDialog } from '$lib/utils/file-uploader';
  import { getServerErrorMessage } from '$lib/utils/handle-error';
  import {
    AssetMediaSize,
    AssetOrder,
    AssetTypeEnum,
    AssetVisibility,
    searchAssets,
    type AssetResponseDto,
  } from '@frameleaf/sdk';
  import { Icon } from '@frameleaf/ui';
  import { mdiCheckCircle, mdiImageSearchOutline, mdiUpload } from '@mdi/js';
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';

  const PAGE_SIZE = 12;

  type Props = { asset: AssetResponseDto; onClose: (added?: boolean) => void };
  const { asset, onClose }: Props = $props();

  let open = $state(true);
  let scans = $state<AssetResponseDto[]>([]);
  let selected = $state<string>();
  let nextPage = $state<number | null>(1);
  let busy = $state(false);
  let errorText = $state('');
  let added = false;

  const loadMore = async () => {
    if (!nextPage) {
      return;
    }
    try {
      const { assets } = await searchAssets({
        metadataSearchDto: {
          type: AssetTypeEnum.Image,
          visibility: AssetVisibility.Timeline,
          order: AssetOrder.Desc,
          page: nextPage,
          size: PAGE_SIZE,
        },
      });
      scans = [...scans, ...assets.items.filter(({ id }) => id !== asset.id)];
      nextPage = assets.nextPage ? Number(assets.nextPage) : null;
    } catch (error) {
      errorText = getServerErrorMessage(error) ?? $t('frameleaf_print_back_pair_failed');
    }
  };

  onMount(() => void loadMore());

  const upload = async () => {
    const [id] = await openFileUploadDialog({ multiple: false });
    if (id) {
      selected = id;
      await save();
    }
  };

  const save = async () => {
    if (!selected) {
      return;
    }
    busy = true;
    errorText = '';
    try {
      await setPrintBack(asset.id, selected);
      added = true;
      open = false;
    } catch (error) {
      errorText = getServerErrorMessage(error) ?? $t('frameleaf_print_back_pair_failed');
    } finally {
      busy = false;
    }
  };
</script>

<Dialog title={$t('frameleaf_print_back_add_title')} closeLabel={$t('close')} bind:open onClosed={() => onClose(added)}>
  <p class="intro">{$t('frameleaf_print_back_add_body', { values: { name: asset.originalFileName } })}</p>
  <p class="label">{$t('frameleaf_print_back_recent')}</p>
  <div class="grid" role="radiogroup" aria-label={$t('frameleaf_print_back_recent')}>
    {#each scans as scan (scan.id)}
      <button
        type="button"
        role="radio"
        aria-checked={selected === scan.id}
        class:selected={selected === scan.id}
        onclick={() => (selected = scan.id)}
      >
        <img src={getAssetMediaUrl({ id: scan.id, size: AssetMediaSize.Thumbnail })} alt="" />
        <span>{scan.originalFileName}</span>
        {#if selected === scan.id}<i><Icon icon={mdiCheckCircle} size="20" aria-hidden="true" /></i>{/if}
      </button>
    {/each}
  </div>
  <div class="sources">
    <button type="button" class="fl-button" disabled={busy} onclick={() => void upload()}>
      <Icon icon={mdiUpload} size="16" aria-hidden="true" />{$t('frameleaf_print_back_upload')}
    </button>
    <button type="button" class="fl-button" disabled={busy || !nextPage} onclick={() => void loadMore()}>
      <Icon icon={mdiImageSearchOutline} size="16" aria-hidden="true" />{$t('frameleaf_print_back_choose_library')}
    </button>
  </div>
  {#if errorText}<p class="error" role="alert">{errorText}</p>{/if}
  <footer>
    <button type="button" class="fl-button" disabled={busy} onclick={() => (open = false)}>{$t('cancel')}</button>
    <button type="button" class="fl-button fl-button-primary" disabled={busy || !selected} onclick={() => void save()}>
      {$t('frameleaf_print_back_add_action')}
    </button>
  </footer>
</Dialog>

<style>
  .intro {
    margin: 0 0 1rem;
    color: var(--fl-muted);
    font-size: 0.875rem;
  }
  .label {
    margin: 0 0 0.5rem;
    color: var(--fl-muted);
    font-size: 0.75rem;
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(8rem, 1fr));
    gap: 0.5rem;
    max-height: 16rem;
    overflow-y: auto;
  }
  .grid button {
    position: relative;
    padding: 0.5rem;
    color: var(--fl-text);
    text-align: start;
    background: var(--fl-raised);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-card);
  }
  .grid button.selected {
    border-color: var(--fl-accent);
  }
  .grid img {
    width: 100%;
    aspect-ratio: 3 / 2;
    object-fit: cover;
    border-radius: 0.25rem;
  }
  .grid span {
    display: block;
    margin-block-start: 0.375rem;
    overflow: hidden;
    font-size: 0.75rem;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .grid i {
    position: absolute;
    top: 0.75rem;
    right: 0.75rem;
    color: var(--fl-accent);
  }
  .sources {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    margin-block-start: 1rem;
  }
  .error {
    margin: 0.5rem 0 0;
    color: var(--fl-danger);
    font-size: 0.75rem;
  }
  footer {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
    margin-block-start: 1rem;
    padding-block-start: 1rem;
    border-block-start: 1px solid var(--fl-border);
  }
</style>
