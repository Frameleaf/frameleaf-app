<script lang="ts">
  /**
   * The AI Wallet (FL-159, handoff §3.1 and §2.5; prototype FrameleafCloud.jsx `Processing` wallet card
   * and top-up dialog): prepaid credit for cloud jobs. Balance, held for running jobs, available, and
   * today's spend against the daily cap, all as Frameleaf Cloud reports them, in USD for everyone.
   * The daily cap and automatic top-up are the account's settings. This server may only reduce spend
   * (FL-177, as-built decision #22): lower the cap or turn automatic top-up off. Raising the cap and
   * turning automatic top-up on need the account owner in the Frameleaf account app, so they are links
   * there (`settingsUrl`, when Frameleaf Cloud named it), and a `403 step-up-required` answer says so.
   * Adding credit happens on frameleaf.cloud: $25 by default, presets $25 / $50 / $100, any whole
   * amount from $20 to $500, no bonus credit, card fees included; this server never sees card details,
   * and the link appears only when Frameleaf Cloud returned one.
   */
  import './frameleaf-cloud.css';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import Row from '$lib/components/frameleaf/settings/kit/Row.svelte';
  import Switch from '$lib/components/frameleaf/settings/kit/Switch.svelte';
  import {
    canLowerCap,
    DEFAULT_WALLET_PACK,
    formatDateTime,
    formatUsd,
    isStepUpRequired,
    isTopUpAmount,
    topUpCheckoutUrl,
    walletAvailable,
    walletPacks,
    WALLET_MAX_TOP_UP_USD,
    WALLET_MIN_TOP_UP_USD,
  } from '$lib/frameleaf/cloud-ml';
  import { handleError } from '$lib/utils/handle-error';
  import { getCloudMlWallet, updateCloudMlWallet, type CloudMlWalletDto } from '@frameleaf/sdk';
  import { Icon } from '@frameleaf/ui';
  import { mdiOpenInNew } from '@mdi/js';
  import { locale, t } from 'svelte-i18n';

  type Props = {
    wallet: CloudMlWalletDto | null;
    /** The linked account can be changed and asked; false while not linked or not answering. */
    ready: boolean;
    onChanged?: (wallet: CloudMlWalletDto) => void;
    /** The Add credit dialog; the page's hero opens it too. */
    topUpOpen?: boolean;
  };

  let { wallet, ready, onChanged, topUpOpen = $bindable(false) }: Props = $props();

  let saving = $state(false);
  // Follows the wallet as the cloud reports it, and holds what is typed until it is sent.
  let capInput = $derived(
    wallet?.dailyCapUsd === null || wallet?.dailyCapUsd === undefined ? '' : String(wallet.dailyCapUsd),
  );

  let pack = $state<string>(DEFAULT_WALLET_PACK);
  let custom = $state('');

  const available = $derived(walletAvailable(wallet));
  const amount = $derived(
    pack === 'custom' ? Number(custom) : (walletPacks.find((entry) => entry.id === pack)?.amount ?? 0),
  );
  const checkout = $derived(topUpCheckoutUrl(wallet?.topUpUrl, amount));

  // Shown when an increase was asked for here: it is made in the Frameleaf account instead.
  let increaseAsked = $state(false);

  const save = async (change: { dailyCapUsd?: number; autoTopUp?: boolean }) => {
    saving = true;
    try {
      const next = await updateCloudMlWallet({ cloudMlWalletUpdateDto: change });
      onChanged?.(next);
    } catch (error) {
      if (isStepUpRequired(error)) {
        increaseAsked = true;
        // the refusal may have named the account page; read the wallet again to link to it
        try {
          onChanged?.(await getCloudMlWallet());
        } catch {
          // the explanation stands without the link
        }
      } else {
        handleError(error, $t('admin.frameleaf_cloud_ml_wallet_error'));
      }
    } finally {
      saving = false;
    }
  };

  const saveCap = () => {
    const value = Number(capInput);
    if (!Number.isFinite(value) || value < 1 || value > 1000 || value === wallet?.dailyCapUsd) {
      return;
    }
    if (!canLowerCap(wallet?.dailyCapUsd, value)) {
      // raising the cap is the account owner's, in the Frameleaf account
      increaseAsked = true;
      capInput = wallet?.dailyCapUsd === null || wallet?.dailyCapUsd === undefined ? '' : String(wallet.dailyCapUsd);
      return;
    }
    increaseAsked = false;
    void save({ dailyCapUsd: value });
  };
