<script lang="ts">
  /**
   * Repair a damaged JPEG: the damaged original beside the repaired picture, and nothing changes until
   * the reviewer approves. The server repairs the file again on approval and replaces the original only
   * when the result is the very one shown here (its checksum); the damaged file is kept.
   *
   * Opened from Library Care with the finding, or from the photo viewer with just the photo, which the
   * server checks on the spot. Shown by `modalManager` it closes through `onClose`.
   */
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import { formatBytes } from '$lib/frameleaf/library-care';
  import { getAssetMediaUrl } from '$lib/utils';
  import { getServerErrorMessage } from '$lib/utils/handle-error';
  import {
    AssetMediaSize,
    MediaHealthRepairMethod,
    previewRepair,
    repair,
    type MediaHealthRepairPreviewResponseDto,
  } from '@frameleaf/sdk';
  import { Icon } from '@frameleaf/ui';
  import { mdiImageBrokenVariant } from '@mdi/js';
  import { onMount } from 'svelte';
  import { t, type Translations } from 'svelte-i18n';

  let {
    open = $bindable(true),
    findingId,
    assetId,
    name,
    onRepaired,
    onClose,
  }: {
    open?: boolean;
    /** The damage finding, when known (Library Care); otherwise the server checks the photo now. */
    findingId?: string;
    assetId: string;
    name: string;
    onRepaired: () => void;
    onClose?: () => void;
  } = $props();

  $effect(() => {
    if (!open) {
      onClose?.();
    }
  });

  const METHOD_TEXT: Record<MediaHealthRepairMethod, Translations> = {
    [MediaHealthRepairMethod.Lossless]: 'library_care_repair_lossless',
    [MediaHealthRepairMethod.Rebuilt]: 'library_care_repair_rebuilt',
    [MediaHealthRepairMethod.Preview]: 'library_care_repair_preview',
    [MediaHealthRepairMethod.Converted]: 'library_care_repair_converted',
  };

  let result = $state<MediaHealthRepairPreviewResponseDto>();
  let message = $state<string>();
  let working = $state(true);
  let originalFailed = $state(false);

  const describe = (cause: unknown) => getServerErrorMessage(cause) ?? $t('library_care_repair_failed');

  onMount(async () => {
    try {
      result = await previewRepair({ mediaHealthRepairPreviewDto: findingId ? { findingId } : { assetId } });
    } catch (error) {
      message = describe(error);
    } finally {
      working = false;
    }
  });

  const approve = async () => {
    if (!result) {
      return;
    }
    working = true;
    try {
      await repair({ mediaHealthRepairDto: { findingId: result.findingId, checksum: result.checksum } });
      open = false;
      onRepaired();
    } catch (error) {
      message = describe(error);
    } finally {
      working = false;
    }
  };
</script>

<Dialog title={$t('library_care_repair_title', { values: { name } })} closeLabel={$t('cancel')} bind:open>
  <div class="repair">
    <div class="compare">
      <figure>
        <span class="frame">
          {#if !originalFailed}
            <img
              src={getAssetMediaUrl({ id: assetId, size: AssetMediaSize.Original, edited: false })}
              alt={$t('library_care_repair_damaged')}
              onerror={() => (originalFailed = true)}
            />
          {:else}
            <span class="none">
              <Icon icon={mdiImageBrokenVariant} size="2rem" aria-hidden={true} />
              {$t('library_care_repair_cannot_show')}
            </span>
          {/if}
        </span>
        <figcaption>{$t('library_care_repair_damaged')}</figcaption>
      </figure>
      <figure>
        <span class="frame">
          {#if result}
            <img src={result.preview} alt={$t('library_care_repair_repaired')} />
          {:else if working}
            <span class="none">{$t('library_care_repair_working')}</span>
          {:else}
            <span class="none">
              <Icon icon={mdiImageBrokenVariant} size="2rem" aria-hidden={true} />
              {$t('library_care_repair_none')}
            </span>
          {/if}
        </span>
        <figcaption>
          {$t('library_care_repair_repaired')}
          {#if result}
            · {result.width} × {result.height} · {formatBytes(result.sizeInBytes)}
          {/if}
        </figcaption>
      </figure>
    </div>

    {#if result}
      <p>{$t(METHOD_TEXT[result.method], { values: { width: result.width, height: result.height } })}</p>
      {#if !result.metadataKept}
        <p class="warn">{$t('library_care_repair_metadata_lost')}</p>
      {/if}
    {/if}
    {#if message}
      <p class="error" role="alert">{message}</p>
    {/if}
    <p class="policy">{$t('library_care_repair_policy')}</p>

    <footer>
      <Button onclick={() => (open = false)}>{$t('cancel')}</Button>
      <Button variant="primary" disabled={!result || working} onclick={approve}>
        {$t('library_care_repair_approve')}
      </Button>
    </footer>
  </div>
</Dialog>

<style>
  .repair {
    display: grid;
    gap: 0.875rem;
    margin-top: 0.75rem;
    min-width: min(40rem, 100%);
    max-width: 52rem;
    font-size: var(--fl-font-size, 0.875rem);
  }
  p {
    margin: 0;
  }
  .compare {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr));
    gap: 0.75rem;
  }
  figure {
    display: grid;
    gap: 0.375rem;
    margin: 0;
  }
  .frame {
    display: grid;
    place-items: center;
    aspect-ratio: 4 / 3;
    overflow: hidden;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-card);
    background: var(--fl-raised);
  }
  .frame img {
    width: 100%;
    height: 100%;
    object-fit: contain;
  }
  .none {
    display: grid;
    justify-items: center;
    gap: 0.5rem;
    padding: 1rem;
    color: var(--fl-muted);
    font-size: 0.8125rem;
    text-align: center;
  }
  figcaption,
  .policy {
    color: var(--fl-muted);
    font-size: 0.75rem;
  }
  .warn {
    color: var(--fl-warning);
  }
  .error {
    color: var(--fl-danger);
  }
  footer {
    display: flex;
    justify-content: flex-end;
    flex-wrap: wrap;
    gap: 0.5rem;
  }
</style>
