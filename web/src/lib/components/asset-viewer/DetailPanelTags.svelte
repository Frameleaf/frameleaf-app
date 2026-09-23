<script lang="ts">
  /**
   * The information panel's inline tag edits (FL-36), ported from `TagsSection` in
   * `design/frameleaf/template/src/MediaViewer.jsx`.
   *
   * Adding goes through the production Tag action (the tag picker, which creates a tag when
   * the typed value is new); removing goes through `untagAssets` via `removeTag`. The panel
   * never keeps its own tag list: after either change it refetches the asset so what is shown
   * is what the server stored.
   *
   * A failed removal is reported in place with a retry, because an untag that never reached a
   * verdict is safe to repeat; a stale asset is reloaded instead.
   */
  import HeaderActionButton from '$lib/components/HeaderActionButton.svelte';
  import OnEvents from '$lib/components/OnEvents.svelte';
  import ViewerInlineEditError from '$lib/components/frameleaf/ViewerInlineEditError.svelte';
  import { classifyInlineEditError, inlineEditRecovery, type InlineEditFailure } from '$lib/frameleaf/inline-edit';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { Route } from '$lib/route';
  import { getAssetActions } from '$lib/services/asset.service';
  import { handlePromiseError } from '$lib/utils';
  import { removeTag } from '$lib/utils/asset-utils';
  import { handleError } from '$lib/utils/handle-error';
  import { getAssetInfo, type AssetResponseDto } from '@immich/sdk';
  import { Badge, Link, Text } from '@immich/ui';
  import { t } from 'svelte-i18n';

  interface Props {
    asset: AssetResponseDto;
    isOwner: boolean;
    /** Lets the viewer take the updated asset, so the change is not stranded in the panel. */
    onAssetRefresh?: (asset: AssetResponseDto) => void;
  }

  let { asset = $bindable(), isOwner, onAssetRefresh }: Props = $props();

  let tags = $derived(asset.tags || []);
  let failure = $state<InlineEditFailure | null>(null);
  let isSaving = $state(false);
  /** The tag whose removal failed, so a retry repeats that removal and not another one. */
  let pending = $state<string | null>(null);

  const handleRemove = async (tagId: string) => {
    isSaving = true;
    pending = tagId;
    try {
      const ids = await removeTag({ tagIds: [tagId], assetIds: [asset.id], showNotification: false });
      if (ids) {
        asset = await getAssetInfo({ id: asset.id });
        onAssetRefresh?.(asset);
      }
      failure = null;
      pending = null;
    } catch (error) {
      failure = classifyInlineEditError(error);
      handleError(error, $t('frameleaf_info_error_remove_tag'));
    } finally {
      isSaving = false;
    }
  };

  const reload = async () => {
    try {
      asset = await getAssetInfo({ id: asset.id });
      failure = null;
      pending = null;
      onAssetRefresh?.(asset);
    } catch (error) {
      handleError(error, $t('frameleaf_info_error_reload_failed'));
    }
  };

  const onAssetsTag = async (ids: string[]) => {
    if (!ids.includes(asset.id)) {
      return;
    }

    asset = await getAssetInfo({ id: asset.id });
    onAssetRefresh?.(asset);
  };

  const { Tag } = $derived(getAssetActions($t, asset));
</script>

<OnEvents {onAssetsTag} />

{#if isOwner && !authManager.isSharedLink}
  <section class="mt-4 px-4">
    <div class="flex h-10 w-full items-center justify-between text-sm">
      <Text color="muted">{$t('tags')}</Text>
    </div>
    <section class="flex flex-wrap gap-1 pt-2" data-testid="detail-panel-tags">
      {#each tags as tag (tag.id)}
        <Badge
          onClose={() => handlePromiseError(handleRemove(tag.id))}
          size="small"
          shape="round"
          translations={{ close: $t('remove_tag') }}
        >
          <Link href={Route.tags({ path: tag.value })} underline={false} class="px-2 font-light">
            {tag.value}
          </Link>
        </Badge>
      {/each}
      <HeaderActionButton action={Tag} />
    </section>
    {#if failure}
      <ViewerInlineEditError
        {failure}
        busy={isSaving}
        onRetry={inlineEditRecovery(failure) === 'retry' && pending
          ? () => handlePromiseError(handleRemove(pending as string))
          : undefined}
        onReload={inlineEditRecovery(failure) === 'reload' ? () => handlePromiseError(reload()) : undefined}
      />
    {/if}
  </section>
{/if}
