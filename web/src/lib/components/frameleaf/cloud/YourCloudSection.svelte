<script lang="ts">
  import { locale } from '$lib/stores/preferences.store';
  /**
   * Settings → Frameleaf Cloud → Your Frameleaf Cloud (FL-544): one page in place of Plan, Licence,
   * Support Frameleaf and Supporter (prototype `src/settings-v2/cloud/YourCloud.jsx`, branch
   * aj/cloud-one-step). The status, what Frameleaf Cloud adds with one action per row, and the
   * licence, key and file under Details. Buying happens through the Get Frameleaf Cloud sheet.
   */
  import './cloud-account.css';
  import { goto } from '$app/navigation';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import Skeleton from '$lib/components/frameleaf/Skeleton.svelte';
  import CloudBanner from '$lib/components/frameleaf/cloud/CloudBanner.svelte';
  import CloudCard from '$lib/components/frameleaf/cloud/CloudCard.svelte';
  import LicenseSection from '$lib/components/frameleaf/cloud/LicenseSection.svelte';
  import { cloudPlanPrice, formatUsd } from '$lib/frameleaf/cloud';
  import { FEATURES, gateButtonKey, haveFrom, missing, type CloudFeature } from '$lib/frameleaf/cloud-rules';
  import { commandCenterUrl } from '$lib/frameleaf/settings-areas';
  import { cloudManager } from '$lib/managers/cloud-manager.svelte';
  import { getCloudManager } from '$lib/managers/get-cloud-manager.svelte';
  import { getServerErrorMessage } from '$lib/utils/handle-error';
  import { getCloudMlStatus, type CloudMlStatusResponseDto } from '@frameleaf/sdk';
  import { Icon } from '@frameleaf/ui';
  import {
    mdiCloudCheckOutline,
    mdiCloudOutline,
    mdiCreationOutline,
    mdiCreditCardOutline,
    mdiDeleteOutline,
    mdiEarth,
    mdiOpenInNew,
    mdiRefresh,
    mdiShieldCheckOutline,
  } from '@mdi/js';
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';

  let cloudMl = $state<Pick<CloudMlStatusResponseDto, 'enabled' | 'wallet'> | null>(null);
  onMount(() => {
    const stop = cloudManager.listen();
    const load = async () => {
      try {
        cloudMl = await getCloudMlStatus();
      } catch {
        cloudMl = null;
      }
    };
    void load();
    return stop;
  });

  const status = $derived(cloudManager.status);
  const license = $derived(cloudManager.license);
  const products = $derived(cloudManager.products);
  const have = $derived(haveFrom(status, license, products, cloudMl?.wallet));
  const plan = $derived(license?.plan ?? null);
  const overdue = $derived(have.plan && plan?.state === 'grace');
  const lapsed = $derived(!!plan && (plan.state === 'expired' || plan.state === 'invalid'));

  const price = (id: string) => products?.products.find((product) => product.id === id)?.priceUsd ?? 0;
  const bundle = $derived(
    $t('frameleaf_gc_price_year', {
      values: {
        once: formatUsd(price('supporter-server')),
        renew: formatUsd(cloudPlanPrice(price('cloud-annual'), products?.licensedDiscount ?? 0)),
      },
    }),
  );
  const planWithLicence = $derived(
    formatUsd(
      cloudPlanPrice(
        price('cloud-annual'),
        have.licence === 'individual' ? (products?.individualDiscount ?? 0) : (products?.licensedDiscount ?? 0),
      ),
    ),
  );
  const formatDate = (value: string | null | undefined) =>
    value ? new Intl.DateTimeFormat($locale, { dateStyle: 'long' }).format(new Date(value)) : '—';
  const manageUrl = $derived(status?.manageUrl ?? products?.storeUrl ?? null);

  let removing = $state(false);
  let busy = $state(false);
  let notice = $state('');
  let failure = $state('');
  const act = async (call: () => Promise<unknown>, success: string) => {
    busy = true;
    failure = '';
    try {
      await call();
      notice = success;
      return true;
    } catch (error) {
      failure = getServerErrorMessage(error) ?? $t('frameleaf_cloud_action_failed');
      return false;
    } finally {
      busy = false;
    }
  };

  const getCloud = (feature: CloudFeature | null = null, page?: string) =>
    getCloudManager.open(feature, page ? { onDone: () => void goto(page) } : {});

  type Row = { id: CloudFeature; icon: string; on: boolean; page: string; note: string };
  const rows = $derived<Row[]>([
    {
      id: 'remote',
      icon: mdiEarth,
      on: !!status?.remoteAccessEnabled,
      page: commandCenterUrl('cloud', 'cloud-remote'),
      note: '',
    },
    {
      id: 'backup',
      icon: mdiShieldCheckOutline,
      // whether Cloud Backup is set up is the Backup page's to say; here it is ready once Frameleaf Cloud is
      on: false,
      page: commandCenterUrl('backups', 'cloud'),
      note: '',
    },
    {
      id: 'processing',
      icon: mdiCreationOutline,
      on: !!cloudMl?.enabled,
      page: commandCenterUrl('cloud', 'cloud-processing'),
      note: cloudMl?.wallet
        ? $t('frameleaf_yc_credit_left', { values: { amount: formatUsd(cloudMl.wallet.availableUsd) } })
        : '',
    },
  ]);
