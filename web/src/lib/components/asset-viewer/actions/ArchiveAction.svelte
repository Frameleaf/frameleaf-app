<script lang="ts">
  import { shortcut } from '$lib/actions/shortcut';
  import type { OnAction, PreAction } from '$lib/components/asset-viewer/actions/action';
  import MenuOption from '$lib/components/shared-components/context-menu/MenuOption.svelte';
  import { AssetAction } from '$lib/constants';
  import { toggleArchive } from '$lib/utils/asset-utils';
  import { handleError } from '$lib/utils/handle-error';
  import { toTimelineAsset } from '$lib/utils/timeline-util';
  import type { AssetResponseDto } from '@immich/sdk';
  import { mdiArchiveArrowDownOutline, mdiArchiveArrowUpOutline } from '@mdi/js';
  import { t } from 'svelte-i18n';

  interface Props {
    asset: AssetResponseDto;
    onAction: OnAction;
    preAction: PreAction;
  }

  let { asset, onAction, preAction }: Props = $props();

  const onArchive = async () => {
    const target = asset;
    if (!target.isArchived) {
      try {
        await preAction({ type: AssetAction.ARCHIVE, asset: toTimelineAsset(target) });
      } catch (error) {
        handleError(error, $t('errors.unable_to_add_remove_archive', { values: { archived: target.isArchived } }));
        return;
      }
    }
    const updatedAsset = await toggleArchive(target);
    if (updatedAsset) {
      onAction({
        type: updatedAsset.isArchived ? AssetAction.ARCHIVE : AssetAction.UNARCHIVE,
        asset: toTimelineAsset(updatedAsset),
      });
    }
  };
</script>

<svelte:document use:shortcut={{ shortcut: { key: 'a', shift: true }, onShortcut: onArchive }} />

<MenuOption
  icon={asset.isArchived ? mdiArchiveArrowUpOutline : mdiArchiveArrowDownOutline}
  text={asset.isArchived ? $t('unarchive') : $t('to_archive')}
  onClick={onArchive}
/>
