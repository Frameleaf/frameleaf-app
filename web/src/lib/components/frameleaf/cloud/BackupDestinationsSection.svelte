<script lang="ts">
  import { page } from '$app/state';
  import { t } from 'svelte-i18n';
  import type { Translations } from 'svelte-i18n';
  import CloudBackupSection from '$lib/components/frameleaf/cloud/CloudBackupSection.svelte';
  import BuddyBackupSection from '$lib/components/frameleaf/cloud/BuddyBackupSection.svelte';
  import CloudCard from '$lib/components/frameleaf/cloud/CloudCard.svelte';
  import { commandCenterUrl } from '$lib/frameleaf/settings-areas';
  import { Icon } from '@frameleaf/ui';
  import { mdiArrowRight, mdiCloudOutline, mdiLockOutline, mdiServerOutline, mdiShieldCheckOutline } from '@mdi/js';
  import './frameleaf-cloud.css';

  const views: { id: string; label: Translations }[] = [
    { id: 'status', label: 'frameleaf_backup_status' },
    { id: 'cloud', label: 'frameleaf_buddy_cloud_backup' },
    { id: 'controls', label: 'frameleaf_backup_controls' },
    { id: 'restore', label: 'frameleaf_backup_recover' },
    { id: 'compare', label: 'frameleaf_backup_compare' },
  ];
  const selected = $derived(page.url.searchParams.get('backupView'));
  // Keep existing Cloud Backup deep links opening that destination.
  const view = $derived(
    views.some((item) => item.id === selected)
      ? selected
      : page.url.searchParams.get('area') === 'backups'
        ? 'status'
        : 'cloud',
  );
  const href = (next: string) => commandCenterUrl('backups', undefined, { backupView: next });
</script>

