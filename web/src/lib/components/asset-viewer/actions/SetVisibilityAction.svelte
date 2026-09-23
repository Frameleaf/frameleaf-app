<script lang="ts">
  import MenuOption from '$lib/components/shared-components/context-menu/MenuOption.svelte';
  import { AssetAction } from '$lib/constants';
  import { eventManager } from '$lib/managers/event-manager.svelte';
  import type { TimelineAsset } from '$lib/managers/timeline-manager/types';
  import { handleError } from '$lib/utils/handle-error';
  import { AssetVisibility, lockAssets, unlockAssets } from '@immich/sdk';
  import { modalManager } from '@immich/ui';
  import { mdiLockOpenVariantOutline, mdiLockOutline } from '@mdi/js';
  import { t } from 'svelte-i18n';
  import type { OnAction, PreAction } from './action';

  /**
   * Lock and Unlock for one item in the viewer (FL-34). A lock is metadata: the item keeps its albums
   * and organisation and is hidden everywhere except its owner's Locked view after the PIN. Unlock
   * returns it exactly where it was. The server needs the unlocked session for Unlock; the viewer only
   * shows a locked item in that session.
   */
  interface Props {
    asset: TimelineAsset;
    onAction: OnAction;
    preAction: PreAction;
  }

  let { asset, onAction, preAction }: Props = $props();
  const isLocked = $derived(asset.visibility === AssetVisibility.Locked);

  const toggleLock = async () => {
    const locked = isLocked;
    const isConfirmed = await modalManager.showDialog({
      title: locked ? $t('frameleaf_bulk_remove_from_locked') : $t('frameleaf_bulk_move_to_locked'),
      prompt: locked
        ? $t('frameleaf_bulk_remove_from_locked_confirm', { values: { count: 1 } })
        : $t('frameleaf_bulk_move_to_locked_confirm', { values: { count: 1 } }),
      confirmText: locked ? $t('frameleaf_bulk_remove_from_locked') : $t('frameleaf_bulk_move_to_locked'),
      confirmColor: 'primary',
      icon: locked ? mdiLockOpenVariantOutline : mdiLockOutline,
    });

    if (!isConfirmed) {
      return;
    }

    const type = locked ? AssetAction.SET_VISIBILITY_TIMELINE : AssetAction.SET_VISIBILITY_LOCKED;
    try {
      preAction({ type, asset });
      await (locked ? unlockAssets : lockAssets)({ bulkIdsDto: { ids: [asset.id] } });
      if (!locked) {
        // open timelines drop it and keep it out, as they do for any newly locked item
        eventManager.emit('AssetsMarkNsfw', [asset.id]);
      }
      onAction({ type, asset });
    } catch (error) {
      handleError(error, locked ? $t('frameleaf_lock_unlock_failed') : $t('frameleaf_lock_lock_failed'));
    }
  };
</script>

<MenuOption
  onClick={() => toggleLock()}
  text={isLocked ? $t('frameleaf_bulk_remove_from_locked') : $t('frameleaf_bulk_move_to_locked')}
  icon={isLocked ? mdiLockOpenVariantOutline : mdiLockOutline}
/>
