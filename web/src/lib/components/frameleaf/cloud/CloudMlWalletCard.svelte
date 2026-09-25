<script lang="ts">
  /**
   * The AI Wallet (FL-159, handoff §3.1 and §2.5; prototype FrameleafCloud.jsx `Processing` wallet card
   * and top-up dialog): prepaid credit for cloud jobs. Balance, held for running jobs, available, and
   * today's spend against the daily cap, all as Frameleaf Cloud reports them, in USD for everyone.
   * The daily cap and automatic top-up are the account's settings, changed here on the linked
   * account. Adding credit happens on frameleaf.cloud: $25 by default, presets $25 / $50 / $100, any
   * whole amount from $20 to $500, no bonus credit, card fees included; this server never sees card
   * details, and the link appears only when Frameleaf Cloud returned one.
   */
  import './frameleaf-cloud.css';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import SettingToggle from '$lib/components/frameleaf/settings/SettingToggle.svelte';
  import {
    DEFAULT_WALLET_PACK,
    formatDateTime,
    formatUsd,
    isTopUpAmount,
    topUpCheckoutUrl,
    walletAvailable,
    walletPacks,
    WALLET_MAX_TOP_UP_USD,
    WALLET_MIN_TOP_UP_USD,
  } from '$lib/frameleaf/cloud-ml';
  import { handleError } from '$lib/utils/handle-error';
  import { updateCloudMlWallet, type CloudMlWalletDto } from '@immich/sdk';
  import { Icon } from '@immich/ui';
  import { mdiCreditCardOutline, mdiOpenInNew, mdiPlus } from '@mdi/js';
  import { locale, t } from 'svelte-i18n';

  type Props = {
    wallet: CloudMlWalletDto | null;
    /** The linked account can be changed and asked; false while not linked or not answering. */
    ready: boolean;
    onChanged?: (wallet: CloudMlWalletDto) => void;
  };

  let { wallet, ready, onChanged }: Props = $props();

  let saving = $state(false);
  // Follows the wallet as the cloud reports it, and holds what is typed until it is sent.
  let capInput = $derived(
    wallet?.dailyCapUsd === null || wallet?.dailyCapUsd === undefined ? '' : String(wallet.dailyCapUsd),
  );
  let topUpOpen = $state(false);
  let pack = $state<string>(DEFAULT_WALLET_PACK);
  let custom = $state('');

  const available = $derived(walletAvailable(wallet));
  const spentShare = $derived(
    wallet && wallet.dailyCapUsd ? Math.min(1, wallet.spentTodayUsd / wallet.dailyCapUsd) : 0,
  );
  const amount = $derived(
    pack === 'custom' ? Number(custom) : (walletPacks.find((entry) => entry.id === pack)?.amount ?? 0),
  );
  const checkout = $derived(topUpCheckoutUrl(wallet?.topUpUrl, amount));

  const save = async (change: { dailyCapUsd?: number; autoTopUp?: boolean }) => {
    saving = true;
    try {
      const next = await updateCloudMlWallet({ cloudMlWalletUpdateDto: change });
      onChanged?.(next);
    } catch (error) {
      handleError(error, $t('admin.frameleaf_cloud_ml_wallet_error'));
    } finally {
      saving = false;
    }
  };

  const saveCap = () => {
    const value = Number(capInput);
    if (Number.isFinite(value) && value >= 1 && value <= 1000 && value !== wallet?.dailyCapUsd) {
      void save({ dailyCapUsd: value });
    }
  };
</script>

