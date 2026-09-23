<script lang="ts">
  import SettingToggle from '$lib/components/frameleaf/settings/SettingToggle.svelte';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { handleError } from '$lib/utils/handle-error';
  import { updateMyPreferences } from '@immich/sdk';
  import { onDestroy } from 'svelte';
  import { t } from 'svelte-i18n';

  let gCastEnabled = $state(authManager.authenticated ? authManager.preferences.cast.gCastEnabled : false);
  // FL-77: an administrator may already have turned casting off for this account.
  const castDisabledByAdmin = $derived(authManager.authenticated && authManager.preferences.cast.adminDisabled);

  onDestroy(async () => {
    if (castDisabledByAdmin) {
      return;
    }

    try {
      const response = await updateMyPreferences({ userPreferencesUpdateDto: { cast: { gCastEnabled } } });
      authManager.setPreferences(response);
    } catch (error) {
      handleError(error, $t('errors.unable_to_update_settings'));
    }
  });
</script>

<div class="flex flex-col gap-4">
  <p>
    {$t('onboarding_privacy_description')}
  </p>

  <SettingToggle
    title={$t('gcast_enabled')}
    subtitle={castDisabledByAdmin ? $t('frameleaf_cast_disabled_by_admin') : $t('gcast_enabled_description')}
    disabled={castDisabledByAdmin}
    bind:checked={gCastEnabled}
  />
</div>
