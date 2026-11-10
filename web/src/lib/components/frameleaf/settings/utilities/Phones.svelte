<script lang="ts">
  /**
   * Tools › Phones (FL-792, the prototype's `settings-v2/library/phones.jsx`, FL-766): each of your
   * phones' backup receipt (what is on the phone, what the server checked is safely there, what is
   * waiting and why), and for administrators everyone's phones as counts only. `&phone=<id>` opens
   * one phone's receipt. Starting a check stays on the phone, so there is no "Check now" here.
   *
   * The server sends a check's counts only to an unlocked session that sees every item (FL-771), so
   * a locked session is offered the PIN instead of being told "Not checked yet".
   */
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import LockedUnlockDialog from '$lib/components/frameleaf/LockedUnlockDialog.svelte';
  import BackLink from '$lib/components/frameleaf/settings/kit/BackLink.svelte';
  import Hero from '$lib/components/frameleaf/settings/kit/Hero.svelte';
  import Item from '$lib/components/frameleaf/settings/kit/Item.svelte';
  import ItemList from '$lib/components/frameleaf/settings/kit/ItemList.svelte';
  import KitPage from '$lib/components/frameleaf/settings/kit/KitPage.svelte';
  import Pill from '$lib/components/frameleaf/settings/kit/Pill.svelte';
  import Section from '$lib/components/frameleaf/settings/kit/Section.svelte';
  import {
    checkedWords,
    reasonBody,
    reasonName,
    receiptHeadline,
    receiptLine,
    receiptStatus,
    receiptTone,
  } from '$lib/components/frameleaf/settings/utilities/receipt-words';
  import {
    type ReasonKey,
    receiptReasons,
    receiptScope,
    receiptState,
    serverVerified,
    waitingTotal,
    worstFirst,
  } from '$lib/frameleaf/backup-receipt';
  import { utilitiesUrl } from '$lib/frameleaf/utilities';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { locale } from '$lib/stores/preferences.store';
  import { listAllBackupDevices, listBackupDevices, searchUsersAdmin, type BackupDeviceDto } from '@frameleaf/sdk';
  import { Icon } from '@frameleaf/ui';
  import {
    mdiAlertCircleOutline,
    mdiAlertOutline,
    mdiBatteryAlertVariantOutline,
    mdiBatteryCharging,
    mdiCellphone,
    mdiCellphoneCheck,
    mdiCellphoneInformation,
    mdiChevronRight,
    mdiClockOutline,
    mdiCloudDownloadOutline,
    mdiDeleteOutline,
    mdiFileVideoOutline,
    mdiHomeOutline,
    mdiLockOutline,
    mdiShieldCheckOutline,
    mdiShieldOutline,
    mdiWifi,
  } from '@mdi/js';
  import { DateTime } from 'luxon';
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';

  let phones = $state<BackupDeviceDto[] | null>(null);
  let everyone = $state<BackupDeviceDto[] | null>(null);
  let owners = $state<Record<string, string>>({});
  let scoped = $state(false);
  let failed = $state(false);
  let unlocking = $state(false);

  const load = async () => {
    failed = false;
    try {
      const { devices } = await listBackupDevices({ limit: 100 });
      scoped = await receiptScope(devices.find((device) => !device.lastCheck)?.id);
      phones = devices;
    } catch {
      failed = true;
      return;
    }
    if (authManager.user.isAdmin) {
      try {
        const [all, users] = await Promise.all([
          listAllBackupDevices({ limit: 200 }),
          searchUsersAdmin({}).catch(() => []),
        ]);
        everyone = all.devices;
        owners = Object.fromEntries(users.map((user) => [user.id, user.name]));
      } catch {
        everyone = null;
      }
    }
  };
  onMount(() => void load());

  const ago = (iso: string) => DateTime.fromISO(iso, { locale: $locale }).toRelative() ?? '';
  const number = (value: number) => value.toLocaleString($locale);
  const rows = $derived((phones ?? []).map((phone) => ({ phone, state: receiptState(phone, scoped) })));
  const worst = $derived(worstFirst(rows)[0]);
  const openId = $derived(page.url.searchParams.get('phone'));
  const opened = $derived(rows.find((row) => row.phone.id === openId));
  const phoneUrl = (id?: string) => utilitiesUrl('phones', { phone: id });

  const REASON_ICONS: Record<ReasonKey, string> = {
    wifi: mdiWifi,
    charging: mdiBatteryCharging,
    low_power: mdiBatteryAlertVariantOutline,
    home_or_direct: mdiHomeOutline,
    icloud_original: mdiCloudDownloadOutline,
    too_large: mdiFileVideoOutline,
    skipped_deleted: mdiDeleteOutline,
    error: mdiAlertOutline,
    not_on_server: mdiAlertCircleOutline,
    unknown: mdiClockOutline,
  };
  const iconFor = (state: string) =>
    state === 'safe'
      ? mdiShieldCheckOutline
      : state === 'locked'
        ? mdiLockOutline
        : state === 'never'
          ? mdiShieldOutline
          : mdiAlertCircleOutline;
