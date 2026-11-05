<script lang="ts">
  /**
   * Settings → Frameleaf Cloud → Your Frameleaf Cloud (FL-544; rebuilt on the kit after the approved
   * prototype's Plan page, `settings-v2/cloud/Plan.jsx`). The plan's state first (with what it
   * covers under the hero), then what the plan gives, or the two ways to pay and what a plan does not
   * include, and a way to the Licence page (its own page again, as the prototype has it). Buying happens in the Get Frameleaf Cloud
   * sheet and the Frameleaf store, never on this server.
   *
   * Pricing (owner decision 2026-11-05): a Server licence ($100 once) comes first, then Frameleaf
   * Cloud is $9.99 a month for each TB; the licence's discount is what turns $99.90 a year into
   * $92.91. Every figure is read from `license/products`.
   */
  import './cloud-account.css';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import Skeleton from '$lib/components/frameleaf/Skeleton.svelte';
  import Advanced from '$lib/components/frameleaf/settings/kit/Advanced.svelte';
  import Coverage, { type CoverageRow } from '$lib/components/frameleaf/settings/kit/Coverage.svelte';
  import Facts from '$lib/components/frameleaf/settings/kit/Facts.svelte';
  import Hero from '$lib/components/frameleaf/settings/kit/Hero.svelte';
  import KitPage from '$lib/components/frameleaf/settings/kit/KitPage.svelte';
  import Notice from '$lib/components/frameleaf/settings/kit/Notice.svelte';
  import Points from '$lib/components/frameleaf/settings/kit/Points.svelte';
  import Row from '$lib/components/frameleaf/settings/kit/Row.svelte';
  import Said from '$lib/components/frameleaf/settings/kit/Said.svelte';
  import Section from '$lib/components/frameleaf/settings/kit/Section.svelte';
  import { cloudPlanPrice, discountPercent, formatUsd } from '$lib/frameleaf/cloud';
  import { haveFrom, type CloudFeature } from '$lib/frameleaf/cloud-rules';
  import { commandCenterUrl } from '$lib/frameleaf/settings-areas';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { cloudManager } from '$lib/managers/cloud-manager.svelte';
  import { getCloudManager } from '$lib/managers/get-cloud-manager.svelte';
  import { locale } from '$lib/stores/preferences.store';
  import { getServerErrorMessage } from '$lib/utils/handle-error';
  import { getCloudMlStatus, getRemoteAccess, type CloudMlStatusResponseDto } from '@frameleaf/sdk';
  import { Icon } from '@frameleaf/ui';
  import { mdiChevronRight, mdiCloudOffOutline, mdiCloudOutline, mdiCreditCardOutline, mdiEarth } from '@mdi/js';
  import { goto } from '$app/navigation';
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
  /** What the licence on this server takes off a plan; a server with none gets the Server licence's, as it buys one. */
  const share = $derived(
    have.licence === 'individual' ? (products?.individualDiscount ?? 0) : (products?.licensedDiscount ?? 0),
  );
  const prices = $derived({
    licence: formatUsd(price('supporter-server')),
    monthly: formatUsd(price('cloud-monthly')),
    yearlyFull: formatUsd(price('cloud-annual')),
    yearly: formatUsd(cloudPlanPrice(price('cloud-annual'), share)),
    pct: discountPercent(share),
    extra: formatUsd(products?.backup?.usdPerTbMonth ?? price('cloud-monthly')),
  });
  const licenceName = $derived(
    have.licence === 'individual' ? $t('frameleaf_yc_licence_individual') : $t('frameleaf_yc_licence_server'),
  );

  // FL-1197: the plan's name on frameleaf.net, changed on Remote access
  let nameAddress = $state<string | null>(null);
  $effect(() => {
    if (!have.plan) {
      nameAddress = null;
      return;
    }
    void getRemoteAccess()
      .then((remote) => (nameAddress = remote.frameleafNameAddress))
      .catch(() => (nameAddress = null));
  });
  const formatDate = (value: string | null | undefined) =>
    value ? new Intl.DateTimeFormat($locale, { dateStyle: 'long' }).format(new Date(value)) : '—';
  const formatWhen = (value: string | null | undefined) =>
    value ? new Intl.DateTimeFormat($locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) : '—';
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

  const hero = $derived.by(() => {
    if (overdue) {
      return {
        tone: 'warn' as const,
        title: $t('frameleaf_plan_hero_renew'),
        body: $t('frameleaf_plan_hero_renew_body', { values: { date: formatDate(plan?.graceUntil) } }),
      };
    }
    if (have.plan) {
      return {
        tone: 'good' as const,
        title: $t('frameleaf_plan_hero_active'),
        body: $t('frameleaf_yc_hero_active_body', {
          values: { account: status?.account?.label ?? '', date: formatDate(plan?.expiresAt) },
        }),
      };
    }
    const needs = have.licence === 'none' ? ` ${$t('frameleaf_yc_hero_needs_licence')}` : '';
    return {
      tone: 'quiet' as const,
      title: $t('frameleaf_plan_hero_none'),
      body: `${$t('frameleaf_plan_hero_none_body')}${needs}`,
    };
  });

  const coverage = $derived<CoverageRow[]>([
    {
      icon: mdiEarth,
      name: $t('frameleaf_plan_cover_remote'),
      detail: $t('frameleaf_plan_cover_remote_detail'),
      tone: overdue ? 'warn' : 'good',
      value: overdue
        ? $t('frameleaf_plan_cover_until', { values: { date: formatDate(plan?.graceUntil) } })
        : $t('frameleaf_plan_cover_remote_everyone'),
    },
    have.licence === 'server'
      ? {
          icon: mdiCloudOutline,
          name: $t('frameleaf_plan_cover_backup'),
          detail: $t('frameleaf_plan_cover_backup_everyone_detail'),
          tone: 'good',
          value: $t('frameleaf_plan_cover_backup_everyone'),
        }
      : have.licence === 'individual'
        ? {
            icon: mdiCloudOutline,
            name: $t('frameleaf_plan_cover_backup'),
            detail: $t('frameleaf_plan_cover_backup_one_detail'),
            tone: 'warn',
            value: $t('frameleaf_plan_cover_backup_one', { values: { name: authManager.user.name } }),
          }
        : {
            icon: mdiCloudOutline,
            name: $t('frameleaf_plan_cover_backup'),
            detail: $t('frameleaf_plan_cover_backup_waiting_detail'),
            tone: 'off',
            value: $t('frameleaf_plan_cover_backup_waiting'),
          },
  ]);

  /** What either way of paying gives (the prototype's GIVES). */
  const gives = $derived([
    { text: $t('frameleaf_yc_give_remote') },
    { text: $t('frameleaf_yc_give_storage') },
    { text: $t('frameleaf_yc_give_buddy') },
    { text: $t('frameleaf_plan_feature_servers') },
  ]);
  const ways = $derived([
    {
      id: 'monthly',
      tag: $t('frameleaf_yc_way_monthly_tag'),
      name: $t('frameleaf_yc_way_monthly'),
      price: $t('frameleaf_yc_way_monthly_price', { values: { price: prices.monthly } }),
      line: $t('frameleaf_yc_way_monthly_line'),
      primary: false,
    },
    {
      id: 'yearly',
      tag: $t('frameleaf_yc_way_yearly_tag'),
      name: $t('frameleaf_yc_way_yearly'),
      price: $t('frameleaf_yc_way_yearly_price', { values: { price: prices.yearly } }),
      line: $t('frameleaf_yc_way_yearly_line', {
        values: { full: prices.yearlyFull, pct: prices.pct, licence: licenceName },
      }),
      primary: true,
    },
  ]);
  const priceHint = $derived(
    have.licence === 'none'
      ? $t('frameleaf_yc_price_hint_new', {
          values: { licence: prices.licence, monthly: prices.monthly, yearly: prices.yearly, pct: prices.pct },
        })
      : $t('frameleaf_yc_price_hint_licensed', { values: { licence: licenceName, pct: prices.pct } }),
  );
