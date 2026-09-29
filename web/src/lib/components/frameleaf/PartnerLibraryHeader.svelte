<script lang="ts">
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { eventManager } from '$lib/managers/event-manager.svelte';
  import Button from './Button.svelte';
  import Dialog from './Dialog.svelte';
  import { goto } from '$app/navigation';
  import UserAvatar from '$lib/components/shared-components/UserAvatar.svelte';
  import { OpenQueryParam } from '$lib/constants';
  import '$lib/frameleaf/tokens.css';
  import { Route } from '$lib/route';
  import { handleError } from '$lib/utils/handle-error';
  import { getPartners, PartnerDirection, removePartner, updatePartner, type PartnerResponseDto } from '@immich/sdk';
  import { Icon, Theme as AppTheme, themeManager, toastManager } from '@immich/ui';
  import { mdiCogOutline, mdiInformationOutline, mdiLinkOff } from '@mdi/js';
  import { t } from 'svelte-i18n';

  // Mounted directly on the partner timeline route, above a full-bleed Timeline that has
  // no Frameleaf ancestor of its own — see SharedLinkList.svelte for the same pattern.
  const appTheme = $derived(themeManager.value === AppTheme.Dark ? 'dark' : 'light');

  let {
    partner = $bindable(),
    count = 0,
    onStopped,
  }: {
    partner: PartnerResponseDto;
    count?: number;
    onStopped: () => void;
  } = $props();

  let confirmOpen = $state(false);
  let updating = $state(false);

  /**
   * The relation in the other direction: me sharing my library with this partner. Location sharing is
   * the sharer's setting, so it is only offered here when that relation exists, and it is stored on
   * that relation rather than on the one being browsed.
   */
  let sharedBack: PartnerResponseDto | undefined = $state();
  let sharedBackLoaded = $state(false);
  // off until the sharer turns it on, as the prototype shows (FL-146 AL-40)
  let shareLocation = $state(false);
  let locationUpdating = $state(false);

  const possessive = $derived(/s$/i.test(partner.name.trim()) ? `${partner.name}’` : `${partner.name}’s`);

  const loadSharedBack = async (partnerId: string) => {
    sharedBackLoaded = false;
    try {
      const mine = await getPartners({ direction: PartnerDirection.SharedBy });
      sharedBack = mine.find((candidate) => candidate.id === partnerId);
      shareLocation = sharedBack?.shareLocation ?? false;
    } catch (error) {
      handleError(error, $t('errors.something_went_wrong'));
    } finally {
      sharedBackLoaded = true;
    }
  };

  $effect(() => {
    void loadSharedBack(partner.id);
  });

  const toggleInTimeline = async (checked: boolean) => {
    updating = true;
    const previous = partner.inTimeline;
    partner = { ...partner, inTimeline: checked };
    try {
      const updated = await updatePartner({ id: partner.id, partnerUpdateDto: { inTimeline: checked } });
      partner = updated;
      toastManager.primary(
        $t(checked ? 'frameleaf_sharing.timeline_shown_notice' : 'frameleaf_sharing.timeline_hidden_notice', {
          values: { possessive },
        }),
      );
    } catch (error) {
      partner = { ...partner, inTimeline: previous };
      handleError(error, $t('errors.unable_to_change_partner_permission'));
    } finally {
      updating = false;
    }
  };

  const toggleShareLocation = async (checked: boolean) => {
    locationUpdating = true;
    const previous = shareLocation;
    shareLocation = checked;
    try {
      sharedBack = await updatePartner({ id: partner.id, partnerUpdateDto: { shareLocation: checked } });
      shareLocation = sharedBack.shareLocation ?? checked;
      toastManager.primary(
        $t(checked ? 'frameleaf_sharing.location_shown_notice' : 'frameleaf_sharing.location_hidden_notice', {
          values: { name: partner.name },
        }),
      );
    } catch (error) {
      shareLocation = previous;
      handleError(error, $t('errors.unable_to_change_partner_permission'));
    } finally {
      locationUpdating = false;
    }
  };

  const stopSharing = async () => {
    updating = true;
    try {
      await removePartner({ id: partner.id });
      eventManager.emit('PartnerRevoke', { sharedById: authManager.user.id, sharedWithId: partner.id });
      confirmOpen = false;
      toastManager.primary($t('frameleaf_sharing.partner_stopped', { values: { name: partner.name } }));
      onStopped();
    } catch (error) {
      handleError(error, $t('errors.unable_to_remove_partner'));
    } finally {
      updating = false;
    }
  };
