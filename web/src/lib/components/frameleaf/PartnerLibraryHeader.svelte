<script lang="ts">
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { eventManager } from '$lib/managers/event-manager.svelte';
  import Dialog from './Dialog.svelte';
  import UserAvatar from '$lib/components/shared-components/UserAvatar.svelte';
  import { OpenQueryParam } from '$lib/constants';
  import '$lib/frameleaf/tokens.css';
  import { Route } from '$lib/route';
  import { handleError } from '$lib/utils/handle-error';
  import { getPartners, PartnerDirection, removePartner, updatePartner, type PartnerResponseDto } from '@immich/sdk';
  import { Theme as AppTheme, themeManager, toastManager } from '@immich/ui';
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
  let shareLocation = $state(true);
  let locationUpdating = $state(false);

  const possessive = $derived(/s$/i.test(partner.name.trim()) ? `${partner.name}’` : `${partner.name}’s`);

  const loadSharedBack = async (partnerId: string) => {
    sharedBackLoaded = false;
    try {
      const mine = await getPartners({ direction: PartnerDirection.SharedBy });
      sharedBack = mine.find((candidate) => candidate.id === partnerId);
      shareLocation = sharedBack?.shareLocation ?? true;
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
      toastManager.primary($t('saved'));
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
        <strong>{$t('show_in_timeline')}</strong>
        <small>{$t('show_in_timeline_setting_description')}</small>
      </span>
      <input
        type="checkbox"
        role="switch"
        aria-label={$t('show_in_timeline')}
        checked={partner.inTimeline}
        disabled={updating}
        onchange={(event) => toggleInTimeline(event.currentTarget.checked)}
      />
    </label>

    {#if sharedBack}
      <label class="ph-toggle">
        <span>
          <strong>{$t('frameleaf_sharing.share_location_title')}</strong>
          <small>{$t('frameleaf_sharing.share_location_description', { values: { name: partner.name } })}</small>
          {#if !shareLocation}
            <small class="ph-note" role="status">
              {$t('frameleaf_sharing.location_already_seen', { values: { name: partner.name } })}
            </small>
          {/if}
        </span>
        <input
          type="checkbox"
          role="switch"
          aria-label={$t('frameleaf_sharing.share_location_title')}
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
    <a href={Route.userSettings({ isOpen: OpenQueryParam.SHARING })}>{$t('frameleaf_sharing.sharing_settings')}</a>
    <button type="button" class="danger" onclick={() => (confirmOpen = true)}
      >{$t('stop_sharing_photos_with_user')}</button
    >
  </div>

  {#if confirmOpen}
    <Dialog title={$t('stop_photo_sharing')} closeLabel={$t('close')} bind:open={confirmOpen}>
      <p>{$t('stop_photo_sharing_description', { values: { partner: partner.name } })}</p>
      <p class="muted">{$t('frameleaf_sharing.stop_sharing_note')}</p>
      <div class="ph-confirm-actions">
        <button type="button" onclick={() => (confirmOpen = false)}>{$t('cancel')}</button>
        <button type="button" class="danger" disabled={updating} onclick={stopSharing}>
          {$t('stop_sharing_photos_with_user')}
        </button>
      </div>
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
  .ph-actions a,
  .ph-actions button,
  .ph-confirm-actions button {
    background: var(--fl-raised);
    color: var(--fl-text);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius);
    padding: 0 0.75rem;
    display: inline-flex;
    align-items: center;
  }
  .ph-actions button.danger,
  .ph-confirm-actions button.danger {
    color: var(--fl-accent);
    border-color: var(--fl-accent);
  }
  .ph-confirm-actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
    margin-top: 1rem;
  }
  .muted {
    color: var(--fl-muted);
  }
</style>
