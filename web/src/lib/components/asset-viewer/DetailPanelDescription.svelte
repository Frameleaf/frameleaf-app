<script lang="ts">
  /**
   * The information panel's inline description editor (FL-36).
   *
   * Ported from `DescriptionEditor` in `design/frameleaf/template/src/MediaViewer.jsx`: a
   * heading with the provenance badge, and a growing text area that commits on blur or
   * Enter and reverts to the stored description on Escape. The write is the production `updateAsset` change
   * endpoint — the same one the enrichment card's Accept uses — so a description never
   * exists only in the panel.
   *
   * AI provenance (September 24, MediaViewer.jsx:2574-2592, media-viewer.css:1212-1224): an AI-written
   * description carries the indigo sparkle and an "AI" badge whose title names the model and, when
   * the server reported one, its confidence; an owner-written one says "Yours".
   *
   * A failed save keeps the typed text on screen and says what can be done about it:
   * retry replays the same value, a stale asset is reloaded rather than overwritten, and a
   * rejected or forbidden value gets no false promise of a retry.
   */
  import { shortcuts } from '$lib/actions/shortcut';
  import ViewerInlineEditError from '$lib/components/frameleaf/ViewerInlineEditError.svelte';
  import type { DescriptionReview } from '$lib/frameleaf/info-panel';
  import { classifyInlineEditError, inlineEditRecovery, type InlineEditFailure } from '$lib/frameleaf/inline-edit';
  import { handlePromiseError } from '$lib/utils';
  import { handleError } from '$lib/utils/handle-error';
  import { getAssetInfo, updateAsset, type AssetResponseDto } from '@immich/sdk';
  import { Icon, Text, Textarea, toastManager } from '@immich/ui';
  import { mdiPencilOutline, mdiShimmer } from '@mdi/js';
  import { t } from 'svelte-i18n';
  import { fromAction } from 'svelte/attachments';

  interface Props {
    asset: AssetResponseDto;
    isOwner: boolean;
    /** How the stored description got there, from the enrichment card's review. */
    review?: DescriptionReview | null;
    onAssetRefresh?: (asset: AssetResponseDto) => void;
  }

  let { asset, isOwner, review = null, onAssetRefresh }: Props = $props();

  const source = $derived(review?.source ?? 'none');
  /** "Written by AI · model · 87% confident", as the template's badge title. */
  const confidence = $derived(review?.confidencePercent ?? null);
  /** The model and its confidence; the visible "AI" already says who wrote it. */
  const aiModelDetail = $derived(
    [
      review?.modelName,
      confidence === null ? null : $t('frameleaf_info_confidence', { values: { percent: confidence } }),
    ]
      .filter(Boolean)
      .join(' · '),
  );
  const aiDetail = $derived([$t('frameleaf_info_written_by_ai'), aiModelDetail].filter(Boolean).join(' · '));

  let description = $derived(asset.exifInfo?.description ?? '');
  let failure = $state<InlineEditFailure | null>(null);
  let isSaving = $state(false);

  const save = async (value: string) => {
    isSaving = true;
    try {
      await updateAsset({ id: asset.id, updateAssetDto: { description: value } });
      failure = null;
      toastManager.primary($t('asset_description_updated'));
    } catch (error) {
      failure = classifyInlineEditError(error);
      handleError(error, $t('cannot_update_the_description'));
    } finally {
      isSaving = false;
    }
  };

  const handleFocusOut = async () => {
    const currentDescription = asset.exifInfo?.description ?? '';
    if (description === currentDescription) {
      return;
    }
    await save(description);
  };

  /** A stale asset is reloaded, never rewritten: the panel takes whatever is stored now. */
  const reload = async () => {
    try {
      const updated = await getAssetInfo({ id: asset.id });
      failure = null;
      onAssetRefresh?.(updated);
    } catch (error) {
      handleError(error, $t('frameleaf_info_error_reload_failed'));
    }
  };
</script>

{#if isOwner}
  <section class="mt-10 px-4" data-testid="frameleaf-info-description">
    <div class="flex h-8 w-full items-center justify-between text-sm">
      <Text color="muted">{$t('frameleaf_info_description')}</Text>
      {#if source === 'generated'}
        <span class="fl-provenance fl-provenance-ai" title={aiDetail} data-testid="frameleaf-description-provenance">
          <Icon icon={mdiShimmer} size="12" aria-hidden />
          {$t('frameleaf_info_description_ai')}
          {#if aiModelDetail}<span class="sr-only">· {aiModelDetail}</span>{/if}
        </span>
      {:else if source === 'manual'}
        <span
          class="fl-provenance"
          title={$t('frameleaf_info_written_by_you')}
          data-testid="frameleaf-description-provenance"
        >
          <Icon icon={mdiPencilOutline} size="11" aria-hidden />
          {$t('frameleaf_info_description_yours')}
        </span>
      {/if}
    </div>
    <Textarea
      bind:value={description}
      class="max-h-40 resize-none border-b border-gray-500 bg-transparent ps-0 ring-0 outline-none focus:border-b-2 focus:border-immich-primary focus:ring-0 dark:bg-transparent dark:focus:border-immich-dark-primary"
      rows={1}
      grow
      shape="rectangle"
      onfocusout={handleFocusOut}
      placeholder={$t('add_a_description')}
      data-testid="autogrow-textarea"
      {@attach fromAction(shortcuts, () => [
        { shortcut: { key: 'Enter', ctrl: true }, onShortcut: (e) => e.currentTarget.blur() },
        { shortcut: { key: 'Enter' }, onShortcut: (e) => e.currentTarget.blur() },
        {
          shortcut: { key: 'Escape' },
          onShortcut: (e) => {
            description = asset.exifInfo?.description ?? '';
            e.currentTarget.blur();
          },
        },
      ])}
    />
    {#if failure}
      <ViewerInlineEditError
        {failure}
        busy={isSaving}
        onRetry={inlineEditRecovery(failure) === 'retry' ? () => handlePromiseError(save(description)) : undefined}
        onReload={inlineEditRecovery(failure) === 'reload' ? () => handlePromiseError(reload()) : undefined}
      />
    {/if}
  </section>
{:else}
  <section class="mt-6 px-4">
    <p class="w-full text-base wrap-break-word whitespace-pre-line text-black dark:text-white">
      {description || $t('frameleaf_viewer_no_description')}
    </p>
  </section>
{/if}

<style>
  /* The description badge (media-viewer.css:1212-1224): AI on the reserved indigo, "Yours" plain. */
  .fl-provenance {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 1px 7px;
    border: 1px solid #ffffff24;
    border-radius: 999px;
    font-size: 11px;
    font-weight: 550;
    line-height: 16px;
  }

  .fl-provenance-ai {
    border-color: transparent;
    background: var(--fl-ai, #5e5ce6);
    color: var(--fl-ai-text, #fff);
    font-weight: 600;
  }
</style>
