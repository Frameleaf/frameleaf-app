<script lang="ts">
  /**
   * FL-967: "Back of print" in Information. The owner sees the back, its text, Correct text, Copy text and Remove
   * back, or the way to add one. Someone else who can read this photo's text sees only the text. Correcting goes
   * through "Text in this photo"'s line review, so a correction is the same durable decision it is everywhere.
   */
  import DocumentTextSection from '$lib/components/frameleaf/DocumentTextSection.svelte';
  import {
    openAddPrintBack,
    printBackChanges,
    readPrintBack,
    setPrintBack,
  } from '$lib/services/print-back.service.svelte';
  import { getAssetMediaUrl } from '$lib/utils';
  import { handleError } from '$lib/utils/handle-error';
  import { AssetMediaSize, type AssetResponseDto, type PrintBackResponseDto } from '@frameleaf/sdk';
  import { Button, toastManager } from '@frameleaf/ui';
  import { mdiContentCopy, mdiLinkVariantOff, mdiPencilOutline, mdiPlus } from '@mdi/js';
  import { t } from 'svelte-i18n';

  const { asset, isOwner }: { asset: AssetResponseDto; isOwner: boolean } = $props();

  let info = $state<PrintBackResponseDto>();
  let correcting = $state(false);
  let busy = $state(false);
  let reload = $state(0);

  $effect(() => {
    const id = asset.id;
    void printBackChanges.revision;
    void reload;
    let cancelled = false;
    readPrintBack(id)
      .then((result) => {
        if (!cancelled) {
          info = result;
        }
      })
      .catch(() => {
        // an optional block: nothing about the back stays on screen once it cannot be read
        if (!cancelled) {
          info = undefined;
        }
      });
    return () => {
      cancelled = true;
      info = undefined;
      correcting = false;
    };
  });

  const backId = $derived(info?.backAssetId ?? null);
  const backAsset = $derived(backId ? ({ ...asset, id: backId } as AssetResponseDto) : null);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(info?.text ?? '');
      toastManager.primary($t('frameleaf_documents_copied'));
    } catch {
      toastManager.info($t('frameleaf_documents_copy_fallback'));
    }
  };

  const remove = async () => {
    busy = true;
    try {
      await setPrintBack(asset.id, null);
      toastManager.primary($t('frameleaf_print_back_removed'));
    } catch (error) {
      handleError(error, $t('frameleaf_print_back_remove_failed'));
    } finally {
      busy = false;
    }
  };

  const finishCorrecting = () => {
    correcting = false;
    reload++;
  };
</script>

{#if backId}
  <section aria-label={$t('frameleaf_print_back_heading')} data-testid="print-back">
    <div class="fl-info-heading-row flex-wrap">
      <h3 class="fl-info-heading">{$t('frameleaf_print_back_heading')}</h3>
      {#if info?.canEdit && info.text && !correcting}
        <Button
          size="small"
          color="secondary"
          variant="ghost"
          leadingIcon={mdiPencilOutline}
          onclick={() => (correcting = true)}
        >
          {$t('frameleaf_print_back_correct')}
        </Button>
      {/if}
    </div>
    <img
      class="back"
      src={getAssetMediaUrl({ id: backId, size: AssetMediaSize.Preview })}
      alt={$t('frameleaf_print_back_image_alt', { values: { name: asset.originalFileName } })}
    />
    {#if correcting && backAsset}
      <p class="muted">{$t('frameleaf_print_back_as_read')}</p>
      <DocumentTextSection asset={backAsset} reviewOnly />
      <p class="muted">{$t('frameleaf_print_back_correct_note')}</p>
      <div class="actions">
        <Button size="small" color="primary" onclick={finishCorrecting}>{$t('done')}</Button>
      </div>
    {:else}
      {#if info?.text}
        <p class="text" data-testid="print-back-text">{info.text}</p>
      {:else}
        <p class="muted">{$t('frameleaf_print_back_no_text')}</p>
      {/if}
      <div class="actions">
        {#if info?.text}
          <Button
            size="small"
            color="secondary"
            variant="ghost"
            leadingIcon={mdiContentCopy}
            onclick={() => void copy()}
          >
            {$t('frameleaf_documents_copy_text')}
          </Button>
        {/if}
        {#if info?.canEdit}
          <Button
            size="small"
            color="secondary"
            variant="ghost"
            leadingIcon={mdiLinkVariantOff}
            loading={busy}
            onclick={() => void remove()}
          >
            {$t('frameleaf_print_back_remove')}
          </Button>
        {/if}
      </div>
    {/if}
  </section>
{:else if info?.text}
  <section aria-label={$t('frameleaf_print_back_heading')} data-testid="print-back">
    <h3 class="fl-info-heading">{$t('frameleaf_print_back_heading')}</h3>
    <p class="text" data-testid="print-back-text">{info.text}</p>
  </section>
{:else if info && isOwner}
  <section aria-label={$t('frameleaf_print_back_heading')}>
    <Button
      size="small"
      color="secondary"
      variant="ghost"
      leadingIcon={mdiPlus}
      onclick={() => void openAddPrintBack(asset)}
    >
      {$t('frameleaf_print_back_add')}
    </Button>
    <p class="muted">{$t('frameleaf_print_back_add_hint')}</p>
  </section>
{/if}

<style>
  .back {
    width: 100%;
    max-height: 16rem;
    object-fit: contain;
    background: var(--fl-raised);
    border-radius: var(--fl-radius-card);
  }
  .text {
    margin: 0.75rem 0 0;
    padding: 0.5rem 0.75rem;
    font-size: 0.875rem;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    background: var(--fl-raised);
    border-radius: 0.375rem;
    user-select: text;
  }
  .muted {
    margin: 0.5rem 0 0;
    color: var(--fl-muted);
    font-size: 0.75rem;
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    margin-block-start: 0.5rem;
  }
</style>
