<script lang="ts">
  /**
   * Your server › Frameleaf Cloud (FL-367, the approved prototype's `settings-v2/cloud/CloudLanding.jsx`).
   * It opens on one answer (linked and working, a plan that needs attention, not linked yet, or
   * turned off), then the things a household can obtain (account, plan, licence, AI credit) with
   * each one's state and what it costs, the extras they add, and what each feature needs. The states
   * are the ones the Frameleaf Cloud pages already read (`cloudManager`).
   *
   * Not here yet (Cloud-blocked, FC-147/FC-148): which accounts a licence covers for backups away
   * from home. The Cloud Backup row points to Backup, which says who is covered.
   */
  import { goto } from '$app/navigation';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Hero from '$lib/components/frameleaf/settings/kit/Hero.svelte';
  import Item from '$lib/components/frameleaf/settings/kit/Item.svelte';
  import ItemList from '$lib/components/frameleaf/settings/kit/ItemList.svelte';
  import KitPage from '$lib/components/frameleaf/settings/kit/KitPage.svelte';
  import type { KitTone } from '$lib/components/frameleaf/settings/kit/Pill.svelte';
  import Section from '$lib/components/frameleaf/settings/kit/Section.svelte';
  import { cloudNeeds, type NeedState } from '$lib/components/frameleaf/settings/cloud/cloud-landing';
  import { cloudGlance } from '$lib/frameleaf/overview-readiness';
  import { commandCenterUrl } from '$lib/frameleaf/settings-areas';
  import { cloudManager } from '$lib/managers/cloud-manager.svelte';
  import { locale } from '$lib/stores/preferences.store';
  import { LicenseKind } from '@frameleaf/sdk';
  import { Icon } from '@frameleaf/ui';
  import {
    mdiAccountCircleOutline,
    mdiCertificateOutline,
    mdiChevronRight,
    mdiCloudAlertOutline,
    mdiCloudCheckOutline,
    mdiCloudOffOutline,
    mdiCloudOutline,
    mdiCreationOutline,
    mdiCreditCardOutline,
    mdiEarth,
    mdiShieldCheckOutline,
    mdiWalletOutline,
  } from '@mdi/js';
  import { onMount } from 'svelte';
  import { t, type Translations } from 'svelte-i18n';

  onMount(() => cloudManager.listen());

  const status = $derived(cloudManager.status);
  const license = $derived(cloudManager.license);
  const glance = $derived(status ? cloudGlance(status, license) : null);
  const off = $derived(!!glance && !glance.configured);
  const linked = $derived(!!glance?.configured && glance.link === 'linked');
  const plan = $derived(glance?.configured ? glance.plan : 'none');
  const hasPlan = $derived(plan === 'active' || plan === 'grace');
  const planNeedsAttention = $derived(['grace', 'expired', 'invalid'].includes(plan));
  const licenceKind = $derived(license?.key?.kind ?? null);
  const date = (iso: string | null | undefined) =>
    iso ? new Intl.DateTimeFormat($locale, { dateStyle: 'long' }).format(new Date(iso)) : '';

  const hero = $derived.by(() => {
    if (off) {
      return {
        tone: 'quiet' as const,
        icon: mdiCloudOffOutline,
        title: $t('frameleaf_cloud_landing_off'),
        body: $t('frameleaf_cloud_landing_off_body'),
      };
    }
    if (!linked) {
      return {
        tone: 'quiet' as const,
        icon: mdiCloudOutline,
        title: $t('frameleaf_cloud_landing_unlinked'),
        body: $t('frameleaf_cloud_landing_unlinked_body'),
      };
    }
    if (planNeedsAttention) {
      return {
        tone: 'warn' as const,
        icon: mdiCloudAlertOutline,
        title: $t(`frameleaf_cloud_landing_plan_${plan}` as Translations),
        body: $t(`frameleaf_cloud_landing_plan_${plan}_body` as Translations, {
          values: { date: date(license?.graceUntil ?? license?.plan?.graceUntil) },
        }),
      };
    }
    return {
      tone: 'good' as const,
      icon: mdiCloudCheckOutline,
      title: $t('frameleaf_cloud_landing_ok'),
      body: status?.account?.label
        ? $t('frameleaf_cloud_landing_ok_body', {
            values: { account: status.account.label, since: date(status.linkedAt) },
          })
        : $t('frameleaf_cloud_landing_ok_body_plain'),
    };
  });

  type Row = {
    icon: string;
    name: string;
    detail: string;
    tone: KitTone;
    status: string;
    note?: string;
    cost?: string;
    href: string;
    action: string;
  };
  const have = $derived<Row[]>([
    {
      icon: mdiAccountCircleOutline,
      name: $t('frameleaf_cloud_landing_account'),
      detail: $t('frameleaf_cloud_landing_account_detail'),
      tone: linked ? 'good' : 'off',
      status: linked ? $t('frameleaf_cloud_landing_linked') : $t('frameleaf_cloud_landing_not_linked'),
      note: linked
        ? status?.account?.label
          ? $t('frameleaf_cloud_landing_linked_as', { values: { account: status.account.label } })
          : undefined
        : $t('frameleaf_cloud_landing_first_step'),
      cost: $t('frameleaf_cloud_landing_free'),
      href: commandCenterUrl('cloud', 'cloud-account'),
      action: linked ? $t('frameleaf_cloud_landing_manage') : $t('frameleaf_cloud_landing_link'),
    },
    {
      icon: mdiCreditCardOutline,
      name: $t('frameleaf_cloud_landing_plan'),
      detail: $t('frameleaf_cloud_landing_plan_detail'),
      tone:
        plan === 'active'
          ? 'good'
          : plan === 'grace'
            ? 'warn'
            : plan === 'expired' || plan === 'invalid'
              ? 'bad'
              : 'off',
      status: $t(`frameleaf_cloud_landing_plan_state_${plan}` as Translations),
      note:
        plan === 'active' && license?.plan?.expiresAt
          ? $t('frameleaf_cloud_landing_renews', { values: { date: date(license.plan.expiresAt) } })
          : !hasPlan
            ? $t('frameleaf_cloud_landing_plan_only')
            : undefined,
      cost: $t('frameleaf_cloud_landing_plan_price'),
      href: commandCenterUrl('cloud', 'cloud-plan'),
      action: hasPlan ? $t('frameleaf_cloud_landing_manage') : $t('frameleaf_cloud_landing_see_plans'),
    },
    {
      icon: mdiCertificateOutline,
      name: $t('frameleaf_cloud_landing_licence'),
      detail: $t('frameleaf_cloud_landing_licence_detail'),
      tone: licenceKind ? 'good' : 'off',
      status:
        licenceKind === LicenseKind.Server
          ? $t('frameleaf_cloud_landing_licence_server')
          : licenceKind === LicenseKind.Individual
            ? $t('frameleaf_cloud_landing_licence_individual')
            : $t('frameleaf_cloud_landing_licence_none'),
      note: licenceKind ? $t('frameleaf_cloud_landing_licence_forever') : $t('frameleaf_cloud_landing_licence_once'),
      cost: $t('frameleaf_cloud_landing_licence_price'),
      href: commandCenterUrl('cloud', 'cloud-license'),
      action: licenceKind ? $t('frameleaf_cloud_landing_manage') : $t('frameleaf_cloud_landing_see_licences'),
    },
    {
      icon: mdiWalletOutline,
      name: $t('frameleaf_cloud_landing_credit'),
      detail: $t('frameleaf_cloud_landing_credit_detail'),
      tone: linked ? 'good' : 'off',
      status: linked ? $t('frameleaf_cloud_landing_credit_on') : $t('frameleaf_cloud_landing_credit_none'),
      cost: $t('frameleaf_cloud_landing_credit_price'),
      href: commandCenterUrl('cloud', 'cloud-processing'),
      action: linked ? $t('frameleaf_cloud_landing_manage') : $t('frameleaf_cloud_landing_see_how'),
    },
  ]);

  const adds = $derived<Row[]>([
    {
      icon: mdiEarth,
      name: $t('frameleaf_cloud_landing_remote'),
      detail: $t('frameleaf_cloud_landing_remote_detail'),
      tone: status?.remoteAccessEnabled && hasPlan ? 'good' : 'off',
      status: !hasPlan
        ? $t('frameleaf_cloud_landing_needs_plan')
        : status?.remoteAccessEnabled
          ? $t('frameleaf_cloud_landing_on')
          : $t('frameleaf_cloud_landing_off_state'),
      note: hasPlan ? undefined : $t('frameleaf_cloud_landing_home_works'),
      href: commandCenterUrl('cloud', 'cloud-remote'),
      action: $t('frameleaf_cloud_landing_open'),
    },
    {
      icon: mdiShieldCheckOutline,
      name: $t('frameleaf_cloud_landing_backups'),
      detail: $t('frameleaf_cloud_landing_backups_detail'),
      tone: 'off',
      status: $t('frameleaf_cloud_landing_backups_status'),
      href: commandCenterUrl('backups'),
      action: $t('frameleaf_cloud_landing_open'),
    },
    {
      icon: mdiCreationOutline,
      name: $t('frameleaf_cloud_landing_processing'),
      detail: $t('frameleaf_cloud_landing_processing_detail'),
      tone: linked ? 'good' : 'off',
      status: linked ? $t('frameleaf_cloud_landing_available') : $t('frameleaf_cloud_landing_processing_off'),
      href: commandCenterUrl('cloud', 'cloud-processing'),
      action: $t('frameleaf_cloud_landing_open'),
    },
  ]);

  const needs = $derived(cloudNeeds({ off, linked, hasPlan, licence: licenceKind }));
  const NEED_TONE: Record<NeedState, KitTone> = { have: 'good', not: 'off', always: 'good', partly: 'warn' };
