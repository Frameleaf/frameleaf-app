<script lang="ts">
  import Button from '$lib/components/frameleaf/Button.svelte';
  import { buddyBackupPresentation } from '$lib/frameleaf/buddy-backup';
  import { commandCenterUrl } from '$lib/frameleaf/settings-areas';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { cloudManager } from '$lib/managers/cloud-manager.svelte';
  import { locale } from '$lib/stores/preferences.store';
  import { getByteUnitString } from '$lib/utils/byte-units';
  import {
    getBuddyBackupStatus,
    getCloudBackupStatus,
    type BuddyStatusDto,
    type CloudBackupStatusResponseDto,
  } from '@frameleaf/sdk';
  import { Icon } from '@frameleaf/ui';
  import { mdiArrowBottomLeft, mdiArrowTopRight, mdiChevronRight, mdiCloudOutline } from '@mdi/js';
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';

  let { analytics = false }: { analytics?: boolean } = $props();
  let buddy = $state<BuddyStatusDto | null>(null);
  let cloud = $state<CloudBackupStatusResponseDto | null>(null);
  let busy = $state(true);
  let failed = $state(false);
  let disposed = false;
  const presentation = $derived(
    buddyBackupPresentation(
      buddy,
      cloudManager.status?.state === 'linked',
      !!cloudManager.license?.entitlements.cloudBackup,
    ),
  );
  const when = (value: string | null | undefined) =>
    value ? new Date(value).toLocaleString($locale) : $t('frameleaf_buddy_not_yet');
  const href = (view: string) => commandCenterUrl('backups', undefined, { backupView: view });
  const load = async () => {
    busy = true;
    const [buddyResult, cloudResult] = await Promise.allSettled([getBuddyBackupStatus(), getCloudBackupStatus()]);
    if (disposed) {
      return;
    }
    buddy = buddyResult.status === 'fulfilled' ? buddyResult.value : null;
    cloud = cloudResult.status === 'fulfilled' ? cloudResult.value : null;
    failed = buddyResult.status === 'rejected' || cloudResult.status === 'rejected';
    busy = false;
  };
  onMount(() => {
    if (!authManager.user.isAdmin) {
      return;
    }
    const stop = cloudManager.listen();
    void load();
    return () => {
      disposed = true;
      stop();
    };
  });
</script>

{#if authManager.user.isAdmin}
  <section class="backup-summary" aria-label={$t('frameleaf_backup_summary')} aria-busy={busy}>
    <header>
      <div>
        <h2>{$t('frameleaf_backup_summary')}</h2>
        <p>{$t(analytics ? 'frameleaf_backup_server_snapshot' : 'frameleaf_backup_summary_description')}</p>
      </div>
      <a href={href('status')}>{$t('frameleaf_backup_open')}<Icon icon={mdiChevronRight} size="16" /></a>
    </header>
    {#if failed}<p role="alert">{$t('frameleaf_backup_status_failed')}</p>{/if}
    <div class="cards">
      <a class="destination" href={href('cloud')}>
        <Icon icon={mdiCloudOutline} size="22" /><span
          ><strong>{$t('frameleaf_buddy_cloud_backup')}</strong>
          <small
            >{cloud
              ? $t(cloud.configured ? 'frameleaf_backup_configured' : 'frameleaf_buddy_not_configured')
              : $t(busy ? 'loading' : 'frameleaf_cc_unmeasured')}</small
          >
          <b>{cloud?.usage ? getByteUnitString(cloud.usage.bytes) : '—'}</b></span
        ><Icon icon={mdiChevronRight} size="16" />
      </a>
      <a class="destination" href={href('status')}>
        <Icon icon={mdiArrowTopRight} size="22" /><span
          ><strong>{$t('frameleaf_backup_outgoing')}</strong>
          <small>{buddy ? $t(presentation.outgoing) : $t(busy ? 'loading' : 'frameleaf_cc_unmeasured')}</small>
          <b>{buddy ? when(buddy.lastCompleteAt) : '—'}</b></span
        ><Icon icon={mdiChevronRight} size="16" />
      </a>
      <a class="destination" href={href('controls')}>
        <Icon icon={mdiArrowBottomLeft} size="22" /><span
          ><strong>{$t('frameleaf_backup_incoming')}</strong>
          <small>{buddy ? $t(presentation.incoming) : $t(busy ? 'loading' : 'frameleaf_cc_unmeasured')}</small>
          <b
            >{buddy
              ? $t('frameleaf_backup_encrypted_size', {
                  values: { size: getByteUnitString(buddy.hosting.committedBytes) },
                })
              : '—'}</b
          ></span
        ><Icon icon={mdiChevronRight} size="16" />
      </a>
    </div>
    {#if analytics && buddy}
      <dl>
        <div>
          <dt>{$t('frameleaf_buddy_last_successful_recovery_check')}</dt>
          <dd>{when(buddy.lastVerifiedAt)}</dd>
        </div>
        <div>
          <dt>{$t('frameleaf_buddy_reserved_for_transfers')}</dt>
          <dd>{getByteUnitString(buddy.hosting.reservedBytes)}</dd>
        </div>
        <div>
          <dt>{$t('frameleaf_buddy_connection')}</dt>
          <dd>{buddy.connection ?? $t('frameleaf_buddy_waiting_for_a_transfer')}</dd>
        </div>
        <div>
          <dt>{$t('frameleaf_buddy_transfer_speed')}</dt>
          <dd>{buddy.transferMbps.toFixed(1)} Mbit/s</dd>
        </div>
      </dl>
      <p>{$t('frameleaf_backup_no_history')}</p>
    {/if}
    <footer>
      <span>{$t('frameleaf_backup_hosting_private')}</span><Button disabled={busy} onclick={() => void load()}
        >{$t('refresh')}</Button
      >
    </footer>
  </section>
{/if}

<style>
  .backup-summary {
    margin: 1.25rem 0;
    padding: 1.25rem;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-card);
    color: var(--fl-text);
    background: var(--fl-panel);
  }
  header,
  footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    flex-wrap: wrap;
  }
  h2 {
    font-size: 1rem;
    font-weight: 650;
    margin: 0;
  }
  p,
  small,
  dt,
  footer {
    color: var(--fl-muted);
    font-size: 0.8125rem;
  }
  p {
    margin: 0.4rem 0;
  }
  header > a {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    min-height: 2.75rem;
  }
  .cards {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 0.75rem;
    margin: 1rem 0;
  }
  .destination {
    display: flex;
    align-items: center;
    gap: 0.625rem;
    padding: 1rem;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
    background: var(--fl-raised);
    min-width: 0;
  }
  .destination span {
    display: grid;
    gap: 0.4rem;
    flex: 1;
    min-width: 0;
    overflow-wrap: anywhere;
  }
  strong,
  b {
    font-size: 0.8125rem;
    font-weight: 600;
  }
  a:focus-visible {
    outline: var(--fl-focus-ring);
    outline-offset: var(--fl-focus-offset);
  }
  dl {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 1rem;
    margin: 1rem 0;
  }
  dd {
    margin: 0.3rem 0 0;
    font-size: 0.875rem;
  }
  @media (max-width: 900px) {
    .cards {
      grid-template-columns: 1fr;
    }
  }
  @media (max-width: 600px) {
    dl {
      grid-template-columns: 1fr;
    }
  }
</style>
