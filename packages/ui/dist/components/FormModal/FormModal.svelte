<script lang="ts">
  import Button from '../Button/Button.svelte';
  import Modal from '../Modal/Modal.svelte';
  import ModalBody from '../Modal/ModalBody.svelte';
  import ModalFooter from '../Modal/ModalFooter.svelte';
  import HStack from '../Stack/HStack.svelte';
  import { t } from '../../services/translation.svelte.js';
  import type { Color, ModalSize } from '../../types.js';
  import { generateId } from '../../utilities/internal.js';
  import type { Snippet } from 'svelte';

  type Props = {
    title: string;
    icon?: string | boolean;
    submitText?: string;
    submitColor?: Color;
    cancelText?: string;
    cancelColor?: Color;
    disabled?: boolean;
    size?: ModalSize;
    preventDefault?: boolean;
    onClose: () => void;
    onOpenAutoFocus?: (event: Event) => void;
    onReset?: (event: Event) => void;
    onSubmit: (event: SubmitEvent) => void | Promise<void>;
    children: Snippet<[{ formId: string }]>;
  };

  let {
    title,
    icon,
    submitText = t('save'),
    submitColor = 'primary',
    cancelText = t('cancel'),
    cancelColor = 'secondary',
    disabled = false,
    size = 'small',
    preventDefault = true,
    onClose = () => {},
    onOpenAutoFocus,
    onReset,
    onSubmit,
    children,
  }: Props = $props();

  let loading = $state(false);

  const onsubmit = async (event: SubmitEvent) => {
    if (preventDefault) {
      event.preventDefault();
    }

    loading = true;

    try {
      await onSubmit(event);
    } finally {
      loading = false;
    }
  };

  const onreset = (event: Event) => {
    if (preventDefault) {
      event.preventDefault();
    }

    onReset?.(event);
  };

  const formId = generateId();
</script>

<Modal {title} {onClose} {size} {icon} {onOpenAutoFocus}>
  <ModalBody>
    <form {onsubmit} {onreset} id={formId}>
      {@render children({ formId })}
    </form>
  </ModalBody>
  <ModalFooter>
    <HStack fullWidth>
      <Button shape="round" color={cancelColor} fullWidth onclick={() => onClose()} disabled={loading}>
        {cancelText}
      </Button>
      <Button shape="round" type="submit" tabindex={1} color={submitColor} fullWidth {disabled} {loading} form={formId}>
        {submitText}
      </Button>
    </HStack>
  </ModalFooter>
</Modal>
