<script lang="ts">
  import Theme from '$lib/components/frameleaf/Theme.svelte';
  import PurchaseActivationSuccess from '$lib/components/shared-components/purchasing/PurchaseActivationSuccess.svelte';
  import PurchaseContent from '$lib/components/shared-components/purchasing/PurchaseContent.svelte';

  import { Modal, ModalBody, Theme as AppTheme, themeManager } from '@immich/ui';

  interface Props {
    onClose: () => void;
  }

  let { onClose }: Props = $props();

  let showProductActivated = $state(false);

  const appTheme = $derived(themeManager.value === AppTheme.Dark ? 'dark' : 'light');
</script>

<Modal title=" " {onClose} size="large">
  <ModalBody>
    {#if showProductActivated}
      <Theme theme={appTheme}>
        <PurchaseActivationSuccess onDone={onClose} />
      </Theme>
    {:else}
      <PurchaseContent
        onActivate={() => {
          showProductActivated = true;
        }}
        showMessage={false}
      />
    {/if}
  </ModalBody>
</Modal>
