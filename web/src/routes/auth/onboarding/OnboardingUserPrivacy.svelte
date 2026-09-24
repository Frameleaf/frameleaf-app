<script lang="ts">
  /**
   * Onboarding → Your privacy (FL-80 ON-1, O-9): the prototype's switch rows
   * (`AuthScreens.jsx:982-1004`) over this account's preferences — casting (as before, unless an
   * administrator turned it off, FL-77) and suggested memories. Saved when the step closes.
   */
  import SettingToggle from '$lib/components/frameleaf/settings/SettingToggle.svelte';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { handleError } from '$lib/utils/handle-error';
  import { updateMyPreferences } from '@immich/sdk';
  import { onDestroy } from 'svelte';
  import { t } from 'svelte-i18n';

  const preferences = authManager.authenticated ? authManager.preferences : undefined;
  let gCastEnabled = $state(preferences?.cast.gCastEnabled ?? false);
  let memoriesEnabled = $state(preferences?.memories.enabled ?? true);
  // FL-77: an administrator may already have turned casting off for this account.
  const castDisabledByAdmin = $derived(authManager.authenticated && authManager.preferences.cast.adminDisabled);

  onDestroy(async () => {
    if (!preferences) {
      return;
    }
    const cast = !castDisabledByAdmin && gCastEnabled !== preferences.cast.gCastEnabled ? { gCastEnabled } : undefined;
    const memories = memoriesEnabled === preferences.memories.enabled ? undefined : { enabled: memoriesEnabled };
    if (!cast && !memories) {
      return;
    }

    try {
      const response = await updateMyPreferences({ userPreferencesUpdateDto: { cast, memories } });
      authManager.setPreferences(response);
    } catch (error) {
      handleError(error, $t('errors.unable_to_update_settings'));
    }
  });
</script>

<p>{$t('onboarding_privacy_description')}</p>
<div class="ob-switches">
  <SettingToggle
    title={$t('gcast_enabled')}
    subtitle={castDisabledByAdmin ? $t('frameleaf_cast_disabled_by_admin') : $t('gcast_enabled_description')}
    disabled={castDisabledByAdmin}
    bind:checked={gCastEnabled}
  />
  <SettingToggle
    title={$t('frameleaf_onboarding_memories_title')}
    subtitle={$t('frameleaf_onboarding_memories_description')}
    bind:checked={memoriesEnabled}
  />
</div>
