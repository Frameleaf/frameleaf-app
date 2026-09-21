<script lang="ts">
  import MenuOption from '$lib/components/shared-components/context-menu/MenuOption.svelte';
  import { AssetAction } from '$lib/constants';
  import type { TimelineAsset } from '$lib/managers/timeline-manager/types';
  import { handleError } from '$lib/utils/handle-error';
  import { AssetVisibility, updateAssets } from '@immich/sdk';
  import { modalManager } from '@immich/ui';
  import { mdiLockOpenVariantOutline, mdiLockOutline } from '@mdi/js';
  import { t } from 'svelte-i18n';
  import type { OnAction, PreAction } from './action';

  interface Props {
    asset: TimelineAsset;
    onAction: OnAction;
    preAction: PreAction;
  }

  let { asset, onAction, preAction }: Props = $props();
  const isLocked = $derived(asset.visibility === AssetVisibility.Locked);

  const toggleLockedVisibility = async () => {
    const target = asset;
    const wasLocked = isLocked;
    const isConfirmed = await modalManager.showDialog({
      title: wasLocked ? $t('remove_from_locked_folder') : $t('move_to_locked_folder'),
      prompt: wasLocked ? $t('remove_from_locked_folder_confirmation') : $t('move_to_locked_folder_confirmation'),
      confirmText: $t('move'),
      confirmColor: wasLocked ? 'danger' : 'primary',
      icon: wasLocked ? mdiLockOpenVariantOutline : mdiLockOutline,
    });

    if (!isConfirmed) {
      return;
    }

    try {
      await preAction({
        type: wasLocked ? AssetAction.SET_VISIBILITY_TIMELINE : AssetAction.SET_VISIBILITY_LOCKED,
        asset: target,
      });

      await updateAssets({
        assetBulkUpdateDto: {
          ids: [target.id],
          visibility: wasLocked ? AssetVisibility.Timeline : AssetVisibility.Locked,
        },
      });

      onAction({
        type: wasLocked ? AssetAction.SET_VISIBILITY_TIMELINE : AssetAction.SET_VISIBILITY_LOCKED,
        asset: target,
      });
    } catch (error) {
      handleError(error, $t('errors.unable_to_save_settings'));
    }
  };
</script>

<MenuOption
  onClick={() => toggleLockedVisibility()}
  text={isLocked ? $t('move_off_locked_folder') : $t('move_to_locked_folder')}
  icon={isLocked ? mdiLockOpenVariantOutline : mdiLockOutline}
/>
