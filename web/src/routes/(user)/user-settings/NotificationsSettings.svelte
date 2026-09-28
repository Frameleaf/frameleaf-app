<script lang="ts">
  /**
   * The account's own email notifications (FL-77), from the design template's "Your email
   * notifications" settings. Turning email off also turns off album invitations and updates;
   * those two stay visible and are unavailable until email is on again.
   */
  import OwnPreferencesForm from '$lib/components/frameleaf/settings/OwnPreferencesForm.svelte';
  import SettingToggle from '$lib/components/frameleaf/settings/SettingToggle.svelte';
  import { SECTION_KEYS } from '$lib/frameleaf/account-preferences';
  import { createOwnPreferencesDraft } from '$lib/frameleaf/own-preferences-draft';
  import { t } from 'svelte-i18n';

  const store = createOwnPreferencesDraft(SECTION_KEYS.notifications);
  const draft = $derived(store.draft);
  const disabled = $derived(!draft['emailNotifications.enabled']);
</script>

<OwnPreferencesForm {store}>
  <SettingToggle
    title={$t('frameleaf_own_prefs_email')}
    subtitle={$t('frameleaf_own_prefs_email_help')}
    bind:checked={() => draft['emailNotifications.enabled'], (value) => store.setEmailNotifications(value)}
  />
  <SettingToggle
    title={$t('frameleaf_own_prefs_album_invites')}
    subtitle={$t('frameleaf_own_prefs_album_invites_help')}
    {disabled}
    bind:checked={
      () => draft['emailNotifications.albumInvite'], (value) => store.set('emailNotifications.albumInvite', value)
    }
  />
  <SettingToggle
    title={$t('frameleaf_own_prefs_album_updates')}
    subtitle={$t('frameleaf_own_prefs_album_updates_help')}
    {disabled}
    bind:checked={
      () => draft['emailNotifications.albumUpdate'], (value) => store.set('emailNotifications.albumUpdate', value)
    }
  />
</OwnPreferencesForm>
