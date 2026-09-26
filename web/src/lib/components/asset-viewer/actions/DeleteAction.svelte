<script lang="ts">
  /**
   * The viewer's trash tools (MediaViewer.jsx:1138-1166): "Move to trash" for an item that is not in
   * the trash, and for a trashed item "Restore" and the danger "Delete permanently" (audit V-4).
   * Delete and Backspace move the item to the trash, or on a trashed item ask to delete it permanently
   * (MediaViewer.jsx:811-815); Shift+Delete always asks to delete permanently (765-769). A permanent
   * delete is always confirmed (`confirmAndDeletePermanently`); with the trash turned off, deleting is
   * always permanent.
   */
  import { shortcuts } from '$lib/actions/shortcut';
  import { AssetAction } from '$lib/constants';
  import { isControlTarget, isDialogOpen, isTypingTarget } from '$lib/frameleaf/viewer-keys';
  import { featureFlagsManager } from '$lib/managers/feature-flags-manager.svelte';
  import { deleteAssets as deleteAssetsUtil, type OnUndoDelete } from '$lib/utils/actions';
  import { handleError } from '$lib/utils/handle-error';
  import { toTimelineAsset } from '$lib/utils/timeline-util';
  import { AssetVisibility, type AssetResponseDto } from '@immich/sdk';
  import { IconButton } from '@immich/ui';
  import { mdiDeleteForeverOutline, mdiDeleteOutline, mdiDeleteRestore } from '@mdi/js';
  import { t } from 'svelte-i18n';
  import type { OnAction, PreAction } from './action';
  import { confirmAndDeletePermanently, restoreFromTrash } from './delete-permanently';

  interface Props {
    asset: AssetResponseDto;
    onAction: OnAction;
    preAction: PreAction;
    onUndoDelete?: OnUndoDelete;
  }

  let { asset, onAction, preAction, onUndoDelete = undefined }: Props = $props();

  const forceDefault = $derived(asset.isTrashed || !featureFlagsManager.value.trash);

  /** The viewer's delete keys do nothing in a field, or while a dialog (a confirmation, a chooser) is open. */
  const viewerOwnsKey = (event: KeyboardEvent) => !isTypingTarget(event.target) && !isDialogOpen();

  const trashOrDelete = async (forceRequest?: boolean) => {
    if (forceDefault || forceRequest) {
      await confirmAndDeletePermanently({ asset, preAction, onAction });
      return;
    }

    const timelineAsset = toTimelineAsset(asset);
    try {
      await preAction({ type: AssetAction.TRASH, asset: timelineAsset });
      await deleteAssetsUtil(
        false,
        () => onAction({ type: AssetAction.TRASH, asset: timelineAsset }),
        [timelineAsset],
        onUndoDelete,
      );
    } catch (error) {
      handleError(error, $t('errors.unable_to_delete_asset'));
    }
  };
</script>

<svelte:document
  use:shortcuts={[
    { shortcut: { key: 'Delete' }, onShortcut: (event) => viewerOwnsKey(event) && trashOrDelete() },
    // Backspace is also "go back" in fields and on controls, so a focused control keeps it too.
    {
      shortcut: { key: 'Backspace' },
      onShortcut: (event) => viewerOwnsKey(event) && !isControlTarget(event.target) && trashOrDelete(),
    },
    {
      shortcut: { key: 'Delete', shift: true },
      onShortcut: (event) => viewerOwnsKey(event) && trashOrDelete(true),
    },
  ]}
/>

{#if asset.isTrashed && asset.visibility !== AssetVisibility.Locked}
  <IconButton
    color="secondary"
    shape="round"
    variant="ghost"
    icon={mdiDeleteRestore}
    aria-label={$t('restore')}
    title={$t('restore')}
    onclick={() => restoreFromTrash({ asset, onAction })}
  />
{/if}

<span class="fl-trash-tool" class:danger={forceDefault}>
  <IconButton
    color="secondary"
    shape="round"
    variant="ghost"
    icon={forceDefault ? mdiDeleteForeverOutline : mdiDeleteOutline}
    aria-label={forceDefault ? $t('frameleaf_viewer_delete_permanently') : $t('frameleaf_viewer_move_to_trash')}
    title={forceDefault ? $t('frameleaf_viewer_delete_permanently') : $t('frameleaf_viewer_move_to_trash_title')}
    onclick={() => trashOrDelete()}
  />
</span>

<style>
  .fl-trash-tool {
    display: contents;
  }

  /* .mv-tool.danger (media-viewer.css:123-125). */
  .fl-trash-tool.danger :global(button:hover:not(:disabled)) {
    color: var(--fl-danger);
  }
</style>