<div class="frameleaf-cloud backup-center">
  <nav aria-label={$t('frameleaf_backup_sections')}>
    {#each views as item (item.id)}<a href={href(item.id)} aria-current={view === item.id ? 'page' : undefined}
        >{$t(item.label)}</a
      >{/each}
  </nav>
  {#if view === 'status'}
    <div class="intro">
      <div>
        <h2>{$t('frameleaf_backup_intro')}</h2>
        <p>{$t('frameleaf_backup_intro_description')}</p>
        <a class="action" href={href('compare')}>{$t('frameleaf_backup_compare_destinations')}</a>
      </div>
      {@render diagram()}
    </div>
    <BuddyBackupSection view="status" />
    <CloudCard title={$t('frameleaf_buddy_cloud_backup')} description={$t('frameleaf_backup_intro_description')}
      ><a class="action" href={href('cloud')}>{$t('frameleaf_backup_explore_cloud')}</a></CloudCard
    >
  {:else if view === 'cloud'}
    <CloudBackupSection />
  {:else if view === 'controls'}
    <BuddyBackupSection view="controls" />
  {:else if view === 'restore'}
    <p>{$t('frameleaf_backup_recovery_scope')}</p>
    <BuddyBackupSection view="restore" />
    <CloudCard title={$t('frameleaf_buddy_cloud_backup')} description={$t('frameleaf_backup_cloud_recovery')}
      ><a class="action" href={href('cloud')}>{$t('frameleaf_backup_open_cloud_recovery')}</a></CloudCard
    >
  {:else if view === 'compare'}
    <div class="intro">
      <div>
        <h2>{$t('frameleaf_backup_compare_title')}</h2>
        <p>{$t('frameleaf_backup_compare_description')}</p>
      </div>
      {@render diagram()}
    </div>
    <div class="comparison">
      <CloudCard title={$t('frameleaf_buddy_cloud_backup')} icon={mdiCloudOutline}>
        <h3>{$t('frameleaf_backup_cloud_title')}</h3>
        <p>{$t('frameleaf_backup_cloud_description')}</p>
        <ul>
          <li>{$t('frameleaf_backup_cloud_storage')}</li>
          <li>{$t('frameleaf_backup_cloud_independent')}</li>
          <li>{$t('frameleaf_backup_cloud_encryption')}</li>
        </ul>
        <a class="action" href={href('cloud')}>{$t('frameleaf_backup_explore_cloud')}</a>
      </CloudCard>
      <CloudCard title={$t('frameleaf_buddy_buddy_backup')} icon={mdiServerOutline}>
        <h3>{$t('frameleaf_backup_buddy_title')}</h3>
        <p>{$t('frameleaf_backup_buddy_description')}</p>
        <ul>
          <li>{$t('frameleaf_backup_buddy_storage')}</li>
          <li>{$t('frameleaf_backup_buddy_subscription')}</li>
          <li>{$t('frameleaf_backup_buddy_encryption')}</li>
        </ul>
        <a class="action" href={href('controls')}>{$t('frameleaf_buddy_set_up_buddy_backup')}</a>
      </CloudCard>
    </div>
    <div class="notes">
      <section>
        <Icon icon={mdiLockOutline} size="24" />
        <h3>{$t('frameleaf_backup_keep_kit')}</h3>
        <p>{$t('frameleaf_backup_keep_kit_description')}</p>
      </section>
      <section>
        <Icon icon={mdiArrowRight} size="24" />
        <h3>{$t('frameleaf_backup_direct')}</h3>
        <p>{$t('frameleaf_backup_direct_description')}</p>
      </section>
      <section>
        <Icon icon={mdiShieldCheckOutline} size="24" />
        <h3>{$t('frameleaf_backup_tested')}</h3>
        <p>{$t('frameleaf_backup_tested_description')}</p>
      </section>
    </div>
    <p>{$t('frameleaf_backup_hosting_private')}</p>
  {/if}
</div>

{#snippet diagram()}
  <figure aria-label={$t('frameleaf_backup_diagram')}>
    <div class="source">
      <Icon icon={mdiServerOutline} size="24" /><strong>{$t('frameleaf_backup_your_server')}</strong>
    </div>
    <div class="routes">
      <div>
        <Icon icon={mdiArrowRight} size="20" /><Icon icon={mdiCloudOutline} size="24" /><span
          ><strong>{$t('frameleaf_buddy_cloud_backup')}</strong><small>{$t('frameleaf_backup_cloud_diagram')}</small
          ></span
        >
      </div>
      <div>
        <Icon icon={mdiLockOutline} size="20" /><Icon icon={mdiArrowRight} size="20" /><Icon
          icon={mdiServerOutline}
          size="24"
        /><span
          ><strong>{$t('frameleaf_buddy_buddy_backup')}</strong><small>{$t('frameleaf_backup_buddy_diagram')}</small
          ></span
        >
      </div>
    </div>
  </figure>
{/snippet}

<style>
  .backup-center {
    color: var(--fl-text);
  }
  nav {
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem;
    padding: 0.25rem;
    margin-bottom: 1.5rem;
    background: var(--fl-raised);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
  }
  nav a {
    flex: 1;
    min-height: 2.75rem;
    display: grid;
    place-items: center;
    padding: 0.5rem var(--fl-space-3);
    border-radius: var(--fl-radius-control);
    text-align: center;
    font-size: 0.8125rem;
    color: var(--fl-muted);
  }
  nav a[aria-current='page'] {
    background: var(--fl-accent);
    color: var(--fl-accent-text);
    font-weight: 600;
  }
  a:focus-visible {
    outline: var(--fl-focus-ring);
    outline-offset: var(--fl-focus-offset);
  }
  .intro {
    display: grid;
    grid-template-columns: 1fr 1fr;
    align-items: center;
    gap: 1.5rem;
    margin: 1.5rem 0;
  }
  h2 {
    font-size: 1.5rem;
    font-weight: 650;
  }
  h3 {
    font-weight: 600;
  }
  p,
  li {
    line-height: 1.6;
    color: var(--fl-muted);
    font-size: 0.875rem;
    margin: 0.75rem 0;
  }
  ul {
    padding-inline-start: 1.25rem;
    list-style: disc;
  }
  .action {
    display: inline-flex;
    align-items: center;
    min-height: 2.75rem;
    padding: 0.5rem 0.75rem;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
    background: var(--fl-raised);
    font-size: 0.875rem;
  }
  figure {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 1rem;
    margin: 0;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-card);
    padding: 1.25rem;
  }
  .source {
    display: grid;
    gap: 0.5rem;
    justify-items: center;
    text-align: center;
  }
  .routes {
    display: grid;
    gap: 1.5rem;
  }
  .routes > div {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  figure strong {
    font-size: 0.8125rem;
  }
  figure small {
    display: block;
    color: var(--fl-muted);
    font-size: 0.75rem;
    margin-top: 0.25rem;
  }
  .comparison {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 1rem;
  }
  .notes {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 1.5rem;
    margin: 1.5rem 0;
  }
  .notes h3 {
    margin-top: 0.5rem;
  }
  @media (max-width: 800px) {
    .intro,
    .comparison,
    .notes {
      grid-template-columns: 1fr;
    }
  }
  @media (max-width: 600px) {
    nav {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
    nav a:last-child {
      grid-column: 1 / -1;
    }
    figure {
      gap: 0.5rem;
      padding: 1rem 0.5rem;
    }
  }
</style>
