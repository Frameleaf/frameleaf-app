<script lang="ts">
  import Dialog from './Dialog.svelte';
  import UserAvatar from '$lib/components/shared-components/UserAvatar.svelte';
  import { OpenQueryParam } from '$lib/constants';
  import '$lib/frameleaf/tokens.css';
  import { Route } from '$lib/route';
  import { handleError } from '$lib/utils/handle-error';
  import { removePartner, updatePartner, type PartnerResponseDto } from '@immich/sdk';
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

  const possessive = $derived(/s$/i.test(partner.name.trim()) ? `${partner.name}’` : `${partner.name}’s`);

  const toggleInTimeline = async (checked: boolean) => {
    updating = true;
    const previous = partner.inTimeline;
    partner = { ...partner, inTimeline: checked };
    try {
      const updated = await updatePartner({ id: partner.id, partnerUpdateDto: { inTimeline: checked } });
      partner = updated;
      toastManager.primary($t(checked ? 'frameleaf_sharing.timeline_shown_notice' : 'frameleaf_sharing.timeline_hidden_notice', { values: { possessive } }));
    } catch (error) {
      partner = { ...partner, inTimeline: previous };
      handleError(error, $t('errors.unable_to_change_partner_permission'));
    } finally {
      updating = false;
    }
  };

  const stopSharing = async () => {
    updating = true;
    try {
      await removePartner({ id: partner.id });
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

  <div class="ph-actions">
    <a href={Route.userSettings({ isOpen: OpenQueryParam.SHARING })}>{$t('frameleaf_sharing.sharing_settings')}</a>
    <button type="button" class="danger" onclick={() => (confirmOpen = true)}>{$t('stop_sharing_photos_with_user')}</button>
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
  .ph-toggle {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-inline-start: auto;
  }
  .ph-toggle small {
    display: block;
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
