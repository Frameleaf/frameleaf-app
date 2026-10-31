<script lang="ts">
  /**
   * The device-code block for linking this server (FL-155), shared by Settings → Frameleaf Cloud →
   * Account & link and first-run setup: the code with a copy button, where to enter it, a QR for
   * approving on a phone, the countdown, and the "could not check" notice. The actions (new code,
   * cancel) stay with the caller. `expired` reports when the countdown reaches zero.
   */
  import QrCode from '$lib/components/frameleaf/QrCode.svelte';
  import { displayHost, formatCountdown, secondsUntil, shortFingerprint } from '$lib/frameleaf/cloud';
  import { ICON_SIZE } from '$lib/frameleaf/tokens';
  import { copyToClipboard } from '$lib/utils';
  import type { CloudStatusResponseDto } from '@frameleaf/sdk';
  import { Icon } from '@frameleaf/ui';
  import { mdiContentCopy } from '@mdi/js';
  import { t } from 'svelte-i18n';

  type Props = {
    pending: NonNullable<CloudStatusResponseDto['pending']>;
    keyFingerprint?: string | null;
    lastError?: string | null;
    pollError?: boolean;
    /** Setup's layout: a smaller code and QR, no key fingerprint. */
    compact?: boolean;
    expired?: boolean;
  };
  let {
    pending,
    keyFingerprint = null,
    lastError = null,
    pollError = false,
    compact = false,
    expired = $bindable(false),
  }: Props = $props();

  let now = $state(Date.now());
  $effect(() => {
    void pending.expiresAt;
    now = Date.now();
    const timer = setInterval(() => (now = Date.now()), 1000);
    return () => clearInterval(timer);
  });

  const left = $derived(secondsUntil(pending.expiresAt, now));
  const isExpired = $derived(left === 0);
  $effect(() => {
    if (expired !== isExpired) {
      expired = isExpired;
    }
  });
</script>

<div class="cpc" class:compact>
  <div class="cpc-main">
    <p class="cpc-overline">{$t('frameleaf_cloud_your_code')}</p>
    <div class="cpc-code-row">
      <p class="cpc-code" class:is-expired={isExpired} aria-live="polite">{pending.userCode}</p>
      {#if !isExpired}
        <button
          type="button"
          class="cpc-copy"
          aria-label={$t('frameleaf_cloud_copy_code')}
          title={$t('frameleaf_cloud_copy_code')}
          onclick={() => void copyToClipboard(pending.userCode)}
        >
          <Icon icon={mdiContentCopy} size={ICON_SIZE.md} aria-hidden={true} />
        </button>
      {/if}
    </div>
    <p class="cpc-where">
      {$t('frameleaf_cloud_go_to')}
      <a href={pending.verificationUriComplete} target="_blank" rel="noopener noreferrer">
        {displayHost(pending.verificationUri)}
      </a>
      {$t('frameleaf_cloud_enter_code')}
    </p>
    <dl class="cpc-facts">
      <dt>{$t('frameleaf_cloud_expires_in')}</dt>
      <dd class="fl-tabular" class:is-expired={isExpired}>
        {isExpired ? $t('frameleaf_cloud_expired') : formatCountdown(left)}
      </dd>
      {#if !compact}
        <dt>{$t('frameleaf_cloud_server_key')}</dt>
        <dd><code title={keyFingerprint ?? ''}>{shortFingerprint(keyFingerprint)}</code></dd>
      {/if}
    </dl>
    <p class="cpc-muted">{$t('frameleaf_cloud_pending_check')}</p>
    {#if pollError}
      <p class="cpc-problem" role="alert">{$t('frameleaf_cloud_poll_failed')}</p>
    {/if}
    {#if lastError}
      <p class="cpc-muted" role="status">{lastError}</p>
    {/if}
  </div>
  <div class="cpc-qr">
    <QrCode
      value={pending.verificationUriComplete}
      size={compact ? 120 : 168}
      label={$t('frameleaf_cloud_qr_label')}
      copyLabel={$t('frameleaf_cloud_qr_copy')}
      downloadLabel={$t('frameleaf_cloud_qr_download')}
      errorLabel={$t('frameleaf_cloud_qr_error')}
      showActions={false}
    />
  </div>
</div>

<style>
  .cpc {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: var(--fl-space-6);
    align-items: start;
  }
  .cpc.compact {
    gap: var(--fl-space-4);
  }
  .cpc-main {
    display: grid;
    gap: var(--fl-space-2);
    min-width: 0;
  }
  .cpc p,
  .cpc dl {
    margin: 0;
    font-size: var(--fl-font-small);
    line-height: 1.6;
  }
  .cpc-overline {
    color: var(--fl-muted);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    font-size: var(--fl-font-micro);
  }
  .cpc-code-row {
    display: flex;
    align-items: center;
    gap: var(--fl-space-2);
  }
  .cpc .cpc-code {
    margin: 0;
    font-family: var(--fl-family-mono);
    font-size: 34px;
    font-weight: 600;
    line-height: 1.1;
    letter-spacing: 0.12em;
    color: var(--fl-text);
  }
  .cpc.compact .cpc-code {
    font-size: 26px;
  }
  .cpc .cpc-code.is-expired {
    color: var(--fl-muted);
    text-decoration: line-through;
  }
  .cpc-copy {
    display: inline-grid;
    place-items: center;
    width: var(--fl-control-height);
    height: var(--fl-control-height);
    min-height: var(--fl-control-height);
    padding: 0;
    border: 0;
    border-radius: var(--fl-radius-control);
    background: transparent;
    color: var(--fl-muted);
    cursor: pointer;
    transition:
      background-color var(--fl-motion-fast) var(--fl-ease),
      color var(--fl-motion-fast) var(--fl-ease);
  }
  .cpc-copy:hover {
    background: var(--fl-raised);
    color: var(--fl-text);
  }
  .cpc-copy:focus-visible {
    outline: var(--fl-focus-ring);
    outline-offset: var(--fl-focus-offset);
  }
  .cpc-facts {
    display: grid;
    grid-template-columns: max-content minmax(0, 1fr);
    gap: var(--fl-space-1) var(--fl-space-4);
  }
  .cpc-facts dt,
  .cpc-muted {
    color: var(--fl-muted);
  }
  .cpc-facts dd {
    margin: 0;
    min-width: 0;
    overflow-wrap: anywhere;
    color: var(--fl-text);
  }
  .cpc-facts dd.is-expired {
    color: var(--fl-danger);
  }
  .cpc-problem {
    color: var(--fl-danger);
  }
  .cpc a {
    color: var(--fl-accent);
  }
  @media (max-width: 640px) {
    .cpc {
      grid-template-columns: minmax(0, 1fr);
    }
    .cpc .cpc-code {
      font-size: var(--fl-font-display);
    }
  }
</style>
