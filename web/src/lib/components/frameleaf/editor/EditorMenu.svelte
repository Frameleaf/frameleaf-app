<script lang="ts" module>
  export type EditorMenuItem = {
    id: string;
    label: string;
    icon: string;
    /** Present for a radio item (the Versions list); absent for a plain command. */
    checked?: boolean;
    disabled?: boolean;
    /** Short trailing note, such as "Current". */
    note?: string;
    title?: string;
    /** Draws a separator above this item. */
    separated?: boolean;
    onSelect: () => void;
  };
</script>

<script lang="ts">
  /**
   * A quick-editor top-bar popover menu: the Versions and More actions popovers of
   * `design/frameleaf/template/src/Editor.jsx:1888-1943` (`Menu`). The trigger is a toolbar
   * button; the list is a `menu` with arrow-key roving focus. Escape or Tab closes it and returns
   * focus to the trigger, and a press outside closes it without moving focus.
   */
  import { Icon } from '@immich/ui';
  import { tick, type Snippet } from 'svelte';

  interface Props {
    /** Accessible name of the trigger and the menu. */
    label: string;
    icon: string;
    /** Visible trigger text; icon-only when omitted. */
    text?: string;
    /** Extra classes for the trigger, e.g. `ed-narrow` for the phone-only More button. */
    class?: string;
    heading?: string;
    items: EditorMenuItem[];
    /** Notes above the list (empty states, hints). */
    children?: Snippet;
  }

  let { label, icon, text, class: className = '', heading, items, children }: Props = $props();

  let open = $state(false);
  let trigger = $state<HTMLButtonElement>();
  let menu = $state<HTMLDivElement>();
  const menuId = $props.id();

  const enabledItems = () => [
    ...(menu?.querySelectorAll<HTMLElement>('[role^="menuitem"]:not([aria-disabled="true"])') ?? []),
  ];

  async function toggle() {
    open = !open;
    if (open) {
      await tick();
      const options = enabledItems();
      (options.find((item) => item.getAttribute('aria-checked') === 'true') ?? options[0])?.focus();
    }
  }

  function close(restoreFocus: boolean) {
    open = false;
    if (restoreFocus) {
      trigger?.focus();
    }
  }

  function onMenuKeyDown(event: KeyboardEvent) {
    const options = enabledItems();
    const index = options.indexOf(document.activeElement as HTMLElement);
    const target = new Map([
      ['ArrowDown', index + 1],
      ['ArrowUp', index - 1],
      ['Home', 0],
      ['End', options.length - 1],
    ]).get(event.key);
    if (target !== undefined) {
      event.preventDefault();
      options[(target + options.length) % options.length]?.focus();
    } else if (event.key === 'Escape' || event.key === 'Tab') {
      event.preventDefault();
      event.stopPropagation();
      close(true);
    }
  }

  function onWindowPointerDown(event: PointerEvent) {
    if (open && !menu?.contains(event.target as Node) && !trigger?.contains(event.target as Node)) {
      close(false);
    }
  }

  function choose(item: EditorMenuItem) {
    if (item.disabled) {
      return;
    }
    close(true);
    item.onSelect();
  }
</script>

<svelte:window onpointerdown={onWindowPointerDown} />

<div class="ed-menu">
  <button
    bind:this={trigger}
    type="button"
    class={['ed-tool', text && 'labelled', className]}
    aria-label={text ? undefined : label}
    aria-haspopup="menu"
    aria-expanded={open}
    aria-controls={menuId}
    title={label}
    onclick={toggle}
  >
    <Icon {icon} size="20" />
    {#if text}
      <span>{text}</span>
    {/if}
  </button>
  <div bind:this={menu} class="ed-menu-popover" hidden={!open}>
    {#if heading}
      <h3 id="{menuId}-title">{heading}</h3>
    {/if}
    {@render children?.()}
    <div
      id={menuId}
      role="menu"
      tabindex="-1"
      aria-label={heading ? undefined : label}
      aria-labelledby={heading ? `${menuId}-title` : undefined}
      onkeydown={onMenuKeyDown}
    >
      {#each items as item (item.id)}
        {#if item.separated}
          <div role="separator"></div>
        {/if}
        <button
          type="button"
          role={item.checked === undefined ? 'menuitem' : 'menuitemradio'}
          aria-checked={item.checked}
          aria-disabled={item.disabled || undefined}
          title={item.title}
          onclick={() => choose(item)}
        >
          <Icon icon={item.icon} size="18" />
          {item.label}
          {#if item.note}
            <small>{item.note}</small>
          {/if}
        </button>
      {/each}
    </div>
  </div>
</div>