</script>

{#snippet rows(list: Row[])}
  <ItemList>
    {#each list as row (row.name)}
      <Item
        icon={row.icon}
        off={row.tone === 'off'}
        name={row.name}
        detail={row.detail}
        tone={row.tone}
        status={row.status}
        note={row.note}
      >
        {#snippet measure()}
          {#if row.cost}<span class="cost">{row.cost}</span>{/if}
        {/snippet}
        {#snippet action()}
          <Button label={`${row.action}: ${row.name}`} onclick={() => goto(row.href)}
            >{row.action}<Icon icon={mdiChevronRight} size="1em" aria-hidden /></Button
          >
        {/snippet}
      </Item>
    {/each}
  </ItemList>
{/snippet}

<KitPage>
  <Hero
    tone={hero.tone}
    icon={hero.icon}
    title={hero.title}
    body={hero.body}
    label={$t('frameleaf_cloud_landing_status')}
  >
    {#snippet actions()}
      {#if off || !linked}
        <Button variant={off ? 'default' : 'primary'} onclick={() => goto(commandCenterUrl('cloud', 'cloud-account'))}
          >{off ? $t('frameleaf_cloud_landing_how_on') : $t('frameleaf_cloud_landing_link_server')}</Button
        >
      {:else if planNeedsAttention}
        <Button variant="primary" onclick={() => goto(commandCenterUrl('cloud', 'cloud-plan'))}
          >{$t('frameleaf_cloud_landing_see_plan')}</Button
        >
      {/if}
    {/snippet}
  </Hero>

  {#if !off}
    <Section title={$t('frameleaf_cloud_landing_have')} description={$t('frameleaf_cloud_landing_have_description')}>
      {@render rows(have)}
    </Section>
    <Section title={$t('frameleaf_cloud_landing_adds')} description={$t('frameleaf_cloud_landing_adds_description')}>
      {@render rows(adds)}
    </Section>
  {/if}

  <Section title={$t('frameleaf_cloud_landing_needs')} description={$t('frameleaf_cloud_landing_needs_description')}>
    <div class="table-wrap">
      <table class="needs">
        <thead>
          <tr>
            <th scope="col">{$t('frameleaf_cloud_landing_needs_want')}</th>
            <th scope="col">{$t('frameleaf_cloud_landing_needs_need')}</th>
            <th scope="col">{$t('frameleaf_cloud_landing_needs_here')}</th>
          </tr>
        </thead>
        <tbody>
          {#each needs as need (need.id)}
            <tr>
              <th scope="row">{$t(`frameleaf_cloud_need_${need.id}` as Translations)}</th>
              <td>{$t(`frameleaf_cloud_need_${need.id}_needs` as Translations)}</td>
              <td>
                <span class="state" data-tone={NEED_TONE[need.state]}
                  >{$t(`frameleaf_cloud_need_state_${need.state}` as Translations)}</span
                >
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  </Section>
</KitPage>

<style>
  .cost {
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  .table-wrap {
    overflow-x: auto;
    padding-bottom: var(--fl-space-5);
  }
  .needs {
    width: 100%;
    border-collapse: collapse;
    font-size: var(--fl-font-callout);
  }
  .needs th,
  .needs td {
    padding: var(--fl-space-3) var(--fl-space-3) var(--fl-space-3) 0;
    text-align: start;
    vertical-align: top;
    border-top: 1px solid var(--fl-border);
  }
  .needs thead th {
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
    font-weight: 500;
    border-top: 0;
  }
  .needs tbody th {
    font-weight: 600;
  }
  .needs td {
    color: var(--fl-muted);
  }
  .state {
    color: var(--fl-text);
    white-space: nowrap;
  }
  .state[data-tone='good'] {
    color: var(--fl-success, var(--fl-accent));
  }
  .state[data-tone='warn'] {
    color: var(--fl-warning);
  }
</style>
