<script lang="ts">
  import Scrollable from '../Scrollable/Scrollable.svelte';
  import { ChildKey, zIndex } from '../../constants.js';
  import Child from '../../internal/Child.svelte';
  import { cleanClass } from '../../utilities/internal.js';
  import { type Snippet } from 'svelte';
  import { tv } from 'tailwind-variants';

  type Props = {
    class?: string;
    children: Snippet;
    open?: boolean;
    border?: boolean;
  };

  let { class: className, border = true, children, open = $bindable(true) }: Props = $props();

  const styles = tv({
    base: 'bg-light text-dark absolute shrink-0 transition-all duration-200 md:relative',
    variants: {
      border: {
        true: 'border-e shadow-lg',
        false: '',
      },
      open: {
        true: `${zIndex.AppShellSidebar} w-[min(100vw,16rem)]`,
        false: 'w-0 border-e-0',
      },
    },
  });
</script>

<Child for={ChildKey.AppShell} as={ChildKey.AppShellSidebar}>
  <Scrollable class={cleanClass(styles({ border, open }), className)}>
    {@render children?.()}
  </Scrollable>
</Child>
