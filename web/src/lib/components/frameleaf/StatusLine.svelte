<script lang="ts">
  /**
   * What just happened to the control beside it (FL-1810, prototype `StatusLine`): Saving…, then
   * Saved, or why it wasn't saved. A saved setting or field shows this, never a toast. The element
   * stays mounted while idle so screen readers hear the change and the layout does not jump.
   */
  import { ICON_SIZE } from '$lib/frameleaf/tokens';
  import { Icon } from '@frameleaf/ui';
  import { mdiAlertCircleOutline, mdiCheckCircleOutline, mdiProgressClock } from '@mdi/js';
  import { t } from 'svelte-i18n';

  type State = 'saving' | 'saved' | 'failed';

  let {
    state,
    message,
  }: {
    state?: State;
    /** Replaces the default words, e.g. "Removed", or the reason it was not saved. */
    message?: string;
  } = $props();

  const icons: Record<State, string> = {
    saving: mdiProgressClock,
    saved: mdiCheckCircleOutline,
    failed: mdiAlertCircleOutline,
  };
  const words = {
    saving: 'frameleaf_state_saving',
    saved: 'frameleaf_state_saved',
    failed: 'frameleaf_state_not_saved',
  } as const;
</script>

<span
  class="fl-status-line"
  class:saved={state === 'saved'}
  class:failed={state === 'failed'}
  role={state === 'failed' ? 'alert' : 'status'}
  data-testid="frameleaf-status-line"
>
  {#if state}
    <Icon icon={icons[state]} size={ICON_SIZE.md} aria-hidden />
    {message ?? $t(words[state])}
  {/if}
</span>

<style>
  .fl-status-line {
    display: inline-flex;
    align-items: center;
    gap: var(--fl-space-2);
    min-height: var(--fl-space-5);
    color: var(--fl-muted);
    font: var(--fl-type-caption);
  }
  .saved :global(svg) {
    color: var(--fl-accent);
  }
  .failed {
    color: var(--fl-danger);
  }
</style>
