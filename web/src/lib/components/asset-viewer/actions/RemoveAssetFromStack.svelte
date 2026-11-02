<script lang="ts">
  import MenuOption from '$lib/components/shared-components/context-menu/MenuOption.svelte';

  import { AssetAction } from '$lib/constants';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { handleError } from '$lib/utils/handle-error';
  import { removeAssetFromStack, type AssetResponseDto, type StackResponseDto } from '@frameleaf/sdk';
  import { mdiImageMinusOutline } from '@mdi/js';
  import { t } from 'svelte-i18n';
  import type { OnAction } from './action';

  interface Props {
    /** The menu's wording; the viewer's More menu passes the template's label (FL-35, V-11). */
    text?: string;
    asset: AssetResponseDto;
    stack: StackResponseDto;
    onAction: OnAction;
  }

  let { asset, stack, onAction, text }: Props = $props();

  const handleRemoveFromStack = async () => {
    const target = asset;
    const handleAction = onAction;
    const isCurrentSession = authManager.captureSession();
    const updatedStack = {
      ...stack,
      assets: stack.assets.filter((member) => member.id !== target.id),
    };
    try {
      await removeAssetFromStack({ id: updatedStack.id, assetId: target.id });
    } catch (error) {
      if (isCurrentSession()) {
        handleError(error, $t('errors.failed_to_unstack_assets'));
      }
      return;
    }
    if (isCurrentSession()) {
      handleAction({ type: AssetAction.REMOVE_ASSET_FROM_STACK, stack: updatedStack, asset: target });
    }
  };
</script>

<MenuOption icon={mdiImageMinusOutline} onClick={handleRemoveFromStack} text={text ?? $t('viewer_remove_from_stack')} />
