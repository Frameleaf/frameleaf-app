<script lang="ts">
  /**
   * The information panel's inline description editor (FL-36).
   *
   * Ported from `DescriptionEditor` in `design/frameleaf/template/src/MediaViewer.jsx`: a
   * heading with the provenance badge, and a growing text area that commits on blur or
   * Ctrl+Enter and reverts on Escape. The write is the production `updateAsset` change
   * endpoint — the same one the enrichment card's Accept uses — so a description never
   * exists only in the panel.
   *
   * A failed save keeps the typed text on screen and says what can be done about it:
   * retry replays the same value, a stale asset is reloaded rather than overwritten, and a
   * rejected or forbidden value gets no false promise of a retry.
   */
  import { shortcut } from '$lib/actions/shortcut';
  import ViewerInlineEditError from '$lib/components/frameleaf/ViewerInlineEditError.svelte';
  import { classifyInlineEditError, inlineEditRecovery, type InlineEditFailure } from '$lib/frameleaf/inline-edit';
  import { handlePromiseError } from '$lib/utils';
  import { handleError } from '$lib/utils/handle-error';
  import { getAssetInfo, updateAsset, type AssetResponseDto } from '@immich/sdk';
  import { Badge, Text, Textarea, toastManager } from '@immich/ui';
  import { t } from 'svelte-i18n';
  import { fromAction } from 'svelte/attachments';

  interface Props {
    asset: AssetResponseDto;
    isOwner: boolean;
    /** How the stored description got there, from the enrichment card's review. */
    source?: 'manual' | 'generated' | 'none';
    onAssetRefresh?: (asset: AssetResponseDto) => void;
  }

  let { asset, isOwner, source = 'none', onAssetRefresh }: Props = $props();

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
      {#if source !== 'none'}
        <Badge size="small" shape="round" color="secondary">
          {source === 'generated'
            ? $t('frameleaf_info_description_generated')
            : $t('frameleaf_info_description_manual')}
        </Badge>
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
      {@attach fromAction(shortcut, () => ({
        shortcut: { key: 'Enter', ctrl: true },
        onShortcut: (e) => e.currentTarget.blur(),
      }))}
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
{:else if description}
  <section class="mt-6 px-4">
    <p class="w-full text-base wrap-break-word whitespace-pre-line text-black dark:text-white">{description}</p>
  </section>
{/if}