</script>

<div class="frameleaf-cloud" data-section="cloud-plan">
  {#if failure}
    <p class="fc-notice is-error" role="alert">{failure}</p>
  {/if}
  {#if notice}
    <p class="fc-notice" role="status">{notice}</p>
  {/if}

  {#if !status || !license || !products}
    <div class="fc-loading" role="status" aria-label={$t('frameleaf_cloud_loading')}>
      <Skeleton variant="block" height="168px" />
    </div>
  {:else if !have.configured}
    <CloudCard
      icon={mdiCloudOutline}
      title={$t('frameleaf_cloud_not_configured_title')}
      status={$t('frameleaf_cloud_status_not_configured')}
    />
  {:else}
    {#if !have.linked}
      <CloudCard
        icon={mdiCloudOutline}
        title={$t('frameleaf_yc_new_title')}
        description={$t('frameleaf_yc_new_body', { values: { price: bundle } })}
        status={$t('frameleaf_cloud_status_not_linked')}
      >
        <div class="fc-actions">
          <Button variant="primary" onclick={() => getCloud()}>{$t('frameleaf_get_cloud')}</Button>
        </div>
      </CloudCard>
    {:else if have.plan}
      <CloudCard
        icon={mdiCloudCheckOutline}
        title={overdue ? $t('frameleaf_yc_overdue_title') : $t('frameleaf_gc_done_title')}
        description={overdue
          ? $t('frameleaf_yc_overdue_body', { values: { date: formatDate(plan?.graceUntil) } })
          : $t('frameleaf_yc_active_body', {
              values: {
                account: status.account?.label ?? '',
                date: formatDate(plan?.expiresAt),
                price: planWithLicence,
              },
            })}
        status={overdue ? $t('frameleaf_license_state_grace') : $t('frameleaf_license_state_active')}
        tone={overdue ? 'warning' : 'ok'}
      >
        <div class="fc-actions">
          {#if manageUrl}
            <a class="fc-button" class:is-primary={overdue} href={manageUrl} target="_blank" rel="noopener noreferrer">
              <Icon icon={mdiOpenInNew} size="18" />
              {overdue ? $t('frameleaf_yc_update_payment') : $t('frameleaf_yc_manage')}
            </a>
          {/if}
          <Button
            disabled={busy}
            onclick={() => void act(() => cloudManager.refreshLicense(), $t('frameleaf_license_refreshed'))}
          >
            <Icon icon={mdiRefresh} size="18" />
            {$t('frameleaf_yc_check_in')}
          </Button>
        </div>
      </CloudCard>
    {:else}
      <CloudCard
        icon={have.licence === 'none' ? mdiCloudOutline : mdiCreditCardOutline}
        title={have.licence === 'none' ? $t('frameleaf_yc_linked_title') : $t('frameleaf_yc_licence_title')}
        description={have.licence === 'none'
          ? $t('frameleaf_yc_linked_body', { values: { account: status.account?.label ?? '', price: bundle } })
          : $t('frameleaf_yc_licence_body', { values: { price: planWithLicence } })}
        status={have.licence === 'none' ? $t('frameleaf_plan_status_none') : $t('frameleaf_yc_licence_status')}
        tone={have.licence === 'none' ? 'muted' : 'warning'}
      >
        {#if lapsed}
          <CloudBanner tone="danger" title={$t('frameleaf_license_expired_title')}
            >{$t('frameleaf_license_expired_body')}</CloudBanner
          >
        {/if}
        <div class="fc-actions">
          <Button variant="primary" onclick={() => getCloud()}>{$t('frameleaf_get_cloud')}</Button>
        </div>
      </CloudCard>
    {/if}

    <CloudCard
      title={$t('frameleaf_yc_adds_title')}
      description={have.plan ? $t('frameleaf_yc_adds_ready') : $t('frameleaf_yc_adds_body')}
    >
      <ul class="yc-rows">
        {#each rows as row (row.id)}
          {@const spec = FEATURES[row.id]}
          {@const lacks = missing(row.id, have)}
          <li class:is-off={lacks.length > 0 || !row.on}>
            <span class="yc-icon"><Icon icon={row.icon} size="20" /></span>
            <div class="yc-text">
              <strong>{$t(spec.nameKey)}</strong>
              <span>{$t(spec.whyKey)}</span>
            </div>
            <div class="yc-status">
              {#if lacks.length > 0}
                <span class="fc-status"
                  >{lacks.includes('credit') && lacks.length === 1
                    ? $t('frameleaf_yc_no_credit')
                    : $t('frameleaf_yc_part_of')}</span
                >
              {:else if row.on}
                <span class="fc-status is-ok">{$t('frameleaf_yc_on')}</span>
                {#if row.note}<small>{row.note}</small>{/if}
              {:else}
                <span class="fc-status">{$t('frameleaf_yc_ready')}</span>
              {/if}
            </div>
            <div class="yc-action">
              {#if lacks.length > 0}
                <Button
                  variant={lacks.includes('credit') && lacks.length === 1 ? 'primary' : 'default'}
                  onclick={() => getCloud(row.id, row.page)}
                >
                  {$t(gateButtonKey(lacks))}
                </Button>
              {:else}
                {#if row.id === 'processing'}
                  <Button onclick={() => getCloud('processing')}>{$t('frameleaf_yc_add_credit')}</Button>
                {/if}
                <a class="fc-button" href={row.page}>{row.on ? $t('frameleaf_yc_open') : $t(spec.onKey)}</a>
              {/if}
            </div>
          </li>
        {/each}
      </ul>
      {#if have.linked && !have.plan}
        <p class="fc-note">
          {$t('frameleaf_yc_price_note', {
            values: {
              bundle,
              me: formatUsd(price('supporter-individual')),
              monthly: formatUsd(cloudPlanPrice(price('cloud-monthly'), products.licensedDiscount)),
            },
          })}
        </p>
      {/if}
    </CloudCard>

    <details class="yc-details fl-continuous-corners">
      <summary>{$t('frameleaf_yc_details')}</summary>
      <p class="fc-muted">{$t('frameleaf_yc_details_body')}</p>
      <LicenseSection />
      <div class="fc-actions">
        {#if have.plan}
          <Button onclick={() => (removing = true)}>
            <Icon icon={mdiDeleteOutline} size="18" />
            {$t('frameleaf_yc_stop_here')}
          </Button>
        {/if}
        <a class="fc-button" href={commandCenterUrl('cloud', 'cloud-account')}
          >{$t('frameleaf_cc_section_cloud_account')}</a
        >
      </div>
    </details>
  {/if}
</div>

<Dialog bind:open={removing} title={$t('frameleaf_plan_remove_title')} closeLabel={$t('close')}>
  <p>{$t('frameleaf_plan_remove_body')}</p>
  {#snippet actions()}
    <Button onclick={() => (removing = false)}>{$t('frameleaf_cloud_cancel')}</Button>
    <Button
      variant="danger"
      disabled={busy}
      onclick={async () => {
        if (await act(() => cloudManager.removePlan(), $t('frameleaf_plan_removed_notice'))) {
          removing = false;
        }
      }}
    >
      {$t('frameleaf_plan_remove_confirm')}
    </Button>
  {/snippet}
</Dialog>

<style>
  .yc-rows {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
  }
  .yc-rows > li {
    display: grid;
    grid-template-columns: auto minmax(0, 1.4fr) minmax(0, 1fr) auto;
    gap: 12px;
    align-items: center;
    padding: 14px 0;
  }
  .yc-rows > li + li {
    border-top: 1px solid var(--fl-border);
  }
  .yc-icon {
    display: grid;
    place-items: center;
    width: 36px;
    height: 36px;
    border-radius: var(--fl-radius-control);
    background: var(--fl-raised);
    color: var(--fl-accent);
  }
  .is-off .yc-icon {
    color: var(--fl-muted);
  }
  .yc-text {
    display: grid;
    gap: 2px;
    min-width: 0;
  }
  .yc-text strong {
    font-size: var(--fl-font-size);
  }
  .yc-text span {
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
    line-height: 1.4;
  }
  .yc-status {
    display: grid;
    gap: 4px;
    justify-items: start;
    min-width: 0;
  }
  .yc-status small {
    color: var(--fl-muted);
    font-size: var(--fl-font-micro);
  }
  .yc-action {
    display: flex;
    gap: 8px;
    justify-content: flex-end;
    flex-wrap: wrap;
  }
  .yc-details {
    margin-top: 16px;
    padding: 14px 16px;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-card);
    background: var(--fl-panel);
  }
  .yc-details > summary {
    cursor: pointer;
    font-weight: 600;
  }
  .yc-details > p {
    margin: 8px 0 0;
    font-size: var(--fl-font-small);
  }
  @media (max-width: 640px) {
    .yc-rows > li {
      grid-template-columns: auto minmax(0, 1fr);
    }
    .yc-status,
    .yc-action {
      grid-column: 2;
      justify-content: flex-start;
    }
  }
</style>
