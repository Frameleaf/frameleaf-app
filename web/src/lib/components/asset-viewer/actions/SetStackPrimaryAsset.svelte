<script lang="ts">
  import MenuOption from '$lib/components/shared-components/context-menu/MenuOption.svelte';

  import { AssetAction } from '$lib/constants';
  import { handleError } from '$lib/utils/handle-error';
  import { updateStack, type AssetResponseDto, type StackResponseDto } from '@frameleaf/sdk';
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
    try {
      const updatedStack = await updateStack({ id: stack.id, stackUpdateDto: { primaryAssetId: asset.id } });
      if (updatedStack) {
        onAction({ type: AssetAction.SET_STACK_PRIMARY_ASSET, stack: updatedStack });
      }
    } catch (error) {
      handleError(error, $t('errors.something_went_wrong'));
    }
  };
</script>

<MenuOption icon={mdiImageCheckOutline} onClick={handleSetPrimaryAsset} text={text ?? $t('set_stack_primary_asset')} />
