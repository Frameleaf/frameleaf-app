<script lang="ts">
  import Button from '$lib/components/frameleaf/Button.svelte';
  import InlineError from '$lib/components/frameleaf/InlineError.svelte';
  import { Route } from '$lib/route';
  import { cancelMediaImport, retryMediaImport, type MediaImportResponseDto } from '@frameleaf/sdk';
  import { t } from 'svelte-i18n';
  import { mediaImportActive, mediaImportRetryable, mediaReceiptKey, pollMediaImport } from './boards-media';

  let {
    operation = $bindable(),
    details = true,
    onOpenResult,
    onSaved,
  }: {
    operation: MediaImportResponseDto;
    details?: boolean;
    onOpenResult?: () => void;
    onSaved?: (assetIds: string[], albumId: string) => void;
  } = $props();

  let pending = $state(false);
  let refreshFailed = $state(false);
  let actionFailed = $state(false);
  const retryKeys = new Map<string, string>();
  const seen = new Set<string>();
  const active = $derived(mediaImportActive(operation.state));
  const canRetry = $derived(!operation.subscriptionId && mediaImportRetryable(operation.state));

  $effect(() => {
    if (active && !pending) {
      return pollMediaImport(
        operation.id,
        (value) => {
          operation = value;
          refreshFailed = false;
        },
        () => (refreshFailed = true),
      );
    }
  });

  $effect(() => {
    const { albumId, items } = operation;
    const saved = items.flatMap(({ assetId }) => (assetId && !seen.has(assetId) ? [assetId] : []));
    if (albumId && saved.length > 0) {
      for (const id of saved) {
        seen.add(id);
      }
      onSaved?.(saved, albumId);
    }
  });

  const change = async (retry: boolean) => {
    if (pending) {
      return;
    }
    pending = true;
    actionFailed = false;
    try {
      const { id, updatedAt } = operation;
      if (retry) {
        const key = mediaReceiptKey(retryKeys, { id, updatedAt });
        operation = await retryMediaImport({ id, mediaRetryDto: { idempotencyKey: key } });
        retryKeys.clear();
      } else {
        operation = await cancelMediaImport({ id });
      }
      refreshFailed = false;
    } catch {
      actionFailed = true;
    } finally {
      pending = false;
    }
  };
</script>

<div class="media-fields">
  <div role="status">
    <strong>{$t(`frameleaf_boards_media_state_${operation.state}`)}</strong>
    {#if operation.albumId}
      <p class="media-secondary">
        {$t('frameleaf_boards_media_download_counts', {
          values: { saved: operation.saved, skipped: operation.skipped, failed: operation.failed },
        })}
      </p>
    {/if}
  </div>
  {#if refreshFailed}
    <p role="status" class="media-secondary">{$t('frameleaf_boards_media_progress_reconnecting')}</p>
  {/if}
  {#if operation.error}<p role="alert">{operation.error}</p>{/if}
  {#if operation.limitation}<p class="media-secondary">{operation.limitation}</p>{/if}
  {#if actionFailed}<InlineError compact message={$t('frameleaf_boards_media_action_error')} />{/if}
  {#if active || canRetry || operation.albumId}
    <div class="media-actions">
      {#if active}
        <Button disabled={pending} onclick={() => void change(false)}>{$t('frameleaf_boards_media_cancel_work')}</Button
        >
      {/if}
      {#if canRetry}
        <Button disabled={pending} onclick={() => void change(true)}>
          {$t(operation.albumId ? 'frameleaf_boards_media_retry_items' : 'retry')}
        </Button>
      {/if}
      {#if operation.albumId && operation.saved > 0}
        <a href={Route.viewAlbum({ id: operation.albumId })} onclick={onOpenResult}>
          {$t('frameleaf_boards_media_open_collection')}
        </a>
      {/if}
    </div>
  {/if}
  {#if details && operation.items.length > 0}
    <ul class="media-list media-scroll" aria-label={$t('frameleaf_boards_media_attachments')}>
      {#each operation.items as item (item.id)}
        <li>
          {#if item.assetId && operation.albumId}
            <a
              href={Route.viewAlbumAsset({ albumId: operation.albumId, assetId: item.assetId })}
              onclick={onOpenResult}
            >
              {item.title || $t(`frameleaf_boards_media_kind_${item.kind}`)}
            </a>
          {:else}
            <span>{item.title || $t(`frameleaf_boards_media_kind_${item.kind}`)}</span>
          {/if}
          <small class="media-secondary">{$t(`frameleaf_boards_media_item_${item.state}`)}</small>
          {#if item.error}<p>{item.error}</p>{/if}
        </li>
      {/each}
    </ul>
  {/if}
</div>
