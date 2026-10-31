<script lang="ts" module>
  /**
   * Frameleaf: a tooltip opens on focus only when the person moved focus with the keyboard (Tab, or
   * the arrow keys in a toolbar), as the prototype's native `title` only shows on hover. A page that
   * focuses a control itself (the viewer focuses Close when it opens, from a key press or a deep link)
   * shows no tooltip over the photo. Touch never opens one: bits-ui ignores touch pointers, and a tap
   * focuses while the pointer is down, which it ignores too.
   */
  const NAVIGATION_KEYS = new Set(['Tab', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End']);
  /** Focus moved by a key handler lands within the same task; anything later was not that key. */
  const NAVIGATION_WINDOW_MS = 100;
  let lastNavigationKeyAt = Number.NEGATIVE_INFINITY;
  let listening = false;

  const listen = () => {
    if (listening || typeof window === 'undefined') {
      return;
    }
    listening = true;
    window.addEventListener(
      'keydown',
      (event) => {
        if (NAVIGATION_KEYS.has(event.key)) {
          lastNavigationKeyAt = performance.now();
        }
      },
      { capture: true },
    );
  };

  /** Whether the focus that just happened followed a keyboard navigation key. */
  export const focusFollowsNavigationKey = () => performance.now() - lastNavigationKeyAt < NAVIGATION_WINDOW_MS;
</script>

<script lang="ts">
  import { zIndex } from '../../constants.js';
  import { Tooltip } from 'bits-ui';
  import type { Snippet } from 'svelte';

  type Props = Tooltip.RootProps & {
    text?: string | null;
    child: Snippet<[{ props: Record<string, unknown> }]>;
  };

  let { open = $bindable(false), child: trigger, text, ...restProps }: Props = $props();

  listen();

  /** The trigger's props with its focus handler kept for keyboard navigation only. */
  const keyboardFocusOnly = (props: Record<string, unknown>) => {
    const onfocus = props.onfocus as ((event: FocusEvent) => void) | undefined;
    return {
      ...props,
      onfocus: (event: FocusEvent) => {
        if (focusFollowsNavigationKey()) {
          onfocus?.(event);
        }
      },
    };
  };
</script>

{#if text}
  <Tooltip.Root bind:open {...restProps}>
    <Tooltip.Trigger>
      {#snippet child({ props })}
        {@render trigger({ props: keyboardFocusOnly(props) })}
      {/snippet}
    </Tooltip.Trigger>
    <Tooltip.Portal>
      <Tooltip.Content
        sideOffset={8}
        class="tooltip-content bg-light-800 text-light {zIndex.Tooltip} rounded-lg px-3.5 py-2 text-xs shadow-lg"
      >
        {text}
      </Tooltip.Content>
    </Tooltip.Portal>
  </Tooltip.Root>
{:else}
  {@render trigger({ props: {} })}
{/if}

<style>
  :global(.tooltip-content[data-state='delayed-open']),
  :global(.tooltip-content[data-state='instant-open']) {
    animation: tooltip-enter 150ms ease-out;
  }

  @keyframes tooltip-enter {
    from {
      opacity: 0;
      transform: translateY(4px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }
</style>
