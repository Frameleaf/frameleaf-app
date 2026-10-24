<script lang="ts">
  /**
   * Settings → Frameleaf Cloud → Licence (FL-156; FL-541 after the prototype's
   * `settings-v2/cloud/Licence.jsx`): opens on what the licence decides — backups away from home,
   * for everyone, for one person, or not yet — with Cloud Backup and Buddy Backup said underneath.
   * One key box recognises a Server or an Individual key and says what it will do before anything
   * changes. A server with no internet connection (offline file, server ID, Check now) is under a
   * closed Advanced.
   *
   * ponytail: who is covered is read from the licence kind here (Server: everyone; Individual: the
   * administrator's own account). The cover Frameleaf Cloud reports per account waits on FC-147/FC-148.
   */
  import './cloud-account.css';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import Skeleton from '$lib/components/frameleaf/Skeleton.svelte';
  import LicenseKeyField from '$lib/components/frameleaf/cloud/LicenseKeyField.svelte';
  import Advanced from '$lib/components/frameleaf/settings/kit/Advanced.svelte';
  import Coverage, { type CoverageRow } from '$lib/components/frameleaf/settings/kit/Coverage.svelte';
  import Facts from '$lib/components/frameleaf/settings/kit/Facts.svelte';
  import Hero from '$lib/components/frameleaf/settings/kit/Hero.svelte';
  import Item from '$lib/components/frameleaf/settings/kit/Item.svelte';
  import ItemList from '$lib/components/frameleaf/settings/kit/ItemList.svelte';
  import KitPage from '$lib/components/frameleaf/settings/kit/KitPage.svelte';
  import Notice from '$lib/components/frameleaf/settings/kit/Notice.svelte';
  import Row from '$lib/components/frameleaf/settings/kit/Row.svelte';
  import Said from '$lib/components/frameleaf/settings/kit/Said.svelte';
  import Section from '$lib/components/frameleaf/settings/kit/Section.svelte';
  import { discountOffer, type ProductKeyCheck } from '$lib/frameleaf/cloud';
  import { commandCenterUrl } from '$lib/frameleaf/settings-areas';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { cloudManager } from '$lib/managers/cloud-manager.svelte';
  import { Route } from '$lib/route';
  import { locale } from '$lib/stores/preferences.store';
  import { copyToClipboard } from '$lib/utils';
  import { getServerErrorMessage } from '$lib/utils/handle-error';
  import { deleteUserLicense, getMyUser, setUserLicense } from '@frameleaf/sdk';
  import {
    mdiBackupRestore,
    mdiCertificateOutline,
    mdiCloudOutline,
    mdiHandshakeOutline,
    mdiHeartOutline,
    mdiInfinity,
    mdiTagOutline,
  } from '@mdi/js';
  import { goto } from '$app/navigation';
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';

  onMount(() => cloudManager.listen());

  const license = $derived(cloudManager.license);
  const key = $derived(license?.key ?? null);
  const keyActive = $derived(!!key && (key.state === 'active' || key.state === 'grace'));
  // FL-156: a key for one person (the administrator's own) is an Individual licence
  const personal = $derived(authManager.user.license ?? null);
  const serverCover = $derived(keyActive && key?.kind !== 'individual');
  const oneCover = $derived(!serverCover && (!!personal || (keyActive && key?.kind === 'individual')));
  const licensed = $derived(serverCover || oneCover);
  const me = $derived(authManager.user.name);
  const offered = $derived(cloudManager.products?.licensedDiscount ?? 0);
  const offer = $derived(discountOffer(cloudManager.products));

  let keyValue = $state('');
  let keyCheck = $state<ProductKeyCheck | null>(null);
  /** Which key the Remove dialog is about: this server's key or the administrator's own. */
  let removingKey = $state<'server' | 'personal' | null>(null);
  const removing = $derived(removingKey !== null);
  let busy = $state(false);
  let notice = $state('');
  let failure = $state('');
  let fileInput = $state<HTMLInputElement>();

  const formatDate = (value: string | null | undefined) =>
    value ? new Intl.DateTimeFormat($locale, { dateStyle: 'long' }).format(new Date(value)) : '—';
  const formatWhen = (value: string | null | undefined) =>
    value ? new Intl.DateTimeFormat($locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) : '—';

  const act = async (call: (isCurrent: () => boolean) => Promise<unknown>, success: string) => {
    const isCurrent = authManager.captureSession();
    busy = true;
    failure = '';
    try {
      await call(isCurrent);
      if (!isCurrent()) {
        return false;
      }
      notice = success;
      return true;
    } catch (error) {
      if (!isCurrent()) {
        return false;
      }
      failure = getServerErrorMessage(error) ?? $t('frameleaf_cloud_action_failed');
      return false;
    } finally {
      busy = false;
    }
  };

  const refreshMe = async (isCurrent: () => boolean) => {
    if (!isCurrent()) {
      return;
    }
    const updated = await getMyUser();
    if (isCurrent()) {
      authManager.setUser(updated);
    }
  };

  const activate = async () => {
    const individual = keyCheck?.valid && keyCheck.kind === 'individual';
    // a key for one person is the administrator's own supporter key (personal endpoint)
    const done = individual
      ? await act(async (isCurrent) => {
          await setUserLicense({ licenseActivateDto: { key: keyValue } });
          await refreshMe(isCurrent);
        }, $t('frameleaf_license_personal_activated_notice'))
      : await act(() => cloudManager.activateLicense(keyValue), $t('frameleaf_license_activated_notice'));
    if (done) {
      keyValue = '';
    }
  };

  const installFile = async (file: File | undefined) => {
    if (!file) {
      return;
    }
    let text: string;
    try {
      text = await file.text();
    } catch {
      failure = $t('frameleaf_license_file_unreadable');
      return;
    }
    await act(() => cloudManager.installLicenseFile(text), $t('frameleaf_license_file_installed'));
  };

  const stateLabel = (state: string | undefined) =>
    state === 'active'
      ? $t('frameleaf_license_state_active')
      : state === 'grace'
        ? $t('frameleaf_license_state_grace')
        : state === 'expired'
          ? $t('frameleaf_license_state_expired')
          : state === 'invalid'
            ? $t('frameleaf_license_state_invalid')
            : $t('frameleaf_license_state_none');

  const hero = $derived(
    serverCover
      ? { tone: 'good' as const, title: $t('frameleaf_lic_hero_everyone'), body: $t('frameleaf_lic_hero_everyone_body') }
      : oneCover
        ? {
            tone: 'warn' as const,
            title: $t('frameleaf_lic_hero_one', { values: { name: me } }),
            body: $t('frameleaf_lic_hero_one_body'),
          }
        : { tone: 'warn' as const, title: $t('frameleaf_lic_hero_none'), body: $t('frameleaf_lic_hero_none_body') },
  );

  const coverage = $derived<CoverageRow[]>([
    {
      icon: mdiCloudOutline,
      name: $t('frameleaf_lic_cloud_backup'),
      detail: $t('frameleaf_lic_cloud_backup_detail'),
      ...(serverCover
        ? { tone: 'good' as const, value: $t('frameleaf_lic_everyone') }
        : oneCover
          ? { tone: 'warn' as const, value: $t('frameleaf_lic_only', { values: { name: me } }) }
          : { tone: 'off' as const, value: $t('frameleaf_lic_not_included') }),
    },
    {
      icon: mdiHandshakeOutline,
      name: $t('frameleaf_lic_buddy_backup'),
      detail: $t('frameleaf_lic_buddy_backup_detail'),
      ...(serverCover
        ? { tone: 'good' as const, value: $t('frameleaf_lic_everyone') }
        : { tone: 'off' as const, value: $t('frameleaf_lic_not_included') }),
      note: oneCover ? $t('frameleaf_lic_needs_server') : undefined,
    },
  ]);

  const whoTone = $derived(serverCover ? 'good' : oneCover ? 'warn' : 'off');
  const whoStatus = $derived(
    serverCover
      ? $t('frameleaf_lic_everyone')
      : oneCover
        ? $t('frameleaf_lic_only', { values: { name: me } })
        : $t('frameleaf_lic_not_included'),
  );
