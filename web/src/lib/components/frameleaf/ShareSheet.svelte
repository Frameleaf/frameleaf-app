<script lang="ts">
  import AssetCollage from './AssetCollage.svelte';
  import Dialog from './Dialog.svelte';
  import SharedLinkForm from './SharedLinkForm.svelte';
  import { canSendCopies, sendCopiesWithFeedback, sendCopyPermitted } from '$lib/frameleaf/send-copy';
  import {
    canCopyImageToClipboard,
    copyAssetImageToClipboard,
    downloadArchive,
    downloadAssetFile,
    ignoreCancelledDownload,
  } from '$lib/utils/asset-utils';
  import { handleError } from '$lib/utils/handle-error';
  import { SharedLinkType } from '@immich/sdk';
  import { Icon, toastManager } from '@immich/ui';
  import { mdiContentCopy, mdiDownloadOutline } from '@mdi/js';
  import { t } from 'svelte-i18n';

  /**
   * The share sheet for a set of items, from the prototype's `ShareSheet` (`SharedLinks.jsx`).
   *
   * Production offers the public-link path only. The prototype's "Share with people in this
   * library" tiles mark individual items as shared with a person, and no server contract exists for
   * that yet: the only per-person sharing the server has is partner sharing, which exposes a whole
   * library, so it must never sit behind a per-item share button (FL-83 audit).
   *
   * FL-35 / FL-54: "Send a copy…" sits beside Cancel as in the prototype (SharedLinks.jsx:477-482)
   * where the browser can share files. It hands copies of the originals to the native share sheet and
   * creates no link, so it stays separate from Frameleaf sharing.
   *
   * FL-83 AL-31: the strip above shows the items as a collage with "N items · X photos, Y videos"
   * (SharedLinks.jsx:510-517), and the shortcuts below offer "Copy image" for exactly one photo and
   * "Download" (SharedLinks.jsx:598-612), through the web client's clipboard and download helpers.
   */
  type ShareItem = { id: string; isVideo: boolean; originalFileName?: string; size?: number };
  let {
    open = $bindable(false),
    assetIds,
    assets,
    onClosed,
  }: {
    open?: boolean;
    assetIds: string[];
    /** The same items with their kind, for the count line and the shortcuts. */
    assets?: ShareItem[];
    /** Called once the sheet and the link form it opened have both closed. */
    onClosed?: () => void;
  } = $props();

  let linkFormOpen = $state(false);

  let wasActive = false;
  $effect(() => {
    const active = open || linkFormOpen;
    if (active) {
      wasActive = true;
    } else if (wasActive) {
      wasActive = false;
      onClosed?.();
    }
  });

  const subject = $derived($t('frameleaf_sharing.individual_items', { values: { count: assetIds.length } }));
  const linkTarget = $derived({ type: SharedLinkType.Individual, assetIds, name: subject });

  const videos = $derived(assets?.filter((asset) => asset.isVideo).length ?? 0);
  const photos = $derived(assets ? assets.length - videos : 0);
  const countLine = $derived.by(() => {
    const items = $t('frameleaf_sharing.individual_items', { values: { count: assetIds.length } });
    if (assetIds.length < 2 || !assets) {
      return items;
    }
    const kinds = [$t('frameleaf_sharing.share_photos', { values: { count: photos } })];
    if (videos) {
      kinds.push($t('frameleaf_sharing.share_videos', { values: { count: videos } }));
    }
    return `${items} · ${kinds.join(', ')}`;
  });
  const single = $derived(assets?.length === 1 && assetIds.length === 1 ? assets[0] : undefined);
  const canCopyImage = $derived(!!single && !single.isVideo && canCopyImageToClipboard());

  const copyImage = async () => {
    if (!single) {
      return;
    }
    try {
      await copyAssetImageToClipboard(single.id);
      toastManager.primary($t('frameleaf_sharing.image_copied'));
      open = false;
    } catch (error) {
      handleError(error, $t('frameleaf_sharing.copy_image_failed'));
    }
  };

  const download = () => {
    open = false;
    if (single?.originalFileName) {
      downloadAssetFile({ id: single.id, filename: single.originalFileName, edited: true, size: single.size });
      return;
    }
    void downloadArchive('frameleaf', { assetIds }).catch(ignoreCancelledDownload);
  };

  const sendCopy = () => {
    open = false;
    void sendCopiesWithFeedback(assetIds);
  };

  const openLinkForm = () => {
    open = false;
    linkFormOpen = true;
  };
</script>

<Dialog title={$t('frameleaf_sharing.share_subject', { values: { subject } })} closeLabel={$t('close')} bind:open>
  <div class="ss-strip">
    <AssetCollage ids={assetIds} class="ss-collage" />
    <span>{countLine}</span>
  </div>
  <p class="ss-link-copy">{$t('frameleaf_sharing.link_option_description')}</p>
  <div class="ss-shortcuts">
    <button type="button" disabled={!canCopyImage} onclick={() => void copyImage()}>
      <Icon icon={mdiContentCopy} size="18" aria-hidden={true} />
      {$t('frameleaf_sharing.copy_image')}
    </button>
    <button type="button" onclick={download}>
      <Icon icon={mdiDownloadOutline} size="18" aria-hidden={true} />
      {$t('download')}
    </button>
  </div>
  <div class="ss-actions">
    {#if canSendCopies() && sendCopyPermitted()}
      <button type="button" onclick={sendCopy}>{$t('frameleaf_send_copy')}</button>
    {/if}
    <button type="button" onclick={() => (open = false)}>{$t('cancel')}</button>
    <button type="button" class="primary" onclick={openLinkForm}>{$t('frameleaf_sharing.create_public_link')}</button>
  </div>
</Dialog>

<SharedLinkForm bind:open={linkFormOpen} target={linkTarget} />

<style>
  .ss-strip {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    color: var(--fl-muted);
    font-size: 0.875rem;
  }
  .ss-strip :global(.ss-collage) {
    width: 96px;
    flex: none;
    border-radius: var(--fl-radius);
  }
  .ss-shortcuts {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    margin-top: 0.75rem;
  }
  .ss-shortcuts button {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    min-height: 36px;
    background: var(--fl-raised);
    color: var(--fl-text);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius);
    padding: 0 0.75rem;
  }
  .ss-shortcuts button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .ss-link-copy {
    color: var(--fl-muted);
  }
  .ss-actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
    margin-top: 1rem;
  }
  .ss-actions button {
    background: var(--fl-raised);
    color: var(--fl-text);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius);
    padding: 0 0.75rem;
  }
  .ss-actions button.primary {
    background: var(--fl-accent);
    color: var(--fl-accent-text);
    border-color: var(--fl-accent);
  }
</style>
