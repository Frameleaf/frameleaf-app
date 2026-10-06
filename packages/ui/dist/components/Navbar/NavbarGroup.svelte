<script lang="ts">
  import Text from '../Text/Text.svelte';
  import type { FontWeight, NavbarVariant, Size, TextColor } from '../../types.js';
  import { cleanClass } from '../../utilities/internal.js';
  import { tv } from 'tailwind-variants';

  type Props = {
    title: string;
    size?: Size;
    color?: TextColor;
    fontWeight?: FontWeight;
    variant?: NavbarVariant;
    class?: string;
  };

  let { title, size = 'small', variant, fontWeight, color, class: className }: Props = $props();

  const styles = tv({
    base: 'ps-6 transition-all duration-200',
    variants: {
      variant: {
        compact: 'py-4',
        default: 'py-6',
      },
    },
  });
</script>

<div class={cleanClass(styles({ variant: variant ?? 'default' }), className)}>
  <Text {color} {size} {fontWeight}>{title}</Text>
</div>
