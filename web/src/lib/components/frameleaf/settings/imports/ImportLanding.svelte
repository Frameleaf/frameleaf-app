<script lang="ts">
  /**
   * Import & export (FL-365, the approved prototype's `settings-v2/library/importing.jsx`
   * `ImportHome`): the area (renamed from "Import & protection"; owner call defaulted on FL-365) opens
   * on what is coming in right now, then every way to bring photos in, each saying its own state and
   * opening the tool where it lives, then how to take a copy out, and one line for the commonest
   * wrong turn: backups are in Backup.
   *
   * Readings are this account's own imports (`listTakeoutImports`) and iCloud connections, and, for an
   * administrator, the server's added folders.
   */
  import { goto } from '$app/navigation';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Hero from '$lib/components/frameleaf/settings/kit/Hero.svelte';
  import KitPage from '$lib/components/frameleaf/settings/kit/KitPage.svelte';
  import Links, { type LinkRow } from '$lib/components/frameleaf/settings/kit/Links.svelte';
  import Notice from '$lib/components/frameleaf/settings/kit/Notice.svelte';
  import Section from '$lib/components/frameleaf/settings/kit/Section.svelte';
  import { commandCenterUrl } from '$lib/frameleaf/settings-areas';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { locale } from '$lib/stores/preferences.store';
  import {
    getAllLibraries,
    listICloudConnections,
    listTakeoutImports,
    TakeoutState,
    type ICloudConnectionsResponseDto,
    type LibraryResponseDto,
    type TakeoutResponseDto,
  } from '@frameleaf/sdk';
  import {
    mdiAlertCircleOutline,
    mdiCellphone,
    mdiCloudOutline,
    mdiExportVariant,
    mdiFolderOutline,
    mdiGoogle,
    mdiSync,
    mdiTrayArrowDown,
    mdiTruckOutline,
  } from '@mdi/js';
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';

  const isAdmin = $derived(authManager.user.isAdmin);
  let imports = $state<TakeoutResponseDto[] | null>(null);
  let icloud = $state<ICloudConnectionsResponseDto | null>(null);
  let libraries = $state<LibraryResponseDto[] | null>(null);

  onMount(() => {
    void listTakeoutImports()
      .then((value) => (imports = value))
      .catch(() => (imports = null));
    void listICloudConnections()
      .then((value) => (icloud = value))
      .catch(() => (icloud = null));
    if (authManager.user.isAdmin) {
      void getAllLibraries({})
        .then((value) => (libraries = value.filter((library) => !library.deletedAt)))
        .catch(() => (libraries = null));
    }
  });

  const RUNNING = new Set<TakeoutState>([TakeoutState.Queued, TakeoutState.Scanning, TakeoutState.Importing]);
  const count = (value: number) => new Intl.NumberFormat($locale).format(value);
  const day = (value: string) =>
    new Intl.DateTimeFormat($locale, { day: 'numeric', month: 'long' }).format(new Date(value));

  const running = $derived(imports?.find((item) => RUNNING.has(item.state)));
  const waiting = $derived(imports?.find((item) => item.state === TakeoutState.Review));
  const last = $derived(
    imports
      ?.filter((item) => item.state === TakeoutState.Completed)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0],
  );
  const fresh = $derived(!!imports && imports.length === 0);

  const googleBody = $derived(
    running
      ? $t('frameleaf_import_google_running', {
          values: { done: count(running.processed), total: count(running.total ?? 0) },
        })
      : waiting
        ? $t('frameleaf_import_google_waiting')
        : last
          ? $t('frameleaf_import_google_last', { values: { date: day(last.updatedAt), count: count(last.processed) } })
          : $t('frameleaf_import_google_new'),
  );
  const connected = $derived(icloud?.connections.filter((connection) => connection.state === 'connected') ?? []);
  const icloudBody = $derived(
    connected.length > 0
      ? $t('frameleaf_import_icloud_connected', { values: { count: connected.length } })
      : $t('frameleaf_import_icloud_new'),
  );
  const folderBody = $derived(
    libraries && libraries.length > 0
      ? $t('frameleaf_import_folder_connected', { values: { count: libraries.length } })
      : $t('frameleaf_import_folder_new'),
  );

  const inRows = $derived<LinkRow[]>([
    {
      icon: mdiGoogle,
      title: $t('frameleaf_import_google'),
      body: googleBody,
      href: commandCenterUrl('backup', 'takeout'),
    },
    {
      icon: mdiCloudOutline,
      title: $t('frameleaf_import_icloud'),
      body: icloudBody,
      href: commandCenterUrl('utilities', 'icloud'),
    },
    ...(isAdmin
      ? [
          {
            icon: mdiFolderOutline,
            title: $t('frameleaf_import_folder'),
            body: folderBody,
            href: commandCenterUrl('libraries'),
          },
        ]
      : []),
    {
      icon: mdiCellphone,
      title: $t('frameleaf_import_phone'),
      body: $t('frameleaf_import_phone_body'),
      href: commandCenterUrl('utilities', 'downloads'),
    },
  ]);
  const outRows = $derived<LinkRow[]>([
    {
      icon: mdiExportVariant,
      title: $t('frameleaf_import_export'),
      body: $t('frameleaf_import_export_body'),
      href: commandCenterUrl('backup', 'preservation'),
    },
    ...(isAdmin
      ? [
          {
            icon: mdiTruckOutline,
            title: $t('frameleaf_import_move'),
            body: $t('frameleaf_import_move_body'),
            href: commandCenterUrl('storage', 'migration'),
          },
        ]
      : []),
  ]);
