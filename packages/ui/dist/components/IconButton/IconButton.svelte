<script lang="ts">
  import Icon from '../Icon/Icon.svelte';
  import Button from '../../internal/Button.svelte';
  import type { IconButtonProps } from '../../types.js';

  const {
    icon,
    flipped,
    flopped,
    indicator,
    title,
    'aria-label': ariaLabel,
    color = 'primary',
    ...buttonProps
  }: IconButtonProps = $props();

  const buttonTitle = $derived(title ?? ariaLabel);
</script>

<Button icon {color} {...buttonProps} title={buttonTitle} aria-label={ariaLabel}>
  <Icon {icon} {flipped} {flopped} {indicator} size="60%" aria-hidden />
</Button>
