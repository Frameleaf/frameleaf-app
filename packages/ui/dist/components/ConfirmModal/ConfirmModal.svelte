<script lang="ts">
  import Button from '../Button/Button.svelte';
  import Modal from '../Modal/Modal.svelte';
  import ModalBody from '../Modal/ModalBody.svelte';
  import ModalFooter from '../Modal/ModalFooter.svelte';
  import HStack from '../Stack/HStack.svelte';
  import { t } from '../../services/translation.svelte.js';
  import type { Color, ModalSize } from '../../types.js';
  import type { Snippet } from 'svelte';

  interface Props {
    title?: string;
    icon?: string | boolean;
    prompt?: string | Snippet;
    confirmText?: string;
    confirmColor?: Color;
    disabled?: boolean;
    size?: ModalSize;
    onClose: (confirmed: boolean) => void;
  }

  let {
    title = t('confirm'),
    icon,
    prompt = t('prompt_default'),
    confirmText = t('confirm'),
    confirmColor = 'danger',
    disabled = false,
    size = 'small',
    onClose,
  }: Props = $props();

  const handleConfirm = () => {
    onClose(true);
  };
</script>

<Modal {title} onClose={() => onClose(false)} {size} {icon} focusOnOpen>
  <ModalBody>
    {#if typeof prompt === 'string'}
      <p>{prompt}</p>
    {:else}
      {@render prompt()}
    {/if}
  </ModalBody>

  <ModalFooter>
    <HStack fullWidth>
      <Button shape="round" color="secondary" fullWidth onclick={() => onClose(false)}>
        {t('cancel')}
      </Button>
      <Button shape="round" color={confirmColor} fullWidth onclick={handleConfirm} {disabled}>
        {confirmText}
      </Button>
    </HStack>
  </ModalFooter>
</Modal>
