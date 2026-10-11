<script lang="ts">
  /**
   * Settings › Backup (FL-362), after the approved prototype (`BackupV2.jsx`): one screen that
   * answers "am I protected?", lists every place a backup is kept, and has one place to restore.
   * Overview, Schedule and Restore sit side by side; each place a backup is kept (Cloud Backup, Buddy Backup,
   * On this server) is a page of its own, opened from the Overview and left with "‹ Backup".
   */
  import BackupLocalPage from '$lib/components/frameleaf/backup/BackupLocalPage.svelte';
  import BackupOverview from '$lib/components/frameleaf/backup/BackupOverview.svelte';
  import BackupSchedule from '$lib/components/frameleaf/backup/BackupSchedule.svelte';
  import BackupRestore from '$lib/components/frameleaf/backup/BackupRestore.svelte';
  import BuddyBackupSection from '$lib/components/frameleaf/cloud/BuddyBackupSection.svelte';
  import CloudBackupSection from '$lib/components/frameleaf/cloud/CloudBackupSection.svelte';
  import BackLink from '$lib/components/frameleaf/settings/kit/BackLink.svelte';
  import KitPage from '$lib/components/frameleaf/settings/kit/KitPage.svelte';
  import PageTabs from '$lib/components/frameleaf/settings/kit/PageTabs.svelte';
  import { BACKUP_TABS, backupPageUrl, type BackupPageId } from '$lib/frameleaf/settings-areas';
  import { t, type Translations } from 'svelte-i18n';

  let { page }: { page: BackupPageId } = $props();

  const TAB_LABELS: Record<(typeof BACKUP_TABS)[number], Translations> = {
    overview: 'frameleaf_backup_tab_overview',
    schedule: 'frameleaf_backup_tab_schedule',
    restore: 'frameleaf_backup_tab_restore',
  };
  const tabs = $derived(BACKUP_TABS.map((id) => ({ id, label: $t(TAB_LABELS[id]), href: backupPageUrl(id) })));
  const tab = $derived(BACKUP_TABS.find((id) => id === page));
</script>

<KitPage>
  {#if tab}
    <PageTabs label={$t('frameleaf_backup_tabs')} {tabs} current={tab} />
    {#if tab === 'overview'}
      <BackupOverview />
    {:else if tab === 'schedule'}
      <BackupSchedule />
    {:else}
      <BackupRestore />
    {/if}
  {:else}
    <BackLink href={backupPageUrl()} label={$t('frameleaf_settings_area_backups')} />
    {#if page === 'cloud'}
      <CloudBackupSection />
    {:else if page === 'buddy'}
      <BuddyBackupSection />
    {:else}
      <BackupLocalPage />
    {/if}
  {/if}
</KitPage>