</script>

<KitPage>
  {#if failure}
    <Notice tone="warn" title={$t('frameleaf_cloud_action_failed')}>{failure}</Notice>
  {/if}
  {#if notice}
    <Said message={notice} onDismiss={() => (notice = '')} />
  {/if}

  {#if !status || !license || !products}
    <div class="fc-loading" role="status" aria-label={$t('frameleaf_cloud_loading')}>
      <Skeleton variant="block" height="168px" />
    </div>
  {:else if !have.configured}
    <Hero
      label={$t('frameleaf_plan_status_label')}
      tone="quiet"
      icon={mdiCloudOffOutline}
      title={$t('frameleaf_cloud_not_configured_title')}
      body={$t('frameleaf_cloud_not_configured_description')}
    />
  {:else}
    <Hero
      label={$t('frameleaf_plan_status_label')}
      tone={hero.tone}
      icon={mdiCreditCardOutline}
      title={hero.title}
      body={hero.body}
    >
      {#snippet actions()}
        {#if have.plan && manageUrl}
          <a
            class="fl-control button"
            class:primary={overdue}
            href={manageUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            {overdue ? $t('frameleaf_yc_update_payment') : $t('frameleaf_plan_manage')}
          </a>
        {/if}
      {/snippet}
      {#if have.plan}
        <Coverage rows={coverage} />
      {/if}
    </Hero>

    {#if lapsed}
      <Notice tone="warn" title={$t('frameleaf_license_expired_title')}>{$t('frameleaf_license_expired_body')}</Notice>
    {/if}

    {#if have.plan}
      <Section title={$t('frameleaf_yc_gives')}>
        <p class="said">
          <strong>{$t('frameleaf_yc_gives_with_label')}</strong>
          {$t('frameleaf_yc_gives_with')}
          <strong>{$t('frameleaf_yc_gives_not_label')}</strong>
          {$t('frameleaf_yc_gives_not')}
        </p>
        <Row
          label={$t('frameleaf_yc_cost')}
          help={$t('frameleaf_yc_cost_help', {
            values: {
              monthly: prices.monthly,
              yearly: prices.yearly,
              full: prices.yearlyFull,
              pct: prices.pct,
              licence: licenceName,
            },
          })}
        />
        <Row
          label={$t('frameleaf_yc_name_label')}
          help={nameAddress
            ? $t('frameleaf_yc_name', { values: { address: nameAddress } })
            : $t('frameleaf_yc_name_none')}
        >
          <a class="fl-control button" href={commandCenterUrl('cloud', 'cloud-remote')}
            >{nameAddress ? $t('frameleaf_name_change') : $t('frameleaf_yc_name_choose')}</a
          >
        </Row>
        <Row
          label={$t('frameleaf_yc_backup')}
          help={have.licence === 'none' ? $t('frameleaf_yc_backup_needs_licence') : $t('frameleaf_yc_backup_help')}
        >
          {#if have.licence === 'none'}
            <Button onclick={() => getCloud('backup', commandCenterUrl('backups', 'cloud'))}
              >{$t('frameleaf_get_cloud')}</Button
            >
          {:else}
            <a class="fl-control button" href={commandCenterUrl('backups', 'cloud')}>{$t('frameleaf_yc_open_backup')}</a
            >
          {/if}
        </Row>
        <Row label={$t('frameleaf_yc_buddy')} help={$t('frameleaf_yc_buddy_help')}>
          <span class="value"
            >{have.licence === 'server' ? $t('frameleaf_yc_buddy_ready') : $t('frameleaf_yc_buddy_needs')}</span
          >
        </Row>
        <Row
          label={$t('frameleaf_yc_more_storage')}
          help={$t('frameleaf_yc_more_storage_help', { values: { price: prices.extra } })}
        >
          <span class="value">{$t('frameleaf_yc_more_storage_value')}</span>
        </Row>
        <Row label={$t('frameleaf_yc_stop')} help={$t('frameleaf_yc_stop_help')}>
          <Button variant="danger" onclick={() => (removing = true)}>{$t('frameleaf_yc_stop_action')}</Button>
        </Row>
        <Advanced>
          <Facts
            rows={[
              {
                label: $t('frameleaf_yc_last_checked'),
                value: formatWhen(license.refresh.refreshedAt ?? plan?.refreshedAt),
              },
              {
                label: $t('frameleaf_yc_came_from'),
                value: plan?.source === 'file' ? $t('frameleaf_plan_source_file') : $t('frameleaf_plan_source_account'),
              },
            ]}
          />
          <Row label={$t('frameleaf_yc_refresh')} help={$t('frameleaf_yc_refresh_help')}>
            <Button
              disabled={busy}
              onclick={() => void act(() => cloudManager.refreshLicense(), $t('frameleaf_license_refreshed'))}
              >{$t('frameleaf_yc_refresh_action')}</Button
            >
          </Row>
        </Advanced>
      </Section>
    {:else}
      <div class="ways">
        {#each ways as way (way.id)}
          <article class="way fl-continuous-corners" aria-labelledby="way-{way.id}">
            <span class="way-icon" aria-hidden="true"><Icon icon={mdiCreditCardOutline} size="22" /></span>
            <small>{way.tag}</small>
            <h3 id="way-{way.id}">{way.name}</h3>
            <p class="way-price">{way.price}</p>
            <p>{way.line}</p>
            <Points rows={gives} />
            <Button variant={way.primary ? 'primary' : 'default'} disabled={!have.store} onclick={() => getCloud()}
              >{$t('frameleaf_plan_checkout_title')}</Button
            >
          </article>
        {/each}
        <p class="hint">
          {have.store ? $t('frameleaf_yc_pay_in_store') : $t('frameleaf_plan_store_unavailable')}
          {priceHint}
          {$t('frameleaf_yc_price_hint_storage', { values: { price: prices.extra } })}
        </p>
      </div>

      <Section title={$t('frameleaf_yc_not_included')}>
        <Points
          rows={[
            { text: $t('frameleaf_yc_not_processing'), not: true },
            { text: $t('frameleaf_yc_not_licence'), not: true },
            { text: $t('frameleaf_yc_not_storage', { values: { price: prices.extra } }), not: true },
          ]}
        />
        <Row
          label={$t('frameleaf_yc_processing')}
          help={cloudMl?.wallet
            ? `${$t('frameleaf_yc_processing_help')} ${$t('frameleaf_yc_credit_left', { values: { amount: formatUsd(cloudMl.wallet.availableUsd) } })}`
            : $t('frameleaf_yc_processing_help')}
        >
          <Button onclick={() => getCloud('processing')}>{$t('frameleaf_add_ai_credit')}</Button>
          <a class="fl-control button" href={commandCenterUrl('cloud', 'cloud-processing')}
            >{$t('frameleaf_yc_open')}<Icon icon={mdiChevronRight} size="16" aria-hidden /></a
          >
        </Row>
      </Section>
    {/if}

    {#if have.plan}
      <Section title={$t('frameleaf_yc_processing')} description={$t('frameleaf_yc_processing_help')}>
        {#snippet action()}
          <Button onclick={() => getCloud('processing')}>{$t('frameleaf_yc_add_credit')}</Button>
          <a class="fl-control button" href={commandCenterUrl('cloud', 'cloud-processing')}
            >{$t('frameleaf_yc_open')}<Icon icon={mdiChevronRight} size="16" aria-hidden /></a
          >
        {/snippet}
      </Section>
    {/if}

    <Section
      title={$t('frameleaf_cc_section_cloud_license')}
      description={have.licence === 'server'
        ? $t('frameleaf_yc_licence_has_server')
        : have.licence === 'individual'
          ? $t('frameleaf_yc_licence_has_individual')
          : $t('frameleaf_yc_licence_has_none', { values: { price: prices.licence } })}
    >
      {#snippet action()}
        <a class="fl-control button" href={commandCenterUrl('cloud', 'cloud-license')}
          >{$t('frameleaf_cc_section_cloud_license')}<Icon icon={mdiChevronRight} size="16" aria-hidden /></a
        >
      {/snippet}
    </Section>
  {/if}
</KitPage>

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
  a.button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: var(--fl-space-1);
    text-decoration: none;
    white-space: nowrap;
  }
  .said {
    max-width: 720px;
    margin: 0;
    padding-bottom: var(--fl-space-5);
    font-size: var(--fl-font-callout);
    line-height: 1.5;
  }
  .said strong {
    font-weight: 600;
  }
  .value {
    color: var(--fl-muted);
    font-size: var(--fl-font-callout);
    text-align: end;
  }
  /* settings-v2 backup-v2.css `.bk2-choices` / `.bk2-choice`: the two ways to pay, side by side. */
  .ways {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: var(--fl-space-4);
  }
  .way {
    display: grid;
    gap: var(--fl-space-3);
    align-content: start;
    justify-items: start;
    min-width: 0;
    padding: var(--fl-space-6);
    background: var(--fl-panel);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-card);
  }
  .way :global(.kit-points) {
    padding-bottom: 0;
  }
  .way-icon {
    display: grid;
    place-items: center;
    width: 44px;
    height: 44px;
    color: var(--fl-accent);
    background: var(--fl-accent-soft);
    border-radius: var(--fl-radius-control);
  }
  .way small {
    margin-top: var(--fl-space-2);
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
    font-weight: 600;
    letter-spacing: 0.8px;
    text-transform: uppercase;
  }
  .way h3 {
    margin: 0;
    font-size: 16px;
    font-weight: 600;
  }
  .way p {
    margin: 0;
    color: var(--fl-muted);
    font-size: var(--fl-font-callout);
    line-height: 1.5;
  }
  .way .way-price {
    color: var(--fl-text);
    font: var(--fl-type-title);
    letter-spacing: var(--fl-tracking-title);
  }
  .hint {
    grid-column: 1 / -1;
    max-width: 820px;
    margin: 0;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
    line-height: 1.5;
  }
  @container kit (max-width: 620px) {
    .ways {
      grid-template-columns: 1fr;
    }
    .way {
      padding: var(--fl-space-4);
    }
    .value {
      text-align: start;
    }
  }
</style>
