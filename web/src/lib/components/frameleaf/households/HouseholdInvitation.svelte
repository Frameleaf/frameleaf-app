<script lang="ts">
  /**
   * An invitation to a space from another household, with Accept and Decline: in Notifications, and
   * beside ordinary space invitations on the Sharing page, so a dismissed notification cannot lose
   * it. The answer is said in a toast, because the row leaves the list once it is answered.
   */
  import Button from '$lib/components/frameleaf/Button.svelte';
  import { handleError } from '$lib/utils/handle-error';
  import { acceptHouseholdShare, declineHouseholdShare, type HouseholdInboundShareDto } from '@frameleaf/sdk';
  import { Icon, toastManager } from '@frameleaf/ui';
  import { mdiAccountMultiplePlusOutline, mdiHomeGroup } from '@mdi/js';
  import { DateTime } from 'luxon';
  import { locale, t } from 'svelte-i18n';

  let {
    share,
    createdAt,
    onAnswered,
  }: {
    share: HouseholdInboundShareDto;
    /** When the notification arrived, shown at the row's end in Notifications. */
    createdAt?: string;
    onAnswered?: (share: HouseholdInboundShareDto) => Promise<void> | void;
  } = $props();

  let busy = $state(false);

  const owner = $derived(share.ownerName || share.householdName);
  const when = $derived(
    createdAt
      ? DateTime.fromISO(createdAt)
          .setLocale($locale ?? 'en')
          .toRelative()
      : null,
  );

  const answer = async (accept: boolean) => {
    busy = true;
    try {
      if (accept) {
        await acceptHouseholdShare({ id: share.id });
        toastManager.primary($t('frameleaf_households_accepted', { values: { space: share.spaceName } }));
      } else {
        await declineHouseholdShare({ id: share.id });
        toastManager.primary($t('frameleaf_households_declined', { values: { owner } }));
      }
      await onAnswered?.(share);
    } catch (error) {
      handleError(error, $t('frameleaf_households_error'));
    } finally {
      busy = false;
    }
  };
</script>

<article class="invitation" aria-label={share.spaceName}>
  <span class="tile" aria-hidden="true"><Icon icon={mdiAccountMultiplePlusOutline} size="18" /></span>
  <div class="text">
    <strong>{$t('frameleaf_households_invite_title', { values: { owner, space: share.spaceName } })}</strong>
    <span class="from">
      <Icon icon={mdiHomeGroup} size="14" aria-hidden />
      {$t('frameleaf_households_from', { values: { name: share.householdName } })}
    </span>
    <span class="body">{$t('frameleaf_households_invite_body')}</span>
    <div class="actions">
      <Button variant="primary" disabled={busy} onclick={() => void answer(true)}>
        {$t('frameleaf_households_accept')}
      </Button>
      <Button disabled={busy} onclick={() => void answer(false)}>{$t('frameleaf_households_decline')}</Button>
    </div>
  </div>
  {#if when}<time datetime={createdAt}>{when}</time>{/if}
</article>

<style>
  .invitation {
    display: grid;
    grid-template-columns: 34px minmax(0, 1fr) auto;
    align-items: start;
    gap: 0.25rem 0.75rem;
    padding: 0.625rem;
  }
  .tile {
    display: grid;
    place-items: center;
    width: 34px;
    height: 34px;
    border-radius: 10px;
    background: var(--fl-raised);
    color: var(--fl-blue);
  }
  .text {
    display: grid;
    gap: 2px;
    min-width: 0;
  }
  strong {
    font-weight: 600;
    overflow-wrap: anywhere;
  }
  .from {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: var(--fl-font-small);
    font-weight: 500;
  }
  .body {
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--fl-space-2) var(--fl-space-3);
    margin-top: var(--fl-space-2);
  }
  time {
    padding-top: 2px;
    color: var(--fl-muted);
    font-size: var(--fl-font-micro);
    white-space: nowrap;
  }
</style>
