<script lang="ts">
  /**
   * Utilities › Mobile apps, first screen (FL-539, after the prototype's `PhoneApps` in
   * `settings-v2/library/utilities.jsx`): whether a phone is backing up, the two stores, a code to
   * scan that fills in this server's address (the app still signs in with each person's own account),
   * and "Your phones", each person seeing only their own. Installing the Android file without a store
   * (FL-82, `ApplicationSetup`) is under Advanced.
   *
   * The code carries only this server's address (the public address when one is set, else the one
   * this page was opened at): never a password or a key.
   */
  import ApplicationSetup from '$lib/components/frameleaf/ApplicationSetup.svelte';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import QrCode from '$lib/components/frameleaf/QrCode.svelte';
  import Advanced from '$lib/components/frameleaf/settings/kit/Advanced.svelte';
  import Hero from '$lib/components/frameleaf/settings/kit/Hero.svelte';
  import Item from '$lib/components/frameleaf/settings/kit/Item.svelte';
  import ItemList from '$lib/components/frameleaf/settings/kit/ItemList.svelte';
  import KitPage from '$lib/components/frameleaf/settings/kit/KitPage.svelte';
  import Said from '$lib/components/frameleaf/settings/kit/Said.svelte';
  import Section from '$lib/components/frameleaf/settings/kit/Section.svelte';
  import { serverConfigManager } from '$lib/managers/server-config-manager.svelte';
  import { locale } from '$lib/stores/preferences.store';
  import { copyToClipboard } from '$lib/utils';
  import {
    getAppReleases,
    listBackupDevices,
    type BackupDeviceDto,
    type ServerAppReleasesResponseDto,
  } from '@frameleaf/sdk';
  import { Icon } from '@frameleaf/ui';
  import { mdiAndroid, mdiApple, mdiCellphone, mdiCellphoneCheck } from '@mdi/js';
  import { DateTime } from 'luxon';
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';

  let releases = $state<ServerAppReleasesResponseDto | null>(null);
  let phones = $state<BackupDeviceDto[] | null>(null);
  let said = $state('');

  onMount(() => {
    void getAppReleases()
      .then((answer) => (releases = answer))
      .catch(() => (releases = null));
    void listBackupDevices({ limit: 100 })
      .then(({ devices }) => (phones = devices))
      .catch(() => (phones = []));
  });

  const address = $derived(serverConfigManager.value.externalDomain || location.origin);
  const stores = $derived([
    {
      id: 'ios',
      icon: mdiApple,
      name: $t('frameleaf_mobile_ios'),
      body: $t('frameleaf_mobile_ios_body'),
      button: $t('frameleaf_mobile_ios_button'),
      url: releases?.ios.available ? releases.ios.url : undefined,
    },
    {
      id: 'android',
      icon: mdiAndroid,
      name: $t('frameleaf_mobile_android'),
      body: $t('frameleaf_mobile_android_body'),
      button: $t('frameleaf_mobile_android_button'),
      url: releases?.android.storeUrl,
    },
  ]);

  const ago = (iso: string | null) => (iso ? (DateTime.fromISO(iso, { locale: $locale }).toRelative() ?? '') : '');
  const newest = $derived(
    (phones ?? [])
      .filter((phone) => phone.lastSuccessfulBackupAt)
      .sort((a, b) => (b.lastSuccessfulBackupAt ?? '').localeCompare(a.lastSuccessfulBackupAt ?? ''))[0],
  );
  const copy = async () => {
    if (await copyToClipboard(address)) {
      said = $t('frameleaf_mobile_address_copied');
    }
  };
</script>

