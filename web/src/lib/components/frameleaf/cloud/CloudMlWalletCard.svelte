<script lang="ts">
  /**
   * The AI Wallet (FL-159): what Frameleaf Cloud says this server may still spend. It takes the
   * place of the prototype's compute estimate card (`.jm-cost`, JobsManager.jsx:1584-1605): a
   * balance the cloud reported, the amount running jobs hold and today's spend against the daily
   * limit. A top-up link appears only when the cloud returned one; nothing here is an estimate.
   */
  import Button from '$lib/components/frameleaf/Button.svelte';
  import { formatDateTime, formatUsd, walletDailyCapReached, walletIsEmpty } from '$lib/frameleaf/cloud-ml';
  import type { CloudMlWalletDto } from '@immich/sdk';
  import { Icon } from '@immich/ui';
  import { mdiOpenInNew } from '@mdi/js';
  import { locale, t } from 'svelte-i18n';

  type Props = {
    wallet: CloudMlWalletDto | null;
    /** Reads the wallet again from Frameleaf Cloud; absent while the cloud cannot be asked. */
    onRefresh?: () => void;
    busy?: boolean;
  };

  let { wallet, onRefresh, busy = false }: Props = $props();
</script>

<article class="wallet fl-continuous-corners" aria-labelledby="cloud-ml-wallet-heading">
  <h3 id="cloud-ml-wallet-heading">{$t('admin.frameleaf_cloud_ml_wallet_title')}</h3>
  {#if wallet}
    <div class="balance">
      <span>{$t('admin.frameleaf_cloud_ml_wallet_available')}</span>
      <strong>{formatUsd(wallet.availableUsd, $locale)}</strong>
      <small>
        {$t('admin.frameleaf_cloud_ml_wallet_balance_held', {
          values: { balance: formatUsd(wallet.balanceUsd, $locale), held: formatUsd(wallet.heldUsd, $locale) },
        })}
      </small>
    </div>
    <dl>
      <div>
        <dt>{$t('admin.frameleaf_cloud_ml_wallet_spent_today')}</dt>
        <dd>{formatUsd(wallet.spentTodayUsd, $locale)}</dd>
      </div>
      <div>
        <dt>{$t('admin.frameleaf_cloud_ml_wallet_daily_cap')}</dt>
        <dd>
          {wallet.dailyCapUsd === null
            ? $t('admin.frameleaf_cloud_ml_wallet_no_daily_cap')
            : formatUsd(wallet.dailyCapUsd, $locale)}
        </dd>
      </div>
    </dl>
    {#if walletIsEmpty(wallet)}
      <p class="warning" role="status">{$t('admin.frameleaf_cloud_ml_wallet_empty')}</p>
    {:else if walletDailyCapReached(wallet)}
      <p class="warning" role="status">{$t('admin.frameleaf_cloud_ml_wallet_cap_reached')}</p>
    {/if}
    <p class="muted">
      {$t('admin.frameleaf_cloud_ml_wallet_updated', { values: { date: formatDateTime(wallet.updatedAt, $locale) } })}
    </p>
    <div class="buttons">
      {#if wallet.topUpUrl}
        <a class="top-up" href={wallet.topUpUrl} target="_blank" rel="noopener noreferrer">
          {$t('admin.frameleaf_cloud_ml_wallet_top_up')}
          <Icon icon={mdiOpenInNew} size="14" aria-hidden={true} />
        </a>
      {/if}
      {#if onRefresh}
        <Button onclick={onRefresh} disabled={busy}>{$t('admin.frameleaf_cloud_ml_wallet_refresh')}</Button>
      {/if}
    </div>
  {:else}
    <p class="muted">{$t('admin.frameleaf_cloud_ml_wallet_unknown')}</p>
  {/if}
</article>

<style>
  /* jobs-manager.css:795-818 `.jm-provider-grid article` and :826-842 `.jm-cost`. */
  .wallet {
    padding: 18px;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-card);
    min-width: 0;
  }
  h3 {
    font-size: var(--fl-font-size);
    margin: 0 0 16px;
  }
  .balance {
    padding: 13px;
    background: var(--fl-panel);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
  }
  .balance span,
  .balance small {
    display: block;
    font-size: var(--fl-font-micro);
    color: var(--fl-muted);
  }
  .balance strong {
    display: block;
    font-size: 23px;
    font-weight: 600;
    margin: 4px 0;
    font-variant-numeric: tabular-nums;
  }
  dl {
    margin: 12px 0 0;
    font-size: var(--fl-font-small);
  }
  dl > div {
    display: grid;
    grid-template-columns: 1fr 1.25fr;
    gap: 14px;
    padding: 10px 0;
    border-bottom: 1px solid var(--fl-border);
  }
  dt {
    color: var(--fl-muted);
  }
  dd {
    margin: 0;
    text-align: right;
    font-variant-numeric: tabular-nums;
  }
  .muted,
  .warning {
    font-size: var(--fl-font-small);
    margin: 12px 0 0;
  }
  .muted {
    color: var(--fl-muted);
  }
  .warning {
    color: var(--fl-warning);
  }
  .buttons {
    display: flex;
    flex-wrap: wrap;
    gap: 7px;
    margin-top: 14px;
    align-items: center;
  }
  .top-up {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: var(--fl-font-small);
    color: var(--fl-accent);
  }
  @supports (corner-shape: squircle) {
    .wallet {
      border-radius: calc(var(--fl-radius-card) * 1.8);
    }
  }
</style>
