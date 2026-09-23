<script lang="ts">
  /**
   * The failure notice an inline edit in the information panel shows in place (FL-36).
   *
   * Inline edits are small and frequent, so a failure is reported next to the control that
   * failed rather than as a toast that disappears while the person is still typing. The
   * recovery offered comes from `inlineEditRecovery`, so a rejected value never gets a
   * "try again" that cannot succeed, and a stale asset is reloaded rather than overwritten.
   */
  import { inlineEditMessageKey, type InlineEditFailure } from '$lib/frameleaf/inline-edit';
  import { Icon } from '@immich/ui';
  import { mdiAlertCircleOutline } from '@mdi/js';
  import { t } from 'svelte-i18n';

  type Props = {
    failure: InlineEditFailure;
    /** Offered for `network`/`unknown` failures; replays the same value. */
    onRetry?: () => void;
    /** Offered for a `stale` asset; refetches instead of replaying the write. */
    onReload?: () => void;
    busy?: boolean;
  };

  let { failure, onRetry, onReload, busy = false }: Props = $props();
</script>

<div
  class="mt-2 flex items-start gap-2 text-xs text-red-600 dark:text-red-400"
  role="alert"
  data-testid="frameleaf-inline-edit-error"
>
  <Icon icon={mdiAlertCircleOutline} size="16" aria-hidden />
  <div class="min-w-0 flex-1">
    <p>{$t(inlineEditMessageKey(failure))}</p>
    {#if onRetry || onReload}
      <div class="mt-1 flex gap-3">
        {#if onRetry}
          <button
            type="button"
            class="underline disabled:no-underline disabled:opacity-60"
            disabled={busy}
            onclick={onRetry}
          >
            {$t('frameleaf_info_retry')}
          </button>
        {/if}
        {#if onReload}
          <button
            type="button"
            class="underline disabled:no-underline disabled:opacity-60"
            disabled={busy}
            onclick={onReload}
          >
            {$t('frameleaf_info_reload')}
          </button>
        {/if}
      </div>
    {/if}
  </div>
</div>
