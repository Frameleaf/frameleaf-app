<script lang="ts" module>
  import type { Component } from 'svelte';

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- each page declares its own props
  type Page = () => Promise<{ default: Component<any> }>;

  // FL-1799: each page's code loads when the page opens, not with the Command Center.
  const ADMIN_PAGES: Record<string, Page> = {
    queues: () => import('./QueuesSection.svelte'),
    'cloud-processing': () => import('$lib/components/frameleaf/cloud/CloudMlSection.svelte'),
    hardware: () => import('$lib/components/frameleaf/cloud/HardwareSection.svelte'),
    'cloud-account': () => import('$lib/components/frameleaf/cloud/CloudAccountSection.svelte'),
    'cloud-plan': () => import('$lib/components/frameleaf/cloud/YourCloudSection.svelte'),
    'cloud-license': () => import('$lib/components/frameleaf/cloud/LicenseSection.svelte'),
    'cloud-remote': () => import('$lib/components/frameleaf/cloud/RemoteAccessSection.svelte'),
    'frameleaf-signin': () => import('$lib/components/frameleaf/cloud/FrameleafSignInSection.svelte'),
    integrity: () => import('$lib/components/frameleaf/settings/care/FileChecks.svelte'),
    files: () => import('$lib/components/frameleaf/settings/care/FileProblems.svelte'),
    accounts: () => import('./UsersSection.svelte'),
    'enrichment-care': () => import('$lib/components/frameleaf/settings/care/CareProgress.svelte'),
    signals: () => import('$lib/components/frameleaf/settings/notifications/AttentionPage.svelte'),
  };
  const ACCOUNT_PAGES: Record<string, Page> = {
    repair: () => import('$lib/components/frameleaf/settings/care/ThingsToFix.svelte'),
    files: () => import('$lib/components/frameleaf/settings/care/FileProblems.svelte'),
    'couldnt-process': () => import('$lib/components/frameleaf/settings/care/CouldntProcess.svelte'),
    dates: () => import('$lib/components/frameleaf/settings/care/DateDoctor.svelte'),
    'tidy-up': () => import('$lib/components/frameleaf/settings/care/TidyUp.svelte'),
    'tidy-up-review': () => import('$lib/components/frameleaf/settings/care/TidyUpReview.svelte'),
    'nothing-lost': () => import('$lib/components/frameleaf/settings/care/NothingLost.svelte'),
    contents: () => import('./TrashSection.svelte'),
  };
  const loadComputersPage = async () => {
    const [page, data] = await Promise.all([import('./ComputersSection.svelte'), loadComputers()]);
    return { Page: page.default, data };
  };
  const loadMaintenance: Page = () => import('./MaintenanceSection.svelte');
  const loadLocationScan: Page = () => import('$lib/components/frameleaf/settings/care/PhotoLocationScan.svelte');
</script>

<script lang="ts">
  /**
   * Draws a Command Center section that is a page of its own rather than a settings form (FL-71):
   * the old administration pages (deduplication, Compute & jobs, Maintenance, Users), the account's
   * Trash and repair queues, and the account settings (`UserSettingsList`).
   */
  import KitPage from '$lib/components/frameleaf/settings/kit/KitPage.svelte';
  import Lazy from '$lib/components/frameleaf/settings/Lazy.svelte';
  import Loader from '$lib/components/frameleaf/settings/Loader.svelte';
  import type { SettingsHostSection } from '$lib/frameleaf/settings-areas';
  import UserSettingsList from '../UserSettingsList.svelte';
  import { loadComputers } from './loaders';

  let { section }: { section: SettingsHostSection } = $props();

  // 'backups' is drawn by the Backup area (FL-362); 'integrity' is File checks (FL-366).
  const MAINTENANCE = ['mode'] as const;
  const maintenanceSection = $derived(MAINTENANCE.find((key) => key === section.key));
  const page = $derived.by(() => {
    const pages = section.admin ? ADMIN_PAGES : ACCOUNT_PAGES;
    return Object.hasOwn(pages, section.key) ? pages[section.key] : undefined;
  });
</script>

{#if section.admin && section.key === 'computers'}
  <Loader load={loadComputersPage}>
    {#snippet children({ Page, data })}
      <Page {data} />
    {/snippet}
  </Loader>
{:else if page}
  <Lazy load={page} />
{:else if section.admin}
  {#if maintenanceSection}
    <Lazy load={loadMaintenance} props={{ section: maintenanceSection }} />
  {/if}
{:else if section.key === 'location-scan'}
  <KitPage><Lazy load={loadLocationScan} /></KitPage>
{:else}
  <UserSettingsList section={section.key} />
{/if}
