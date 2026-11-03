<script lang="ts">
  /**
   * Import & export › Phones (FL-540, the prototype's "See phones", `backup › devices-backup`): every
   * account's phones that back up here (`listAllBackupDevices`, the app's own reports), longest quiet
   * first, so an administrator can see whose phone stopped sending photos. Getting the app and
   * connecting a phone stay on Utilities › Mobile apps.
   */
  import { goto } from '$app/navigation';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import { phonesBehind } from '$lib/components/frameleaf/settings/overview/overview';
  import Hero from '$lib/components/frameleaf/settings/kit/Hero.svelte';
  import Item from '$lib/components/frameleaf/settings/kit/Item.svelte';
  import ItemList from '$lib/components/frameleaf/settings/kit/ItemList.svelte';
  import KitPage from '$lib/components/frameleaf/settings/kit/KitPage.svelte';
  import Section from '$lib/components/frameleaf/settings/kit/Section.svelte';
  import { commandCenterUrl } from '$lib/frameleaf/settings-areas';
  import { locale } from '$lib/stores/preferences.store';
  import { listAllBackupDevices, searchUsersAdmin, type BackupDeviceDto } from '@frameleaf/sdk';
  import { mdiCellphone, mdiCellphoneCheck, mdiCellphoneRemove } from '@mdi/js';
  import { DateTime } from 'luxon';
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';

  let phones = $state<BackupDeviceDto[] | null>(null);
  let owners = $state<Record<string, string>>({});
  let failed = $state(false);

  onMount(() => {
    void (async () => {
      try {
        const [devices, users] = await Promise.all([
          listAllBackupDevices({ limit: 200 }),
          searchUsersAdmin({}).catch(() => []),
        ]);
        phones = devices.devices;
        owners = Object.fromEntries(users.map((user) => [user.id, user.name]));
      } catch {
        failed = true;
      }
    })();
  });

  const behind = $derived(phonesBehind(phones ?? []));
  const ordered = $derived(
    [...(phones ?? [])].sort(
      (a, b) => (b.quietForDays ?? -1) - (a.quietForDays ?? -1) || a.displayName.localeCompare(b.displayName),
    ),
  );
  const ago = (iso: string | null) => (iso ? (DateTime.fromISO(iso, { locale: $locale }).toRelative() ?? '') : '');
  const isBehind = (phone: BackupDeviceDto) => behind.some((item) => item.id === phone.id);
</script>

<KitPage>
  {#if failed}
    <Hero
      label={$t('frameleaf_phones_label')}
      tone="quiet"
      icon={mdiCellphone}
      title={$t('frameleaf_phones_unread')}
      body={$t('frameleaf_phones_unread_body')}
    />
  {:else if phones}
    <Hero
      label={$t('frameleaf_phones_label')}
      tone={phones.length === 0 ? 'quiet' : behind.length > 0 ? 'warn' : 'good'}
      icon={behind.length > 0 ? mdiCellphoneRemove : phones.length > 0 ? mdiCellphoneCheck : mdiCellphone}
      title={phones.length === 0
        ? $t('frameleaf_phones_none')
        : behind.length > 0
          ? $t('frameleaf_phones_behind', { values: { count: behind.length } })
          : $t('frameleaf_phones_ok', { values: { count: phones.length } })}
      body={phones.length === 0 ? $t('frameleaf_phones_none_body') : $t('frameleaf_phones_body')}
    >
      {#snippet actions()}
        <Button onclick={() => goto(commandCenterUrl('utilities', 'downloads'))}
          >{$t('frameleaf_phones_get_app')}</Button
        >
      {/snippet}
    </Hero>

    {#if phones.length > 0}
      <Section title={$t('frameleaf_phones_title')} description={$t('frameleaf_phones_description')}>
        <ItemList>
          {#each ordered as phone (phone.id)}
            <Item
              icon={mdiCellphone}
              name={phone.displayName}
              detail={[owners[phone.ownerId], phone.model, phone.platform].filter(Boolean).join(' · ')}
              tone={isBehind(phone) ? 'warn' : phone.lastSuccessfulBackupAt ? 'good' : 'off'}
              status={isBehind(phone)
                ? $t('frameleaf_phones_quiet', { values: { count: phone.quietForDays ?? 0 } })
                : phone.lastSuccessfulBackupAt
                  ? $t('frameleaf_phones_backing_up')
                  : $t('frameleaf_phones_not_yet')}
              note={phone.lastSuccessfulBackupAt
                ? $t('frameleaf_phones_last', { values: { ago: ago(phone.lastSuccessfulBackupAt) } })
                : undefined}
            />
          {/each}
        </ItemList>
        {#if behind.length > 0}
          <p class="hint">{$t('frameleaf_phones_behind_hint')}</p>
        {/if}
      </Section>
    {/if}
  {/if}
</KitPage>

<style>
  .hint {
    margin: var(--fl-space-3) 0 0;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
</style>