</script>

<div data-section="cloud-license">
  <KitPage>
    <Said message={notice} onDismiss={() => (notice = '')} />
    {#if failure}
      <Notice tone="warn" title={failure} />
    {/if}

    {#if !license}
      <div role="status" aria-label={$t('frameleaf_cloud_loading')}>
        <Skeleton variant="block" height="168px" />
      </div>
    {:else}
      {#if license.state === 'grace'}
        <Notice tone="warn" title={$t('frameleaf_license_grace_title')}>
          {$t('frameleaf_license_grace_body', { values: { date: formatDate(license.graceUntil) } })}
        </Notice>
      {:else if license.state === 'expired'}
        <Notice tone="warn" title={$t('frameleaf_license_expired_title')}>{$t('frameleaf_license_expired_body')}</Notice>
      {:else if license.state === 'invalid'}
        <Notice tone="warn" title={$t('frameleaf_license_invalid_title')}>{$t('frameleaf_license_invalid_body')}</Notice>
      {/if}

      <Hero label={$t('frameleaf_lic_status')} tone={hero.tone} icon={mdiCertificateOutline} title={hero.title} body={hero.body}>
        {#snippet actions()}
          {#if serverCover}
            <Button onclick={() => goto(commandCenterUrl('backup'))}>{$t('frameleaf_lic_open_backup')}</Button>
          {:else}
            <Button variant="primary" onclick={() => goto(Route.buy())}>{$t('frameleaf_license_buy')}</Button>
          {/if}
        {/snippet}
        <Coverage rows={coverage} />
      </Hero>

      <Section title={$t('frameleaf_lic_gives')} description={$t('frameleaf_lic_gives_description')}>
        <ItemList>
          <Item
            icon={mdiCloudOutline}
            name={$t('frameleaf_lic_gives_cloud')}
            detail={$t('frameleaf_lic_gives_cloud_detail')}
            tone={licensed ? 'good' : 'off'}
            status={licensed ? $t('frameleaf_lic_included') : $t('frameleaf_lic_not_included')}
            off={!licensed}
          />
          <Item
            icon={mdiBackupRestore}
            name={$t('frameleaf_lic_gives_backups')}
            detail={$t('frameleaf_lic_gives_backups_detail')}
            tone={whoTone}
            status={whoStatus}
            off={!licensed}
          />
          {#if offered > 0}
            <Item
              icon={mdiTagOutline}
              name={$t('frameleaf_lic_gives_discount')}
              detail={$t('frameleaf_lic_gives_discount_detail', {
                values: { server: offer.server, individual: offer.individual },
              })}
              tone={licensed ? 'good' : 'off'}
              status={serverCover
                ? $t('frameleaf_lic_off', { values: { pct: offer.server } })
                : oneCover
                  ? $t('frameleaf_lic_off', { values: { pct: offer.individual } })
                  : $t('frameleaf_lic_not_included')}
              off={!licensed}
            />
          {/if}
          <Item
            icon={mdiHeartOutline}
            name={$t('frameleaf_license_benefit_badge_title')}
            detail={$t('frameleaf_lic_gives_badge_detail')}
            tone={whoTone}
            status={whoStatus}
            off={!licensed}
          />
          <Item
            icon={mdiInfinity}
            name={$t('frameleaf_lic_gives_life')}
            detail={$t('frameleaf_lic_gives_life_detail')}
            off={!licensed}
          />
        </ItemList>
        <p class="hint">{$t('frameleaf_lic_without')}</p>
      </Section>

      <Section
        title={licensed || key ? $t('frameleaf_lic_yours') : $t('frameleaf_license_enter_key_title')}
        description={licensed || key ? undefined : $t('frameleaf_lic_enter_description')}
      >
        {#if key}
          <Facts
            rows={[
              {
                label: $t('frameleaf_lic_kind'),
                value: key.kind === 'individual' ? $t('frameleaf_license_individual') : $t('frameleaf_license_server'),
                detail: stateLabel(key.state),
              },
              { label: $t('frameleaf_license_key'), value: `•••• ${key.keyHint ?? '—'}`, detail: $t('frameleaf_lic_key_email') },
              {
                label: $t('frameleaf_lic_added'),
                value: formatWhen(key.activatedAt),
                detail: key.graceUntil
                  ? $t('frameleaf_lic_grace_until', { values: { date: formatDate(key.graceUntil) } })
                  : undefined,
              },
            ]}
          />
          <div class="actions">
            <Button variant="danger" onclick={() => (removingKey = 'server')}>{$t('frameleaf_license_remove_action')}</Button>
          </div>
        {/if}
        {#if personal}
          <div aria-label={$t('frameleaf_license_personal_facts')} role="group">
            <Facts
              rows={[
                {
                  label: $t('frameleaf_lic_kind'),
                  value: $t('frameleaf_license_individual'),
                  detail: $t('frameleaf_lic_only', { values: { name: me } }),
                },
                { label: $t('frameleaf_license_key'), value: `•••• ${personal.keyHint}` },
                { label: $t('frameleaf_lic_added'), value: formatWhen(personal.activatedAt) },
              ]}
            />
          </div>
          <div class="actions">
            <Button variant="danger" onclick={() => (removingKey = 'personal')}
              >{$t('frameleaf_license_remove_personal_action')}</Button
            >
          </div>
        {/if}

        {#if !serverCover}
          <div class="frameleaf-cloud">
            <LicenseKeyField
              bind:value={keyValue}
              accept="any"
              label={oneCover ? $t('frameleaf_lic_enter_another') : $t('frameleaf_license_key')}
              help={oneCover ? $t('frameleaf_lic_enter_another_help') : $t('frameleaf_lic_enter_help')}
              onCheck={(check) => (keyCheck = check)}
            />
          </div>
          {#if !license.configured}
            <p class="hint">{$t('frameleaf_license_key_needs_cloud')}</p>
          {:else if keyCheck?.valid && keyCheck.kind === 'server'}
            <Notice icon={mdiCertificateOutline} title={$t('frameleaf_lic_typed_server')}>
              {$t('frameleaf_lic_typed_server_body')}
              {#snippet action()}
                <Button variant="primary" disabled={busy} onclick={() => void activate()}>{$t('frameleaf_lic_activate')}</Button>
              {/snippet}
            </Notice>
          {:else if keyCheck?.valid && keyCheck.kind === 'individual'}
            <Notice icon={mdiCertificateOutline} title={$t('frameleaf_lic_typed_individual')}>
              {$t('frameleaf_lic_typed_individual_body', { values: { name: me } })}
              {#snippet action()}
                <Button variant="primary" disabled={busy} onclick={() => void activate()}
                  >{$t('frameleaf_lic_activate_for', { values: { name: me } })}</Button
                >
              {/snippet}
            </Notice>
          {/if}
        {/if}

        <Advanced summary={$t('frameleaf_lic_offline')}>
          <p class="hint">{$t('frameleaf_lic_offline_body')}</p>
          <Row label={$t('frameleaf_lic_server_id')} help={$t('frameleaf_lic_server_id_help')}>
            <span class="copy">
              <code>{license.fingerprint.instanceId ?? '—'}</code>
              {#if license.fingerprint.instanceId}
                <Button onclick={() => copyToClipboard(license.fingerprint.instanceId ?? '')}>{$t('frameleaf_lic_copy')}</Button>
              {/if}
            </span>
          </Row>
          <Row label={$t('frameleaf_lic_file')} help={$t('frameleaf_lic_file_help')}>
            <input
              bind:this={fileInput}
              type="file"
              accept=".json,.lic,application/json"
              hidden
              onchange={(event) => {
                void installFile(event.currentTarget.files?.[0]);
                event.currentTarget.value = '';
              }}
            />
            <Button disabled={busy} onclick={() => fileInput?.click()}>{$t('frameleaf_license_choose_file')}</Button>
          </Row>
          {#if license.linked && (license.key || license.plan)}
            <Row
              label={$t('frameleaf_lic_last_checked')}
              help={license.refresh.lastError
                ? $t('frameleaf_license_refresh_failed', { values: { error: license.refresh.lastError } })
                : $t('frameleaf_lic_last_checked_help', {
                    values: { when: formatWhen(license.refresh.refreshedAt ?? key?.refreshedAt ?? key?.activatedAt) },
                  })}
            >
              <Button
                disabled={busy}
                onclick={() => void act(() => cloudManager.refreshLicense(), $t('frameleaf_license_refreshed'))}
                >{$t('frameleaf_lic_check_now')}</Button
              >
            </Row>
          {/if}
        </Advanced>
      </Section>
    {/if}
  </KitPage>
</div>

<Dialog
  bind:open={() => removing, (open) => (removingKey = open ? removingKey : null)}
  title={removingKey === 'personal' ? $t('frameleaf_license_remove_personal_title') : $t('frameleaf_license_remove_title')}
  closeLabel={$t('close')}
>
  <p>
    {removingKey === 'personal' ? $t('frameleaf_license_remove_personal_body') : $t('frameleaf_license_remove_body')}
  </p>
  {#snippet actions()}
    <Button onclick={() => (removingKey = null)}>{$t('frameleaf_lic_keep')}</Button>
    <Button
      variant="danger"
      disabled={busy}
      onclick={async () => {
        // a server key is removed from the server; a key for one person through the personal endpoint
        const removed =
          removingKey === 'personal'
            ? await act(async (isCurrent) => {
                await deleteUserLicense();
                await refreshMe(isCurrent);
              }, $t('frameleaf_license_personal_removed_notice'))
            : await act(() => cloudManager.removeLicenseKey(), $t('frameleaf_license_removed_notice'));
        if (removed) {
          removingKey = null;
        }
      }}
    >
      {$t('frameleaf_license_remove_confirm')}
    </Button>
  {/snippet}
</Dialog>

<style>
  .hint {
    margin: var(--fl-space-3) 0 0;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  .actions {
    display: flex;
    gap: var(--fl-space-2);
    margin: var(--fl-space-3) 0;
  }
  .copy {
    display: inline-flex;
    gap: var(--fl-space-2);
    align-items: center;
  }
  code {
    font-size: var(--fl-font-small);
    overflow-wrap: anywhere;
  }
</style>