<KitPage>
  <Said message={said} onDismiss={() => (said = '')} />
  {#if phones !== null}
    <Hero
      label={$t('frameleaf_mobile_label')}
      icon={phones.length > 0 ? mdiCellphoneCheck : mdiCellphone}
      tone={phones.length > 0 ? 'good' : 'quiet'}
      title={phones.length > 0 ? $t('frameleaf_mobile_backing_up') : $t('frameleaf_mobile_none')}
      body={phones.length > 0
        ? newest
          ? $t('frameleaf_mobile_backing_up_body', {
              values: { name: newest.displayName, ago: ago(newest.lastSuccessfulBackupAt) },
            })
          : $t('frameleaf_mobile_backing_up_body_unknown')
        : $t('frameleaf_mobile_none_body')}
    />
  {/if}

  <div class="stores">
    {#each stores as store (store.id)}
      <article>
        <span class="store-icon"><Icon icon={store.icon} size="1.375rem" aria-hidden /></span>
        <h3>{store.name}</h3>
        <p>{store.body}</p>
        {#if store.url}
          <a class="button primary" href={store.url} target="_blank" rel="noreferrer">{store.button}</a>
        {:else}
          <p class="hint">{$t('frameleaf_mobile_store_missing')}</p>
        {/if}
      </article>
    {/each}
  </div>

  <Section title={$t('frameleaf_mobile_scan_title')} description={$t('frameleaf_mobile_scan_description')}>
    <div class="scan">
      <QrCode
        value={address}
        size={148}
        label={$t('frameleaf_mobile_scan_label')}
        copyLabel={$t('frameleaf_mobile_copy_address')}
        downloadLabel={$t('frameleaf_remote_qr_download')}
        errorLabel={$t('frameleaf_remote_qr_error')}
        showActions={false}
      />
      <div>
        <strong>{$t('frameleaf_mobile_cant_scan')}</strong>
        <p>{$t('frameleaf_mobile_type_address')}</p>
        <p class="mono">{address}</p>
        <Button onclick={copy}>{$t('frameleaf_mobile_copy_address')}</Button>
      </div>
    </div>
  </Section>

  <Section title={$t('frameleaf_mobile_phones')} description={$t('frameleaf_mobile_phones_description')}>
    <ItemList>
      {#if phones && phones.length > 0}
        {#each phones as phone (phone.id)}
          <Item
            icon={mdiCellphone}
            name={phone.displayName}
            detail={`${phone.model} · ${phone.platform}`}
            tone={phone.quietForDays !== null && phone.quietForDays >= 7 ? 'warn' : 'good'}
            status={phone.quietForDays !== null && phone.quietForDays >= 7
              ? $t('frameleaf_mobile_phone_quiet')
              : $t('frameleaf_mobile_phone_ok')}
            note={phone.lastSuccessfulBackupAt
              ? $t('frameleaf_mobile_phone_last', { values: { ago: ago(phone.lastSuccessfulBackupAt) } })
              : undefined}
          />
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
    <Advanced summary={$t('frameleaf_mobile_no_store')}>
      <ApplicationSetup tool="downloads" />
    </Advanced>
  </Section>
</KitPage>

<style>
  .stores {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(16rem, 1fr));
    gap: var(--fl-space-3);
  }
  .stores article {
    display: grid;
    align-content: start;
    justify-items: start;
    gap: var(--fl-space-2);
    padding: var(--fl-space-4);
    background: var(--fl-panel);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-card);
  }
  .store-icon {
    display: inline-grid;
    place-items: center;
    width: 2.5rem;
    height: 2.5rem;
    border-radius: var(--fl-radius-control);
    background: var(--fl-raised);
  }
  h3 {
    margin: 0;
    font-size: var(--fl-font-callout);
  }
  p {
    margin: 0;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  .scan {
    display: flex;
    flex-wrap: wrap;
    gap: var(--fl-space-4);
    align-items: center;
  }
  .scan > div {
    display: grid;
    justify-items: start;
    gap: var(--fl-space-2);
  }
  .mono {
    color: var(--fl-text);
    font-family: var(--fl-font-mono, ui-monospace, monospace);
    word-break: break-all;
  }
</style>
