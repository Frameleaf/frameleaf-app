<script lang="ts">
  /**
   * A list or page that could not be read (FL-1810, prototype `LoadFailed`): it says so where the
   * content would be, with a way to retry. Never a toast and never a blank page. `title` is the
   * whole sentence ("Your people couldn't be loaded") so every language can word it naturally.
   */
  import { ICON_SIZE } from '$lib/frameleaf/tokens';
  import { Icon } from '@frameleaf/ui';
  import { mdiAlertCircleOutline } from '@mdi/js';
  import { t } from 'svelte-i18n';

  let {
    title,
    message,
    onRetry,
    busy = false,
  }: {
    title?: string;
    message?: string;
    onRetry: () => void;
    /** The retry is running: the button says so and can't be pressed twice. */
    busy?: boolean;
  } = $props();
</script>

<div class="fl-load-failed" role="alert" data-testid="frameleaf-load-failed">
  <Icon icon={mdiAlertCircleOutline} size={ICON_SIZE.xl} aria-hidden />
  <span class="text">
    <strong>{title ?? $t('frameleaf_state_load_failed')}</strong>
    <small>{message ?? $t('frameleaf_state_load_failed_body')}</small>
  </span>
  <button type="button" class="button" aria-busy={busy} disabled={busy} onclick={onRetry}>
    {$t('frameleaf_state_try_again')}
  </button>
</div>

<style>
  .fl-load-failed {
    display: flex;
    align-items: center;
    gap: var(--fl-space-4);
    padding: var(--fl-space-4);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-card);
    background: var(--fl-panel);
    color: var(--fl-muted);
  }
  .text {
    display: grid;
    gap: var(--fl-space-1);
    flex: 1;
    min-width: 0;
  }
  strong {
    color: var(--fl-text);
    font: 600 var(--fl-font-callout) / 1.3 var(--fl-family-ui);
  }
  small {
    font: var(--fl-type-caption);
    line-height: 1.5;
  }
  .button {
    flex: none;
    min-height: 44px;
  }
  @media (max-width: 560px) {
    .fl-load-failed {
      flex-wrap: wrap;
    }
  }
</style>
