<script lang="ts">
  import MenuOption from '$lib/components/shared-components/context-menu/MenuOption.svelte';
  import { AssetAction } from '$lib/constants';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { handleError } from '$lib/utils/handle-error';
  import { openFileUploadDialog } from '$lib/utils/file-uploader';
  import { createStack, type AssetResponseDto, type StackResponseDto } from '@frameleaf/sdk';
  import { mdiUploadMultiple } from '@mdi/js';
  import { t } from 'svelte-i18n';
  import type { OnAction } from './action';

  interface Props {
    /** The menu's wording; the viewer's More menu passes the template's label (FL-35, V-11). */
    text?: string;
    asset: AssetResponseDto;
    stack: StackResponseDto | null;
    onAction: OnAction;
  }

  let { asset, stack, onAction, text }: Props = $props();

  const handleAddUploadToStack = async () => {
    const primaryAssetId = stack?.primaryAssetId ?? asset.id;
    const handleAction = onAction;
    const isCurrentSession = authManager.captureSession();
    try {
      const newAssetIds = await openFileUploadDialog({ multiple: true });
      if (newAssetIds.length === 0 || !isCurrentSession()) {
        return;
      }
      // The first ID remains primary and includes all members of its existing stack.
      const newStack = await createStack({ stackCreateDto: { assetIds: [primaryAssetId, ...newAssetIds] } });
      if (isCurrentSession()) {
        handleAction({ type: AssetAction.STACK, stack: newStack });
      }
    } catch (error) {
      if (isCurrentSession()) {
        handleError(error, $t('errors.failed_to_stack_assets'));
      }
    }
  };
</script>

<MenuOption icon={mdiUploadMultiple} onClick={handleAddUploadToStack} text={text ?? $t('add_upload_to_stack')} />