<section class="fc-card fl-continuous-corners" aria-labelledby="fc-wallet-title">
  <div class="fc-card-title">
    <span class="fc-card-icon"><Icon icon={mdiCreditCardOutline} size="20" aria-hidden={true} /></span>
    <div>
      <h2 id="fc-wallet-title">{$t('admin.frameleaf_cloud_ml_wallet_title')}</h2>
      <p>{$t('admin.frameleaf_cloud_ml_wallet_description')}</p>
    </div>
    {#if wallet}
      <span class="fc-status" class:is-warning={available < 5} class:is-ok={available >= 5}>
        {$t('admin.frameleaf_cloud_ml_wallet_available_status', { values: { amount: formatUsd(available) } })}
      </span>
    {/if}
  </div>
  {#if wallet}
    <div class="fc-wallet">
      <div>
        <span>{$t('admin.frameleaf_cloud_ml_wallet_balance')}</span>
        <strong>{formatUsd(wallet.balanceUsd)}</strong>
      </div>
      <div>
        <span>{$t('admin.frameleaf_cloud_ml_wallet_held')}</span>
        <strong>{formatUsd(wallet.heldUsd)}</strong>
      </div>
      <div>
        <span>{$t('admin.frameleaf_cloud_ml_wallet_available')}</span>
        <strong>{formatUsd(available)}</strong>
      </div>
    </div>
    <div class="fc-meter">
      <div class="fc-meter-label">
        <span>{$t('admin.frameleaf_cloud_ml_wallet_spent_today')}</span>
        <strong>
          {wallet.dailyCapUsd === null
            ? formatUsd(wallet.spentTodayUsd)
            : $t('admin.frameleaf_cloud_ml_wallet_spent_of_cap', {
                values: { spent: formatUsd(wallet.spentTodayUsd), cap: formatUsd(wallet.dailyCapUsd) },
              })}
        </strong>
      </div>
      <div
        class="fc-meter-track"
        class:is-high={spentShare >= 0.8}
        role="meter"
        aria-label={$t('admin.frameleaf_cloud_ml_wallet_spent_today')}
        aria-valuemin={0}
        aria-valuemax={wallet.dailyCapUsd ?? 0}
        aria-valuenow={wallet.spentTodayUsd}
      >
        <span style:width="{Math.round(spentShare * 100)}%"></span>
      </div>
    </div>
    <label class="fc-stack">
      {$t('admin.frameleaf_cloud_ml_wallet_daily_cap')}
      <span class="fc-input-unit">
        <input
          type="number"
          min="1"
          max="1000"
          step="1"
          bind:value={capInput}
          disabled={!ready || saving}
          onchange={saveCap}
        />
        <span>USD</span>
      </span>
      <small>{$t('admin.frameleaf_cloud_ml_wallet_daily_cap_help')}</small>
    </label>
    <SettingToggle
      title={$t('admin.frameleaf_cloud_ml_wallet_auto_top_up')}
      subtitle={$t('admin.frameleaf_cloud_ml_wallet_auto_top_up_help')}
      checked={wallet.autoTopUp}
      disabled={!ready || saving}
      onToggle={(value) => void save({ autoTopUp: value })}
    />
    <div class="fc-actions">
      <Button
        variant="primary"
        disabled={!ready || !wallet.topUpUrl}
        onclick={() => {
          pack = DEFAULT_WALLET_PACK;
          custom = '';
          topUpOpen = true;
        }}
      >
        <Icon icon={mdiPlus} size="16" aria-hidden={true} />
        {$t('admin.frameleaf_cloud_ml_wallet_add_credit')}
      </Button>
    </div>
    <p class="fc-muted">
      {$t('admin.frameleaf_cloud_ml_wallet_top_up_rules', {
        values: { min: formatUsd(WALLET_MIN_TOP_UP_USD, 0), max: formatUsd(WALLET_MAX_TOP_UP_USD, 0) },
      })}
      {$t('admin.frameleaf_cloud_ml_wallet_fees')}
      {$t('admin.frameleaf_cloud_ml_wallet_updated', { values: { date: formatDateTime(wallet.updatedAt, $locale) } })}
    </p>
  {:else}
    <p class="fc-muted">{$t('admin.frameleaf_cloud_ml_wallet_unknown')}</p>
  {/if}
</section>

<Dialog title={$t('admin.frameleaf_cloud_ml_top_up_title')} closeLabel={$t('close')} bind:open={topUpOpen}>
  <div class="frameleaf-cloud">
    <fieldset class="fc-choices">
      <legend>{$t('admin.frameleaf_cloud_ml_top_up_amount')}</legend>
      {#each walletPacks as entry (entry.id)}
        <label class:is-selected={pack === entry.id}>
          <input type="radio" name="fc-pack" value={entry.id} bind:group={pack} />
          <strong>{formatUsd(entry.amount)}</strong>
          <span>
            {entry.id === DEFAULT_WALLET_PACK
              ? $t('admin.frameleaf_cloud_ml_top_up_suggested')
              : $t('admin.frameleaf_cloud_ml_top_up_credit')}
          </span>
        </label>
      {/each}
      <label class:is-selected={pack === 'custom'}>
        <input type="radio" name="fc-pack" value="custom" bind:group={pack} />
        <strong>{$t('admin.frameleaf_cloud_ml_top_up_other')}</strong>
        <span class="fc-input-unit">
          <input
            type="number"
            min={WALLET_MIN_TOP_UP_USD}
            max={WALLET_MAX_TOP_UP_USD}
            step="1"
            bind:value={custom}
            aria-label={$t('admin.frameleaf_cloud_ml_top_up_other')}
            onfocus={() => (pack = 'custom')}
          />
          <span>USD</span>
        </span>
      </label>
    </fieldset>
    {#if pack === 'custom' && custom !== '' && !isTopUpAmount(amount)}
      <p class="fc-refusal" role="alert">
        {$t('admin.frameleaf_cloud_ml_top_up_invalid', {
          values: { min: formatUsd(WALLET_MIN_TOP_UP_USD, 0), max: formatUsd(WALLET_MAX_TOP_UP_USD, 0) },
        })}
      </p>
    {/if}
    <p class="fc-muted">{$t('admin.frameleaf_cloud_ml_top_up_checkout_note')}</p>
  </div>
  {#snippet actions()}
    <Button onclick={() => (topUpOpen = false)}>{$t('cancel')}</Button>
    {#if checkout}
      <a
        class="fc-button-link"
        href={checkout}
        target="_blank"
        rel="noopener noreferrer"
        onclick={() => (topUpOpen = false)}
      >
        {$t('admin.frameleaf_cloud_ml_top_up_continue')}
        <Icon icon={mdiOpenInNew} size="14" aria-hidden={true} />
      </a>
    {:else}
      <Button variant="primary" disabled>{$t('admin.frameleaf_cloud_ml_top_up_continue')}</Button>
    {/if}
  {/snippet}
</Dialog>
