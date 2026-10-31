<script lang="ts">
  /**
   * The Frameleaf toast: a raised capsule docked at the bottom centre, with a leading status icon,
   * one line of message, an optional action such as Undo, and a close button. It replaces the
   * legacy kit's tinted card for every `toastManager` call (`$lib/frameleaf/toast.ts` installs it
   * as the renderer), so the 200-odd existing call sites need no change.
   *
   * Colour never carries the meaning alone: the icon shape differs per status, an error is
   * announced as an alert and everything else as a polite status. It enters and leaves on the Dock
   * pattern, which is a crossfade under Reduce Motion.
   */
  import { dock } from '$lib/frameleaf/motion';
  import { ICON_SIZE } from '$lib/frameleaf/tokens';
  import '$lib/frameleaf/tokens.css';
  import { Icon } from '@frameleaf/ui';
  import {
    mdiAlertCircleOutline,
    mdiAlertOutline,
    mdiCheckCircleOutline,
    mdiClose,
    mdiInformationOutline,
  } from '@mdi/js';
  import type { Snippet } from 'svelte';
  import { t } from 'svelte-i18n';

  type Tone = 'primary' | 'secondary' | 'success' | 'info' | 'warning' | 'danger';
  type Action = { label: string; onclick: () => unknown };

  let {
    title,
    description,
    color = 'primary',
    icon,
    button,
    onClose,
    children,
  }: {
    title?: string | Snippet;
    description?: string | Snippet;
    color?: Tone;
    /** An icon path to use instead of the status icon; `false` for none. */
    icon?: string | false;
    /** The action. A function receives `close` so the action can dismiss the toast itself. */
    button?: Action | ((close: () => void) => Action);
    onClose?: () => void;
    children?: Snippet;
  } = $props();

  const STATUS_ICONS: Record<Tone, string> = {
    primary: mdiCheckCircleOutline,
    success: mdiCheckCircleOutline,
    secondary: mdiInformationOutline,
    info: mdiInformationOutline,
    warning: mdiAlertOutline,
    danger: mdiAlertCircleOutline,
  };

  const close = () => onClose?.();
  const action = $derived(typeof button === 'function' ? button(close) : button);
  const statusIcon = $derived(icon === false ? undefined : (icon ?? STATUS_ICONS[color] ?? mdiInformationOutline));
  // The kit titles every toast "Success", "Info", "Warning" or "Error". The icon already says
  // that, so a generic title is dropped and the message stands alone; a real title is kept.
  const genericTitles = $derived([$t('success'), $t('info'), $t('warning'), $t('error')]);
  const heading = $derived(
    title !== undefined && description !== undefined && !(typeof title === 'string' && genericTitles.includes(title))
      ? title
      : undefined,
  );
  const message = $derived(description ?? title);
</script>

{#snippet text(value: string | Snippet)}
  {#if typeof value === 'string'}{value}{:else}{@render value()}{/if}
{/snippet}

<div
  class="frameleaf fl-toast {color}"
  role={color === 'danger' ? 'alert' : 'status'}
  data-testid="frameleaf-toast"
  in:dock|global
  out:dock|global
>
  {#if children}
    {@render children()}
  {:else}
    {#if statusIcon}
      <span class="fl-toast-icon" aria-hidden="true"><Icon icon={statusIcon} size={ICON_SIZE.lg} /></span>
    {/if}
    <p class="fl-toast-text">
      {#if heading}<strong>{@render text(heading)}</strong>{/if}
      {#if message}<span>{@render text(message)}</span>{/if}
    </p>
    {#if action}
      <button
        type="button"
        class="fl-toast-action"
        onclick={() => {
          void action.onclick();
          close();
        }}>{action.label}</button
      >
    {/if}
    {#if onClose}
      <button type="button" class="fl-toast-close" aria-label={$t('dismiss')} onclick={close}>
        <Icon icon={mdiClose} size={ICON_SIZE.md} aria-hidden />
      </button>
    {/if}
  {/if}
</div>

<style>
  .fl-toast {
    display: flex;
    align-items: center;
    gap: var(--fl-space-2);
    max-width: min(34rem, 100%);
    padding-block: var(--fl-space-1);
    padding-inline: var(--fl-space-4) var(--fl-space-1);
    color: var(--fl-text);
    background: var(--fl-raised);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-capsule);
    box-shadow: var(--fl-shadow-2);
    pointer-events: auto;
  }
  .fl-toast-icon {
    display: inline-flex;
    color: var(--fl-accent);
  }
  .info .fl-toast-icon,
  .secondary .fl-toast-icon {
    color: var(--fl-muted);
  }
  .warning .fl-toast-icon {
    color: var(--fl-warning);
  }
  .danger .fl-toast-icon {
    color: var(--fl-danger);
  }
  .fl-toast-text {
    display: flex;
    flex-direction: column;
    min-width: 0;
    margin: 0;
    padding-block: var(--fl-space-2);
    font: var(--fl-type-callout);
    overflow-wrap: anywhere;
  }
  .fl-toast-text strong {
    font-weight: 600;
  }
  .fl-toast-action {
    flex-shrink: 0;
    padding-inline: var(--fl-space-3);
    font: var(--fl-type-callout);
    font-weight: 600;
    color: var(--fl-accent);
    border-radius: var(--fl-radius-control);
  }
  .fl-toast-action:hover {
    background: var(--fl-accent-soft);
  }
  .fl-toast-close {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    min-width: var(--fl-control-height);
    margin-inline-start: auto;
    color: var(--fl-muted);
    border-radius: var(--fl-radius-pill);
  }
  .fl-toast-close:hover {
    color: var(--fl-text);
    background: color-mix(in srgb, var(--fl-raised), var(--fl-text) 8%);
  }
</style>
