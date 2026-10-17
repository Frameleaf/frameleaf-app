<script lang="ts">
  /**
   * What one kept Cloud Backup doesn't hold, and why (FL-362). Library data is always backed up whole,
   * so a restore brings every item back; an item whose original the backup left out comes back without
   * it, and this says why, from that backup's own decision rather than today's choices: left out by the
   * account's selection, no licence for the account, or not backed up yet. Counts per account only: what
   * an account chose stays its own. A file the backup names but cannot give back is a restore error,
   * never one of these.
   */
  import InlineError from '$lib/components/frameleaf/InlineError.svelte';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import {
    getCloudBackupManifestExclusions,
    type CloudBackupExclusionCountsDto,
    type CloudBackupExclusionsResponseDto,
  } from '@frameleaf/sdk';
  import { t, type Translations } from 'svelte-i18n';

  let { manifestKey }: { manifestKey: string } = $props();

  let exclusions = $state<CloudBackupExclusionsResponseDto | null>(null);
  let failed = $state(false);

  /** Only the newest read fills the view: an answer for an earlier backup is dropped. */
  let request = 0;
  const load = async (key: string) => {
    const mine = ++request;
    exclusions = null;
    failed = false;
    try {
      const found = await getCloudBackupManifestExclusions({ cloudBackupExclusionsDto: { manifestKey: key } });
      if (mine === request) {
        exclusions = found;
      }
    } catch {
      if (mine === request) {
        failed = true;
      }
    }
  };

  $effect(() => {
    if (manifestKey) {
      void load(manifestKey);
    }
  });

  type Reason = keyof CloudBackupExclusionCountsDto;
  const REASONS: ReadonlyArray<[Reason, Translations, Translations]> = [
    ['selection', 'frameleaf_backup_exclusion_selection', 'frameleaf_backup_exclusion_selection_other'],
    ['licence', 'frameleaf_backup_exclusion_licence', 'frameleaf_backup_exclusion_licence'],
    ['notCommitted', 'frameleaf_backup_exclusion_not_committed', 'frameleaf_backup_exclusion_not_committed'],
    ['unknown', 'frameleaf_backup_exclusion_unknown', 'frameleaf_backup_exclusion_unknown'],
  ];
  const nothing = (counts: CloudBackupExclusionCountsDto) =>
    counts.selection + counts.licence + counts.notCommitted + counts.unknown === 0;
  /** "Not backed up by your selection" for the reader's own items, "their selection" for anyone else's. */
  const reasonsOf = (counts: CloudBackupExclusionCountsDto, own: boolean) =>
    REASONS.filter(([reason]) => counts[reason] > 0).map(([reason, mineKey, otherKey]) => ({
      reason,
      label: $t(own ? mineKey : otherKey),
      value: $t('frameleaf_backup_exclusion_count', { values: { count: counts[reason] } }),
    }));
</script>

<section class="exclusions" aria-labelledby="fl362-exclusions-title">
  <h3 id="fl362-exclusions-title">{$t('frameleaf_backup_exclusion_title')}</h3>
  <p class="muted">{$t('frameleaf_backup_exclusion_description')}</p>
  {#if failed}
    <InlineError compact message={$t('frameleaf_backup_exclusion_load_failed')} onRetry={() => load(manifestKey)} />
  {:else if !exclusions}
    <p class="muted" role="status">{$t('loading')}</p>
  {:else if nothing(exclusions.totals)}
    <p>{$t('frameleaf_backup_exclusion_none')}</p>
  {:else}
    {#if !exclusions.decisionKnown}
      <p class="muted">{$t('frameleaf_backup_exclusion_older')}</p>
    {/if}
    <table class="fc-table">
      <thead>
        <tr>
          <th scope="col">{$t('frameleaf_backup_exclusion_column_person')}</th>
          <th scope="col">{$t('frameleaf_backup_exclusion_column_reason')}</th>
        </tr>
      </thead>
      <tbody>
        {#each exclusions.accounts.filter((account) => !nothing(account)) as account (account.userId)}
          {@const own = account.userId === authManager.user?.id}
          <tr>
            <th scope="row">
              {own ? $t('frameleaf_backup_who_you', { values: { name: account.name } }) : account.name}
            </th>
            <td>
              <ul class="reasons">
                {#each reasonsOf(account, own) as row (row.reason)}
                  <li><span>{row.label}</span> <span class="figure">{row.value}</span></li>
                {/each}
              </ul>
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}
</section>

<style>
  .exclusions {
    margin: var(--fl-space-4) 0;
  }
  h3 {
    margin: 0 0 var(--fl-space-2);
    font-size: var(--fl-font-callout);
    font-weight: 600;
  }
  .muted {
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  .reasons {
    display: grid;
    gap: var(--fl-space-1);
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .figure {
    font-variant-numeric: tabular-nums;
    color: var(--fl-muted);
  }
</style>
