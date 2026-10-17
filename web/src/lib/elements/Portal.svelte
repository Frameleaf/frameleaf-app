<script module lang="ts">
  import { handlePromiseError } from '$lib/utils';
  import { tick, type Snippet } from 'svelte';

  /**
   * Usage: <div use:portal={'css selector'}> or <div use:portal={document.body}>
   */
  export function portal(element: HTMLElement, target: HTMLElement | string = 'body') {
    let generation = 0;
    let destroyed = false;
    async function update(newTarget: HTMLElement | string) {
      if (destroyed) {
        return;
      }
      const current = ++generation;
      let targetElement;
      if (typeof newTarget === 'string') {
        targetElement = document.querySelector(newTarget);
        if (targetElement === null) {
          await tick();
          if (destroyed || current !== generation) {
            return;
          }
          targetElement = document.querySelector(newTarget);
        }
        if (targetElement === null) {
          throw new Error(`No element found matching css selector: "${newTarget}"`);
        }
      } else if (newTarget instanceof HTMLElement) {
        targetElement = newTarget;
      } else {
        throw new TypeError(
          `Unknown portal target type: ${
            newTarget === null ? 'null' : typeof newTarget
          }. Allowed types: string (CSS selector) or HTMLElement.`,
        );
      }
      targetElement.append(element);
      element.hidden = false;
    }

    function destroy() {
      destroyed = true;
      element.remove();
    }

    handlePromiseError(update(target));
    return {
      update,
      destroy,
    };
  }
</script>

<!--
@component
Allow rendering a component in a different part of the DOM.

### Props
- `target` - HTMLElement i.e "body", "html", default is "body"

### Default Slot
Used for every occurrence of an HTML tag in a message
- `tag` - Name of the tag

@example
```html
<Portal target="body">
  <p>Your component in here</p>
</Portal>
```
-->
<script lang="ts">
  interface Props {
    /**
     * DOM Element or CSS Selector
     */
    target?: HTMLElement | string;
    children?: Snippet;
  }

  let { target = 'body', children }: Props = $props();
</script>

<div use:portal={target} hidden>
  {@render children?.()}
</div>
