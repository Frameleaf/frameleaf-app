<script lang="ts">
  /**
   * The line under a received space's title (prototype `lh-sync`): how its copies are doing, in
   * words. The API gives a state and one short word, with no counts or file names, so the line
   * says what is known and leaves the mock's numbers out.
   */
  import { receivedStatus } from '$lib/frameleaf/linked-households';
  import { commandCenterUrl } from '$lib/frameleaf/settings-areas';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import type { HouseholdInboundShareDto } from '@frameleaf/sdk';
  import { Icon } from '@frameleaf/ui';
  import {
    mdiAlertCircleOutline,
    mdiCheckCircleOutline,
    mdiDownloadOutline,
    mdiLinkOff,
    mdiPauseCircleOutline,
  } from '@mdi/js';
  import { DateTime } from 'luxon';
  import { locale, t } from 'svelte-i18n';

  let { share }: { share: HouseholdInboundShareDto } = $props();

  const status = $derived(receivedStatus(share));
  const owner = $derived(share.ownerName || share.householdName);
  const name = $derived(share.householdName);

  const line = $derived.by(() => {
    switch (status) {
      case 'getting': {
        return { tone: 'good', icon: mdiDownloadOutline, title: $t('frameleaf_households_sync_getting'), detail: '' };
      }
      case 'current': {
        const when = share.lastPulledAt
          ? DateTime.fromISO(share.lastPulledAt)
              .setLocale($locale ?? 'en')
              .toRelative()
          : null;
        return {
          tone: 'good',
          icon: mdiCheckCircleOutline,
          title: $t('frameleaf_households_sync_current'),
          detail: when ? $t('frameleaf_households_checked', { values: { when } }) : '',
        };
      }
      case 'offline': {
        return {
          tone: 'warn',
          icon: mdiPauseCircleOutline,
          title: $t('frameleaf_households_sync_paused'),
          detail: $t('frameleaf_households_sync_offline', { values: { name } }),
        };
      }
      case 'full': {
        return {
          tone: 'warn',
          icon: mdiPauseCircleOutline,
          title: $t('frameleaf_households_sync_paused'),
          detail: $t('frameleaf_households_sync_full'),
        };
      }
      case 'paused': {
        return {
          tone: 'warn',
          icon: mdiPauseCircleOutline,
          title: $t('frameleaf_households_sync_paused'),
          detail: $t('frameleaf_households_sync_paused_other'),
        };
      }
      case 'skipped_large': {
        return {
          tone: 'warn',
          icon: mdiAlertCircleOutline,
          title: $t('frameleaf_households_sync_skipped'),
          detail: $t('frameleaf_households_sync_skipped_large', { values: { owner } }),
        };
      }
      case 'skipped_other': {
        return {
          tone: 'warn',
          icon: mdiAlertCircleOutline,
          title: $t('frameleaf_households_sync_skipped'),
          detail: $t('frameleaf_households_sync_skipped_other', { values: { name, owner } }),
        };
      }
      default: {
        return {
          tone: 'off',
          icon: mdiLinkOff,
          title: $t('frameleaf_households_sync_stopped'),
          detail: $t('frameleaf_households_sync_stopped_body', { values: { name } }),
        };
      }
    }
  });
</script>

<div class="sync is-{line.tone}" role="status">
  <Icon icon={line.icon} size="18" aria-hidden />
  <strong>{line.title}</strong>
  {#if line.detail}<span>{line.detail}</span>{/if}
  <!-- The storage page is an administrator's; anyone else is told to ask one, in the line above. -->
  {#if status === 'full' && authManager.user.isAdmin}
    <a class="fl-control" href={commandCenterUrl('storage')}>{$t('frameleaf_households_see_storage')}</a>
  {/if}
</div>
{#if status === 'stopped'}
  <p class="note">{$t('frameleaf_households_sync_stopped_note')}</p>
{/if}

<style>
  .sync {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--fl-space-2) var(--fl-space-3);
    margin-top: var(--fl-space-4);
    padding: var(--fl-space-3) var(--fl-space-4);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-card);
    background: var(--fl-panel);
    font-size: var(--fl-font-callout);
    line-height: 1.5;
  }
  .sync > :global(svg) {
    flex-shrink: 0;
    color: var(--fl-accent);
  }
  .sync.is-warn > :global(svg) {
    color: var(--fl-warning);
  }
  .sync.is-off > :global(svg) {
    color: var(--fl-muted);
  }
  strong {
    font-weight: 600;
  }
  .sync > span {
    flex: 1 1 320px;
    color: var(--fl-muted);
  }
  a {
    display: inline-flex;
    align-items: center;
    min-height: 34px;
    padding: 0 var(--fl-space-3);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
    background: var(--fl-raised);
    color: var(--fl-text);
    font-weight: 500;
    text-decoration: none;
  }
  .note {
    margin: var(--fl-space-3) 0 0;
    color: var(--fl-muted);
    font-size: var(--fl-font-callout);
  }
</style>