</script>

<KitPage>
  {#if running}
    <Hero
      icon={mdiSync}
      label={$t('frameleaf_import_status')}
      title={$t('frameleaf_import_hero_running', {
        values: { done: count(running.processed), total: count(running.total ?? 0) },
      })}
      body={$t('frameleaf_import_hero_running_body')}
    >
      {#snippet actions()}
        <Button onclick={() => goto(commandCenterUrl('backup', 'takeout'))}>{$t('frameleaf_import_open')}</Button>
      {/snippet}
    </Hero>
  {:else if waiting}
    <Hero
      tone="warn"
      icon={mdiAlertCircleOutline}
      label={$t('frameleaf_import_status')}
      title={$t('frameleaf_import_hero_waiting')}
      body={$t('frameleaf_import_hero_waiting_body')}
    >
      {#snippet actions()}
        <Button variant="primary" onclick={() => goto(commandCenterUrl('backup', 'takeout'))}
          >{$t('frameleaf_import_open')}</Button
        >
      {/snippet}
    </Hero>
  {:else}
    <Hero
      icon={mdiTrayArrowDown}
      label={$t('frameleaf_import_status')}
      title={fresh ? $t('frameleaf_import_hero_new') : $t('frameleaf_import_hero_none')}
      body={fresh
        ? $t('frameleaf_import_hero_new_body')
        : last
          ? $t('frameleaf_import_hero_last', { values: { date: day(last.updatedAt), count: count(last.processed) } })
          : ''}
    />
  {/if}

  <Section title={$t('frameleaf_import_in_title')} description={$t('frameleaf_import_in_description')}>
    <Links rows={inRows} stacked />
  </Section>

  <Section title={$t('frameleaf_import_out_title')}>
    <Links rows={outRows} stacked />
    <div class="pad">
      <Notice title={$t('frameleaf_import_backups_title')}>
        {#snippet action()}
          <Button onclick={() => goto(commandCenterUrl('backups'))}>{$t('frameleaf_import_open_backup')}</Button>
        {/snippet}
        {$t('frameleaf_import_backups_body')}
      </Notice>
    </div>
  </Section>
</KitPage>

<style>
  .pad {
    padding: var(--fl-space-4) 0 var(--fl-space-5);
  }
</style>
