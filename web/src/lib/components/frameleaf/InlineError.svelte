<script lang="ts">
  /**
   * The inline error state: one section of a page could not load or an action failed, and the
   * rest of the page stays usable. An icon, a plain sentence, and a real Retry button.
   *
   * Use it instead of a bare "Could not load. Try again." line, and instead of sending the whole
   * page to the error screen because one request failed. `message` is customer copy: what
   * happened and what to do, never a server message or a status code.
   *
   * The message is announced when it appears (`role="alert"`). While `retrying` the button is
   * disabled and shows the spinner. `compact` is a single row for a list row or a small card.
   */
  import Spinner from '$lib/components/frameleaf/Spinner.svelte';
  import { ICON_SIZE } from '$lib/frameleaf/tokens';
  import { Icon } from '@frameleaf/ui';
  import { mdiAlertCircleOutline } from '@mdi/js';
  import type { Snippet } from 'svelte';
  import { t } from 'svelte-i18n';

  let {
    message,
    title,
    onRetry,
    retryLabel,
    retrying = false,
    compact = false,
    icon = mdiAlertCircleOutline,
    children,
  }: {
    message: string;
    /** An optional heading for a section-sized error. */
    title?: string;
    /** Shows the Retry button. May return a promise; the caller owns `retrying`. */
    onRetry?: () => unknown;
    /** Defaults to "Try again". */
    retryLabel?: string;
    retrying?: boolean;
    compact?: boolean;
    icon?: string;
    /** Extra actions beside Retry, for example a link to settings. */
    children?: Snippet;
  } = $props();
</script>

<div class="fl-inline-error" class:compact role="alert" data-testid="frameleaf-inline-error">
  <span class="icon" aria-hidden="true"><Icon {icon} size={compact ? ICON_SIZE.lg : ICON_SIZE.hero} /></span>
  <div class="copy">
    {#if title}<p class="title">{title}</p>{/if}
    <p class="message">{message}</p>
  </div>
  {#if onRetry || children}
    <div class="actions">
      {#if onRetry}
        <button type="button" class="button" disabled={retrying} onclick={() => void onRetry()}>
          {#if retrying}<Spinner size="md" decorative />{/if}
          {retryLabel ?? $t('frameleaf_error_retry')}
        </button>
      {/if}
      {@render children?.()}
    </div>
  {/if}
</div>

<style>
  .fl-inline-error {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--fl-space-3);
    padding: var(--fl-space-8) var(--fl-space-4);
    color: var(--fl-muted);
    text-align: center;
  }
  .icon {
    display: inline-flex;
    color: var(--fl-danger);
  }
  .copy {
    display: flex;
    flex-direction: column;
    gap: var(--fl-space-1);
    max-width: 28rem;
  }
  p {
    margin: 0;
  }
  .title {
    font: var(--fl-type-headline);
    letter-spacing: var(--fl-tracking-headline);
    color: var(--fl-text);
  }
  .message {
    font: var(--fl-type-body);
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: var(--fl-space-2);
  }
  .compact {
    flex-direction: row;
    gap: var(--fl-space-3);
    padding: var(--fl-space-3) var(--fl-space-4);
    text-align: start;
    background: var(--fl-raised);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-card);
  }
  .compact .copy {
    flex: 1;
    min-width: 0;
    max-width: none;
  }
  .compact .title {
    font: var(--fl-type-body);
    font-weight: 600;
  }
  .compact .message {
    font: var(--fl-type-callout);
  }
  @media (max-width: 480px) {
    .compact {
      flex-wrap: wrap;
    }
  }
</style>
