<script lang="ts">
  import './boards-media.css';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import InlineError from '$lib/components/frameleaf/InlineError.svelte';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { eventManager } from '$lib/managers/event-manager.svelte';
  import { onLibraryAccessChange } from '$lib/frameleaf/library-access';
  import {
    getAlbumInfo,
    getMediaCapabilities,
    isHttpError,
    type MediaCapabilitiesDto,
    type MediaSubscriptionResponseDto,
  } from '@frameleaf/sdk';
  import { onMount, tick } from 'svelte';
  import { t } from 'svelte-i18n';
  import type { MediaSheet } from './boards-media';
  import MediaConnections from './MediaConnections.svelte';
  import MediaImportForm from './MediaImportForm.svelte';
  import MediaImportHistory from './MediaImportHistory.svelte';
  import MediaSubscriptions from './MediaSubscriptions.svelte';

  let {
    sheet,
    albumId,
    returnFocus,
    onClosed,
  }: {
    sheet: MediaSheet;
    albumId?: string;
    returnFocus?: HTMLElement;
    onClosed: () => void;
  } = $props();

  let open = $state(true);
  let capabilities = $state<MediaCapabilitiesDto>();
  let loading = $state(true);
  let oldServer = $state(false);
  let failed = $state(false);
  let alternate = $state(false);
  let createdId = $state<string>();
  const controller = new AbortController();
  let body = $state<HTMLDivElement>();
  const close = () => {
    open = false;
  };

  const load = async () => {
    loading = true;
    failed = false;
    try {
      capabilities = await getMediaCapabilities({ signal: controller.signal });
    } catch (error) {
      oldServer = isHttpError(error) && error.status === 404;
      failed = !oldServer;
    } finally {
      loading = false;
      await tick();
      if (
        body?.contains(document.activeElement) ||
        document.activeElement?.closest('dialog') === body?.closest('dialog')
      ) {
        body?.querySelector<HTMLElement>('[data-initial-focus]')?.focus();
      }
    }
  };

  onMount(() => {
    void load();
    const unsubscribe = onLibraryAccessChange(
      (change) => {
        if (change !== 'expanded') {
          close();
        }
      },
      authManager.authenticated ? authManager.user.id : undefined,
    );
    return () => {
      unsubscribe();
      controller.abort();
    };
  });

  const saved = (assetIds: string[], albumId: string) => {
    eventManager.emit('AlbumAddAssets', { assetIds, albumIds: [albumId] });
  };

  const subscribed = (value: MediaSubscriptionResponseDto) => {
    createdId = value.id;
    alternate = false;
    if (value.albumId) {
      const current = authManager.captureSession();
      void getAlbumInfo({ id: value.albumId })
        .then((album) => {
          if (current()) {
            eventManager.emit('AlbumCreate', album);
          }
        })
        .catch(() => {});
    }
  };
</script>

<Dialog
  title={$t(`frameleaf_boards_media_${sheet}`)}
  closeLabel={$t('close')}
  bind:open
  size="medium"
  {onClosed}
  {returnFocus}
>
  {#if open}
    <div class="boards-media" bind:this={body}>
      {#if loading}
        <p role="status">{$t('loading')}</p>
      {:else if oldServer || capabilities?.available === false}
        <p role="status">{$t('frameleaf_boards_media_unavailable')}</p>
        {#if capabilities?.reason}<p class="media-secondary">{capabilities.reason}</p>{/if}
      {:else if failed}
        <InlineError compact message={$t('frameleaf_boards_media_capabilities_error')} onRetry={load} />
      {:else if capabilities}
        {#if sheet === 'connections'}
          <MediaConnections methods={capabilities.authentication} />
        {:else if sheet === 'download'}
          <div class="media-actions">
            <Button pressed={!alternate} onclick={() => (alternate = false)}
              >{$t('frameleaf_boards_media_new_download')}</Button
            >
            <Button pressed={alternate} onclick={() => (alternate = true)}
              >{$t('frameleaf_boards_media_download_history')}</Button
            >
          </div>
          <div hidden={alternate} class="boards-media">
            <MediaImportForm initialAlbumId={albumId} onOpenResult={close} onSaved={saved} onSubscribed={subscribed} />
          </div>
          {#if alternate}<MediaImportHistory onOpenResult={close} onSaved={saved} />{/if}
        {:else}
          <div class="media-actions">
            <Button pressed={!alternate} onclick={() => (alternate = false)}
              >{$t('frameleaf_boards_media_manage')}</Button
            >
            <Button pressed={alternate} onclick={() => (alternate = true)}
              >{$t('frameleaf_boards_media_add_subscription')}</Button
            >
          </div>
          {#if alternate}
            <MediaImportForm
              subscription
              initialAlbumId={albumId}
              onOpenResult={close}
              onSaved={saved}
              onSubscribed={subscribed}
            />
          {:else}
            <MediaSubscriptions initialId={createdId} onOpenResult={close} onSaved={saved} />
          {/if}
        {/if}
      {/if}
    </div>
  {/if}
  {#snippet actions()}
    <Button onclick={close}>{$t('close')}</Button>
  {/snippet}
</Dialog>