</script>

{#snippet unlockButton()}
  <Button variant="primary" onclick={() => (unlocking = true)}>{$t('frameleaf_phones_unlock')}</Button>
{/snippet}

<KitPage>
  {#if failed}
    <Hero
      label={$t('frameleaf_phones_label')}
      tone="quiet"
      icon={mdiCellphone}
      title={$t('frameleaf_phones_unread')}
      body={$t('frameleaf_phones_unread_body')}
    >
      {#snippet actions()}
        <Button onclick={() => void load()}>{$t('frameleaf_phones_try_again')}</Button>
      {/snippet}
    </Hero>
  {:else if phones && opened}
    {@const { phone, state } = opened}
    {@const headline = receiptHeadline($t, phone, state)}
    {@const verified = serverVerified(phone)}
    {@const waiting = waitingTotal(phone)}
    {@const reasons = receiptReasons(phone)}
    <BackLink href={phoneUrl()} label={$t('frameleaf_phones_label')} />
    <header class="phone-heading">
      <h2>{phone.displayName}</h2>
      <p>{[phone.model, phone.platform].filter(Boolean).join(' · ')}</p>
    </header>
    <section
      class="receipt"
      class:is-good={receiptTone(state) === 'good'}
      class:is-warn={receiptTone(state) === 'warn'}
      aria-label={$t('frameleaf_phones_receipt_label')}
    >
      <div class="receipt-head">
        <span class="receipt-icon"><Icon icon={iconFor(state)} size="28" aria-hidden /></span>
        <div>
          <h3>{headline.title}</h3>
          <p>{headline.body}</p>
        </div>
      </div>
      <dl class="numbers">
        <div>
          <dt>{$t('frameleaf_phones_on_phone')}</dt>
          <dd>{phone.phoneItemCount === null ? $t('frameleaf_phones_not_sent') : number(phone.phoneItemCount)}</dd>
        </div>
        <div>
          <dt>{$t('frameleaf_phones_on_server')}</dt>
          <dd>
            {state === 'locked'
              ? $t('frameleaf_phones_status_locked')
              : verified === null
                ? $t('frameleaf_phones_receipt_never')
                : number(verified)}
          </dd>
        </div>
        <div>
          <dt>{$t('frameleaf_phones_waiting')}</dt>
          <dd>{waiting > 0 ? number(waiting) : $t('frameleaf_phones_none_waiting')}</dd>
        </div>
      </dl>
      {#if state === 'locked'}
        <div class="receipt-actions">{@render unlockButton()}</div>
      {:else}
        <p class="checked">
          <Icon icon={mdiClockOutline} size="16" aria-hidden />
          {$t('frameleaf_phones_checked_line', {
            values: { when: checkedWords($t, phone, state, ago) ?? '' },
          })}
        </p>
      {/if}
    </section>

    <Section
      title={$t('frameleaf_phones_reasons_title')}
      description={reasons.length > 0 ? $t('frameleaf_phones_reasons_description') : undefined}
    >
      {#if reasons.length > 0}
        <ul class="reasons">
          {#each reasons as reason (reason.key)}
            <li>
              <details>
                <summary>
                  <Icon icon={REASON_ICONS[reason.key]} size="20" aria-hidden />
                  <strong>{reasonName($t, reason.key)}</strong>
                  <span>{number(reason.count)}</span>
                </summary>
                <p>{reasonBody($t, reason.key)}</p>
              </details>
            </li>
          {/each}
        </ul>
      {:else}
        <p class="hint">{$t('frameleaf_phones_reasons_none')}</p>
      {/if}
    </Section>
  {:else if phones}
    {#if phones.length === 0}
      <Hero
        label={$t('frameleaf_mobile_phones')}
        tone="quiet"
        icon={mdiCellphone}
        title={$t('frameleaf_mobile_none')}
        body={$t('frameleaf_mobile_none_body')}
      />
    {:else if worst.state === 'safe'}
      <Hero
        label={$t('frameleaf_mobile_phones')}
        tone="good"
        icon={mdiCellphoneCheck}
        title={$t('frameleaf_phones_all_safe')}
        body={$t('frameleaf_phones_all_safe_body')}
      />
    {:else}
      {@const headline = receiptHeadline($t, worst.phone, worst.state)}
      <Hero
        label={$t('frameleaf_mobile_phones')}
        tone={worst.state === 'missing' || worst.state === 'stale' ? 'warn' : 'quiet'}
        icon={worst.state === 'locked' ? mdiLockOutline : mdiCellphoneInformation}
        title={worst.state === 'locked' ? headline.title : `${worst.phone.displayName}: ${headline.title}`}
        body={headline.body}
        actions={worst.state === 'locked' ? unlockButton : undefined}
      />
    {/if}

    <Section title={$t('frameleaf_mobile_phones')} description={$t('frameleaf_phones_yours_description')}>
      <ItemList>
        {#if rows.length > 0}
          {#each rows as { phone, state } (phone.id)}
            <Item
              icon={mdiCellphone}
              name={phone.displayName}
              detail={receiptLine($t, phone, state)}
              tone={receiptTone(state)}
              status={receiptStatus($t, phone, state)}
              note={checkedWords($t, phone, state, ago)}
            >
              {#snippet action()}
                <Button
                  label={$t('frameleaf_phones_open', { values: { name: phone.displayName } })}
                  onclick={() => goto(phoneUrl(phone.id))}
                >
                  {$t('frameleaf_phones_open_short')}
                  <Icon icon={mdiChevronRight} size="18" aria-hidden />
                </Button>
              {/snippet}
            </Item>
          {/each}
        {:else}
          <Item
            icon={mdiCellphone}
            quiet
            off
            name={$t('frameleaf_mobile_phones_none')}
            detail={$t('frameleaf_mobile_phones_none_detail')}
          />
        {/if}
      </ItemList>
    </Section>

    {#if everyone && everyone.length > 0}
      <Section title={$t('frameleaf_phones_everyone_title')} description={$t('frameleaf_phones_everyone_description')}>
        <div class="table" role="table" aria-label={$t('frameleaf_phones_everyone_title')}>
          <div role="row" class="table-head">
            <span role="columnheader">{$t('frameleaf_phones_column_phone')}</span>
            <span role="columnheader">{$t('frameleaf_phones_on_phone')}</span>
            <span role="columnheader">{$t('frameleaf_phones_on_server')}</span>
            <span role="columnheader">{$t('frameleaf_phones_waiting')}</span>
            <span role="columnheader">{$t('frameleaf_phones_column_check')}</span>
          </div>
          {#each everyone as phone (phone.id)}
            {@const state = receiptState(phone, scoped)}
            {@const verified = serverVerified(phone)}
            {@const waiting = waitingTotal(phone)}
            <div role="row">
              <span role="cell">
                <strong>{phone.displayName}</strong>
                {#if owners[phone.ownerId]}<small>{owners[phone.ownerId]}</small>{/if}
              </span>
              <span role="cell" data-label={$t('frameleaf_phones_on_phone')}
                >{phone.phoneItemCount === null ? $t('frameleaf_phones_not_sent') : number(phone.phoneItemCount)}</span
              >
              <span role="cell" data-label={$t('frameleaf_phones_on_server')}
                >{state === 'locked'
                  ? $t('frameleaf_phones_status_locked')
                  : verified === null
                    ? $t('frameleaf_phones_receipt_never')
                    : number(verified)}</span
              >
              <span role="cell" data-label={$t('frameleaf_phones_waiting')}
                >{waiting > 0 ? number(waiting) : $t('frameleaf_phones_none_waiting')}</span
              >
              <span role="cell" data-label={$t('frameleaf_phones_column_check')}>
                <Pill tone={receiptTone(state)}
                  >{phone.lastCheck ? ago(phone.lastCheck.completedAt) : receiptStatus($t, phone, state)}</Pill
                >
              </span>
            </div>
          {/each}
        </div>
      </Section>
    {/if}
  {/if}
</KitPage>

<LockedUnlockDialog bind:open={unlocking} onUnlocked={() => void load()} />

<style>
  .phone-heading h2 {
    margin: 0;
    font-size: var(--fl-font-title);
    font-weight: 600;
  }
  .phone-heading p {
    margin: var(--fl-space-1) 0 0;
    color: var(--fl-muted);
  }
  .receipt {
    display: grid;
    gap: 24px;
    padding: 24px;
    background: var(--fl-panel);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-card);
  }
  .receipt.is-warn {
    border-color: color-mix(in srgb, var(--fl-warning) 50%, var(--fl-border));
  }
  .receipt-head {
    display: grid;
    grid-template-columns: 56px minmax(0, 1fr);
    gap: var(--fl-space-4);
    align-items: center;
  }
  .receipt-head h3 {
    margin: 0;
    font-size: var(--fl-font-headline);
    font-weight: 600;
  }
  .receipt-head p {
    margin: var(--fl-space-1) 0 0;
    color: var(--fl-muted);
    line-height: 1.5;
  }
  .receipt-icon {
    display: grid;
    place-items: center;
    width: 56px;
    height: 56px;
    border-radius: var(--fl-radius-card);
    background: var(--fl-raised);
    color: var(--fl-muted);
  }
  .receipt.is-good .receipt-icon {
    color: var(--fl-accent);
    background: color-mix(in srgb, var(--fl-accent) 13%, transparent);
  }
  .receipt.is-warn .receipt-icon {
    color: var(--fl-warning);
    background: color-mix(in srgb, var(--fl-warning) 13%, transparent);
  }
  .numbers {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: var(--fl-space-4);
    margin: 0;
  }
  .numbers div {
    padding: var(--fl-space-4);
    border-radius: var(--fl-radius-control);
    background: var(--fl-raised);
  }
  .numbers dt {
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  .numbers dd {
    margin: 6px 0 0;
    font-size: var(--fl-font-title);
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }
  .checked {
    padding-top: var(--fl-space-4);
    border-top: 1px solid var(--fl-border);
    display: flex;
    align-items: center;
    gap: var(--fl-space-2);
    margin: 0;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  .receipt-actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--fl-space-3);
  }
  .reasons {
    display: grid;
    gap: var(--fl-space-2);
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .reasons details {
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
  }
  .reasons summary {
    display: grid;
    grid-template-columns: 20px minmax(0, 1fr) auto;
    align-items: center;
    gap: var(--fl-space-3);
    min-height: 52px;
    padding: 0 var(--fl-space-4);
    cursor: pointer;
    list-style: none;
  }
  .reasons summary::-webkit-details-marker {
    display: none;
  }
  .reasons summary:focus-visible {
    outline: var(--fl-focus-ring);
    outline-offset: var(--fl-focus-offset);
  }
  .reasons summary span {
    color: var(--fl-muted);
    font-variant-numeric: tabular-nums;
  }
  .reasons p {
    margin: 0;
    padding: 0 var(--fl-space-4) var(--fl-space-4) calc(20px + var(--fl-space-3) + var(--fl-space-4));
    color: var(--fl-muted);
    line-height: 1.5;
  }
  .hint {
    margin: 0;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  .table {
    display: grid;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
    overflow: hidden;
  }
  .table > div {
    display: grid;
    grid-template-columns: minmax(0, 1.6fr) repeat(3, minmax(0, 1fr)) minmax(0, 1.2fr);
    align-items: center;
    gap: var(--fl-space-4);
    padding: 14px var(--fl-space-4);
    border-top: 1px solid var(--fl-border);
    font-variant-numeric: tabular-nums;
  }
  .table > div:first-child {
    border-top: 0;
  }
  .table-head {
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
    background: var(--fl-raised);
  }
  .table small {
    display: block;
    color: var(--fl-muted);
  }
  @media (max-width: 720px) {
    .numbers {
      grid-template-columns: minmax(0, 1fr);
    }
    .table-head {
      display: none !important;
    }
    .table > div {
      grid-template-columns: minmax(0, 1fr);
      gap: var(--fl-space-2);
      padding: var(--fl-space-4);
    }
    .table > div:nth-child(2) {
      border-top: 0;
    }
    .table [data-label] {
      display: flex;
      justify-content: space-between;
      gap: var(--fl-space-3);
    }
    .table [data-label]::before {
      content: attr(data-label);
      color: var(--fl-muted);
    }
  }
</style>
