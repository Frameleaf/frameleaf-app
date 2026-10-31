<script lang="ts">
  /**
   * Backup › Overview, Who's backed up (FL-362), after the approved prototype (`BackupV2.jsx`): each
   * account's numbers in the newest Cloud Backup run's coverage ("1,204 of 3,400 photos", "Everything",
   * "No licence", "Unknown" before a run counted it), and whether those numbers reached Frameleaf Cloud.
   * Never what anyone chose: the server keeps each choice to the account that made it.
   */
  import InlineError from '$lib/components/frameleaf/InlineError.svelte';
  import Item from '$lib/components/frameleaf/settings/kit/Item.svelte';
  import ItemList from '$lib/components/frameleaf/settings/kit/ItemList.svelte';
  import type { KitTone } from '$lib/components/frameleaf/settings/kit/Pill.svelte';
  import Section from '$lib/components/frameleaf/settings/kit/Section.svelte';
  import { backupWhen } from '$lib/frameleaf/backup-overview';
  import { commandCenterUrl } from '$lib/frameleaf/settings-areas';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { locale } from '$lib/stores/preferences.store';
  import {
    CloudBackupCoverageReportState,
    getCloudBackupCoverage,
    type CloudBackupCoverageAccountDto,
    type CloudBackupCoverageResponseDto,
  } from '@frameleaf/sdk';
  import { Icon } from '@frameleaf/ui';
  import { mdiAccountOutline, mdiChevronRight } from '@mdi/js';
  import { onMount } from 'svelte';
  import { t, type Translations } from 'svelte-i18n';

  let coverage = $state<CloudBackupCoverageResponseDto | null>(null);
  let failed = $state(false);

  const load = async () => {
    failed = false;
    try {
      const found = await getCloudBackupCoverage();
      if (found && Array.isArray(found.accounts)) {
        coverage = found;
      } else {
        failed = true;
      }
    } catch {
      failed = true;
    }
  };

  onMount(() => {
    void load();
  });

  const count = (value: number) => new Intl.NumberFormat($locale).format(value);

  /** What one account's row says: numbers only, never a choice. */
  const rowOf = (account: CloudBackupCoverageAccountDto): { status: string; tone: KitTone; note?: string } => {
    if (!account.licenceEligible) {
      return {
        status: $t('frameleaf_backup_who_no_licence'),
        tone: 'warn',
        note: $t('frameleaf_backup_who_no_licence_note'),
      };
    }
    if (account.totalOriginals === 0) {
      return { status: $t('frameleaf_backup_who_empty'), tone: 'off' };
    }
    if (account.includedOriginals === null) {
      return { status: $t('frameleaf_backup_who_unknown'), tone: 'off', note: $t('frameleaf_backup_who_unknown_note') };
    }
    if (account.includedOriginals >= account.totalOriginals) {
      return { status: $t('frameleaf_backup_who_everything'), tone: 'good' };
    }
    return {
      status: $t('frameleaf_backup_who_of', {
        values: { included: count(account.includedOriginals), total: count(account.totalOriginals) },
      }),
      tone: account.includedOriginals < account.selectedOriginals ? 'warn' : 'good',
      note:
        account.includedOriginals < account.selectedOriginals
          ? $t('frameleaf_backup_who_not_yet_note', {
              values: { count: count(account.selectedOriginals - account.includedOriginals) },
            })
          : undefined,
    };
  };

  const REPORTS: Record<CloudBackupCoverageReportState, Translations> = {
    [CloudBackupCoverageReportState.Published]: 'frameleaf_backup_who_reported',
    [CloudBackupCoverageReportState.Pending]: 'frameleaf_backup_who_pending',
    [CloudBackupCoverageReportState.NotReported]: 'frameleaf_backup_who_not_reported',
    [CloudBackupCoverageReportState.Local]: 'frameleaf_backup_who_local',
    [CloudBackupCoverageReportState.Unknown]: 'frameleaf_backup_who_none',
  };
  const counted = $derived.by(() => {
    if (!coverage?.inventoryAt) {
      return '';
    }
    const { key, values } = backupWhen(new Date(coverage.inventoryAt), { locale: $locale });
    return $t(key, { values });
  });
  const mine = commandCenterUrl('backup', 'cloud-backup-choice');
</script>

<Section title={$t('frameleaf_backup_who_title')} description={$t('frameleaf_backup_who_description')}>
  {#if failed}
    <InlineError compact message={$t('frameleaf_backup_who_load_failed')} onRetry={load} />
  {:else if coverage}
    <p class="report" role="status">
      {$t(REPORTS[coverage.state], { values: { when: counted } })}
    </p>
    {#if coverage.accounts.length > 0}
      <ItemList>
        {#each coverage.accounts as account (account.userId)}
          {@const row = rowOf(account)}
          <Item
            icon={mdiAccountOutline}
            name={account.userId === authManager.user.id
              ? $t('frameleaf_backup_who_you', { values: { name: account.name } })
              : account.name}
            detail={account.email}
            tone={row.tone}
            status={row.status}
            note={row.note}
          >
            {#snippet action()}
              {#if account.userId === authManager.user.id}
                <a class="button" href={mine} aria-label={$t('frameleaf_backup_who_change_mine')}>
                  {$t('frameleaf_backup_who_change')}
                  <Icon icon={mdiChevronRight} size="18" aria-hidden />
                </a>
              {/if}
            {/snippet}
          </Item>
        {/each}
      </ItemList>
    {/if}
  {/if}
</Section>

<style>
  a.button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: var(--fl-space-1);
    text-decoration: none;
    white-space: nowrap;
  }
  a.button:focus-visible {
    outline: var(--fl-focus-ring);
    outline-offset: var(--fl-focus-offset);
  }
  .report {
    margin: 0 0 var(--fl-space-4);
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
    font-variant-numeric: tabular-nums;
  }
</style>
