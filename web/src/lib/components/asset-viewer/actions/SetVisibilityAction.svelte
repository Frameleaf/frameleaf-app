<script lang="ts">
  import MenuOption from '$lib/components/shared-components/context-menu/MenuOption.svelte';
  import { AssetAction } from '$lib/constants';
  import { eventManager } from '$lib/managers/event-manager.svelte';
  import type { TimelineAsset } from '$lib/managers/timeline-manager/types';
  import { handleError } from '$lib/utils/handle-error';
  import { AssetVisibility, lockAssets, unlockAssets } from '@immich/sdk';
  import { mdiShieldLockOutline, mdiShieldOutline } from '@mdi/js';
  import { t } from 'svelte-i18n';
  import type { OnAction, PreAction } from './action';

  /**
   * The viewer's Mark Sensitive and Unmark Sensitive (FL-34; the prototype's `lock` and `unlock`).
   * Marking is the lock: metadata that keeps the item's albums and organisation and hides it everywhere
   * until the session is unlocked, where the Locked view lists it. Unmarking unlocks it and returns it
   * exactly where it was; the viewer only shows a locked item in an unlocked session, which the server
   * requires for it.
   */
  interface Props {
    asset: TimelineAsset;
    onAction: OnAction;
    preAction: PreAction;
  }

  let { asset, onAction, preAction }: Props = $props();
  const isLocked = $derived(asset.visibility === AssetVisibility.Locked);

  const toggleLock = async () => {
    const target = asset;
    const locked = isLocked;
    const type = locked ? AssetAction.SET_VISIBILITY_TIMELINE : AssetAction.SET_VISIBILITY_LOCKED;
    try {
      await preAction({ type, asset: target });
      await (locked ? unlockAssets : lockAssets)({ bulkIdsDto: { ids: [target.id] } });
      if (!locked) {
        // open timelines drop it and keep it out, as they do for any newly locked item
        eventManager.emit('AssetsMarkNsfw', [target.id]);
      }
      onAction({ type, asset: target });
    } catch (error) {
      handleError(error, locked ? $t('frameleaf_lock_unlock_failed') : $t('frameleaf_lock_lock_failed'));
    }
  };
</script>

<MenuOption
  onClick={() => toggleLock()}
  text={isLocked ? $t('frameleaf_bulk_unmark_sensitive') : $t('frameleaf_bulk_mark_sensitive')}
  icon={isLocked ? mdiShieldOutline : mdiShieldLockOutline}
/>