</script>

<!-- Rows of the page's Spending section (the prototype's Processing › Spending). -->
{#if wallet}
  <Row
    label={$t('frameleaf_cp_credit')}
    help={`${$t('frameleaf_cp_wallet_credit_help', {
      values: {
        available: formatUsd(available),
        held: formatUsd(wallet.heldUsd),
        balance: formatUsd(wallet.balanceUsd),
      },
    })} ${$t('admin.frameleaf_cloud_ml_wallet_top_up_rules', {
      values: { min: formatUsd(WALLET_MIN_TOP_UP_USD, 0), max: formatUsd(WALLET_MAX_TOP_UP_USD, 0) },
    })} ${$t('admin.frameleaf_cloud_ml_wallet_fees')} ${$t('admin.frameleaf_cloud_ml_wallet_updated', {
      values: { date: formatDateTime(wallet.updatedAt, $locale) },
    })}`}
  >
    <Button
      variant={available < 1 ? 'primary' : 'default'}
      disabled={!ready || !wallet.topUpUrl}
      onclick={() => {
        pack = DEFAULT_WALLET_PACK;
        custom = '';
        topUpOpen = true;
      }}
    >
      {$t('admin.frameleaf_cloud_ml_wallet_add_credit')}
    </Button>
  </Row>
  <Row
    label={$t('admin.frameleaf_cloud_ml_wallet_daily_cap')}
    help={`${$t('admin.frameleaf_cloud_ml_wallet_daily_cap_help')} ${wallet.settingsUrl ? '' : $t('admin.frameleaf_cloud_ml_wallet_raise_cap_account')}`}
    link={wallet.settingsUrl
      ? { text: $t('admin.frameleaf_cloud_ml_wallet_raise_cap'), href: wallet.settingsUrl, external: true }
      : undefined}
  >
    <span class="fc-input-unit">
      <input
        class="fc-kit-number"
        type="number"
        min="1"
        max="1000"
        step="1"
        bind:value={capInput}
        aria-label={$t('admin.frameleaf_cloud_ml_wallet_daily_cap')}
        disabled={!ready || saving}
        onchange={saveCap}
      />
      <span>USD</span>
    </span>
  </Row>
  {#if increaseAsked}
    <p class="fc-refusal" role="alert">{$t('admin.frameleaf_cloud_ml_wallet_step_up')}</p>
  {/if}
  <Row
    label={$t('admin.frameleaf_cloud_ml_wallet_auto_top_up')}
    help={wallet.autoTopUp || wallet.settingsUrl
      ? $t('admin.frameleaf_cloud_ml_wallet_auto_top_up_help')
      : `${$t('admin.frameleaf_cloud_ml_wallet_auto_top_up_help')} ${$t('admin.frameleaf_cloud_ml_wallet_auto_top_up_turn_on_account')}`}
    link={!wallet.autoTopUp && wallet.settingsUrl
      ? { text: $t('admin.frameleaf_cloud_ml_wallet_auto_top_up_turn_on'), href: wallet.settingsUrl, external: true }
      : undefined}
  >
    <!-- Only turning it off happens here; turning it on is in the Frameleaf account. -->
    <Switch
      label={$t('admin.frameleaf_cloud_ml_wallet_auto_top_up')}
      checked={wallet.autoTopUp}
      held={!ready || saving || !wallet.autoTopUp}
      onChange={(value) => {
        if (!value) {
          void save({ autoTopUp: false });
        }
      }}
    />
  </Row>
{:else}
  <Row label={$t('frameleaf_cp_credit')} help={$t('admin.frameleaf_cloud_ml_wallet_unknown')} />
{/if}

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
