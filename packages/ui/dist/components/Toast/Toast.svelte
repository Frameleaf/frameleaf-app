<script lang="ts">
  import Button from '../Button/Button.svelte';
  import ToastContainer from './ToastContainer.svelte';
  import ToastContent from './ToastContent.svelte';
  import type { ToastProps } from '../../types.js';

  let { children, title, description, icon, onClose, button, ...props }: ToastProps = $props();
</script>

<ToastContainer {...props}>
  {#if children}
    {@render children()}
  {:else if title}
    <ToastContent {title} {description} {icon} {onClose} {...props}>
      {#if button && onClose}
        {@const { label, ...rest } = typeof button === 'function' ? button(onClose) : button}
        <div class="flex justify-end px-3 pt-2">
          <Button color="primary" size="small" {...rest}>
            {label}
          </Button>
        </div>
      {/if}
    </ToastContent>
  {/if}
</ToastContainer>
