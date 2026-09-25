<script lang="ts">
  import MenuOption from '$lib/components/shared-components/context-menu/MenuOption.svelte';

  import { AssetAction } from '$lib/constants';
  import { updateStack, type AssetResponseDto, type StackResponseDto } from '@immich/sdk';
  import { mdiImageCheckOutline } from '@mdi/js';
  import { t } from 'svelte-i18n';
  import type { OnAction } from './action';

  interface Props {
    /** The menu's wording; the viewer's More menu passes the template's label (FL-35, V-11). */
    text?: string;
    stack: StackResponseDto;
    asset: AssetResponseDto;
    onAction: OnAction;
  }

  let { stack, asset, onAction, text }: Props = $props();

  const handleSetPrimaryAsset = async () => {
    const updatedStack = await updateStack({ id: stack.id, stackUpdateDto: { primaryAssetId: asset.id } });
    if (updatedStack) {
      onAction({ type: AssetAction.SET_STACK_PRIMARY_ASSET, stack: updatedStack });
    }
  };
</script>

<MenuOption icon={mdiImageCheckOutline} onClick={handleSetPrimaryAsset} text={text ?? $t('set_stack_primary_asset')} />
