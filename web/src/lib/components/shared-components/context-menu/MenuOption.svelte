<script lang="ts">
  import type { Shortcut } from '$lib/actions/shortcut';
  import { shortcut as bindShortcut, shortcutLabel as computeShortcutLabel } from '$lib/actions/shortcut';
  import { optionClickCallbackStore, selectedIdStore } from '$lib/stores/context-menu.store';
  import { generateId } from '$lib/utils/generate-id';
  import { Icon, type IconLike } from '@frameleaf/ui';

  interface Props {
    text: string;
    subtitle?: string;
    icon?: IconLike;
    /** A destructive entry, in the danger colour (`.mv-menu [role="menuitem"].danger`). */
    danger?: boolean;
    onClick: () => void;
    shortcut?: Shortcut | null;
    shortcutLabel?: string;
  }

  let { text, subtitle = '', icon, danger = false, onClick, shortcut = null, shortcutLabel = '' }: Props = $props();

  let id: string = generateId();

  let isActive = $derived($selectedIdStore === id);

  const handleClick = () => {
    // eslint-disable-next-line unicorn/no-optional-chaining-on-undeclared-variable
    $optionClickCallbackStore?.();
    onClick();
  };

  if (shortcut && !shortcutLabel) {
    shortcutLabel = computeShortcutLabel(shortcut);
  }
  const bindShortcutIfSet = shortcut
    ? (n: HTMLElement) => bindShortcut(n, { shortcut, onShortcut: onClick })
    : () => {};
</script>

<svelte:document use:bindShortcutIfSet />

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_mouse_events_have_key_events -->
<li
  {id}
  onclick={handleClick}
  onmouseover={() => ($selectedIdStore = id)}
  onmouseleave={() => ($selectedIdStore = undefined)}
  class="fl-menu-option"
  class:active={isActive}
  class:danger
  role="menuitem"
>
  <!-- The slot stays when a row has no icon (a choice that is not ticked), so every label starts on the same line. -->
  <span class="fl-menu-option-icon" aria-hidden="true">
    {#if icon}
      <Icon {icon} aria-hidden size="18" />
    {/if}
  </span>
  <div class="fl-menu-option-text">
    <div class="fl-menu-option-line">
      {text}
      {#if shortcutLabel}
        <span class="fl-menu-option-hint">
          {shortcutLabel}
        </span>
      {/if}
    </div>
    {#if subtitle}
      <p class="fl-menu-option-hint">
        {subtitle}
      </p>
    {/if}
  </div>
</li>

<style>
  /* One entry of the viewer's menu (.mv-menu [role="menuitem"], media-viewer.css:161-190). */
  .fl-menu-option {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    min-height: 34px;
    padding: 7px 12px;
    border-radius: var(--fl-radius-control);
    color: var(--fl-viewer-text);
    font-size: var(--fl-font-small);
    text-align: start;
    cursor: pointer;
  }

  .fl-menu-option-icon {
    display: inline-flex;
    flex: none;
    width: 18px;
    height: 18px;
  }

  .fl-menu-option :global(svg) {
    flex-shrink: 0;
    color: var(--fl-viewer-muted);
  }

  /* The pointer and the arrow keys share one highlight: the menu's active option. */
  .fl-menu-option.active {
    background: color-mix(in srgb, var(--fl-viewer-text) 6%, transparent);
  }

  .fl-menu-option.danger,
  .fl-menu-option.danger :global(svg) {
    color: var(--fl-danger);
  }

  .fl-menu-option-text {
    width: 100%;
    min-width: 0;
  }

  .fl-menu-option-line {
    display: flex;
    justify-content: space-between;
    gap: 16px;
  }

  .fl-menu-option-hint {
    color: var(--fl-viewer-muted);
  }

  p.fl-menu-option-hint {
    font-size: var(--fl-font-micro);
  }

  /* Touch: the row is the tap target (tokens.css --fl-control-height). */
  @media (pointer: coarse) {
    .fl-menu-option {
      min-height: var(--fl-control-height, 44px);
    }
  }
</style>