</script>

<section
  class="frameleaf ph-header"
  data-theme={appTheme}
  aria-label={$t('frameleaf_sharing.library_heading', { values: { possessive } })}
>
  <div class="ph-identity">
    <UserAvatar user={partner} size="lg" />
    <div class="ph-copy">
      <h2>{$t('frameleaf_sharing.library_heading', { values: { possessive } })}</h2>
      <p>{$t('frameleaf_sharing.library_summary', { values: { count, possessive } })}</p>
    </div>
  </div>

  <div class="ph-toggles">
    <label class="ph-toggle">
      <span>
        <strong>{$t('frameleaf_sharing.partner_show_in_my_timeline')}</strong>
        <small>{$t('frameleaf_sharing.partner_show_in_my_timeline_description')}</small>
      </span>
      <input
        type="checkbox"
        role="switch"
        aria-label={$t('frameleaf_sharing.partner_show_in_my_timeline')}
        checked={partner.inTimeline}
        disabled={updating}
        onchange={(event) => toggleInTimeline(event.currentTarget.checked)}
      />
    </label>

    {#if sharedBack}
      <label class="ph-toggle">
        <span>
          <strong>{$t('frameleaf_sharing.partner_location_title')}</strong>
          <small>{$t('frameleaf_sharing.partner_location_description')}</small>
          {#if !shareLocation}
            <small class="ph-note" role="status">
              {$t('frameleaf_sharing.location_already_seen', { values: { name: partner.name } })}
            </small>
          {/if}
        </span>
        <input
          type="checkbox"
          role="switch"
          aria-label={$t('frameleaf_sharing.partner_location_title')}
          checked={shareLocation}
          disabled={locationUpdating}
          onchange={(event) => toggleShareLocation(event.currentTarget.checked)}
        />
      </label>
    {:else if sharedBackLoaded}
      <p class="ph-hint">{$t('frameleaf_sharing.location_not_sharing_back', { values: { name: partner.name } })}</p>
    {/if}
  </div>

  <div class="ph-actions">
    <Button onclick={() => void goto(Route.userSettings({ isOpen: OpenQueryParam.SHARING }))}>
      <Icon icon={mdiCogOutline} size="18" aria-hidden={true} />
      {$t('frameleaf_sharing.sharing_settings')}
    </Button>
    <Button variant="danger" onclick={() => (confirmOpen = true)}>
      <Icon icon={mdiLinkOff} size="18" aria-hidden={true} />
      {$t('frameleaf_sharing.partner_stop_sharing')}
    </Button>
  </div>

  {#if confirmOpen}
    <Dialog title={$t('frameleaf_sharing.partner_stop_sharing_title')} closeLabel={$t('close')} bind:open={confirmOpen}>
      <p>{$t('frameleaf_sharing.partner_stop_sharing_body', { values: { name: partner.name } })}</p>
      <p class="muted ph-note-line">
        <Icon icon={mdiInformationOutline} size="16" aria-hidden={true} />
        {$t('frameleaf_sharing.stop_sharing_note')}
      </p>
      {#snippet actions()}
        <Button onclick={() => (confirmOpen = false)}>{$t('cancel')}</Button>
        <Button variant="primary" initialFocus disabled={updating} onclick={stopSharing}>
          {$t('frameleaf_sharing.partner_stop_sharing')}
        </Button>
      {/snippet}
    </Dialog>
  {/if}
</section>

<style>
  .ph-header {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 1rem;
    padding: 0.75rem 0;
  }
  .ph-identity {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    min-width: 0;
  }
  h2 {
    font-size: 1rem;
  }
  .ph-copy p {
    color: var(--fl-muted);
    font-size: 0.8125rem;
  }
  .ph-toggles {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    margin-inline-start: auto;
  }
  .ph-toggle {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  .ph-toggle small {
    display: block;
    color: var(--fl-muted);
    font-size: 0.75rem;
  }
  .ph-toggle .ph-note {
    color: var(--fl-text);
    margin-top: 0.125rem;
  }
  .ph-hint {
    color: var(--fl-muted);
    font-size: 0.75rem;
  }
  .ph-actions {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  .ph-note-line {
    display: flex;
    align-items: center;
    gap: 0.375rem;
  }
  .muted {
    color: var(--fl-muted);
  }
</style>
