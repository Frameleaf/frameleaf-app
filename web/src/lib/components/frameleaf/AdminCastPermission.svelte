<script lang="ts">
  /**
   * The administrator's casting switch on the admin user page (FL-77).
   *
   * Turning it off sets `cast.adminDisabled` through the admin user-preferences endpoint. The
   * server then reports casting as off for the account everywhere, refuses to let the account
   * turn it back on, and keeps the account's own choice so it applies again when the
   * administrator allows casting. The switch is unavailable while the account is deleted,
   * because the server only updates preferences of live accounts.
   */
  import { handleError } from '$lib/utils/handle-error';
  import { updateUserPreferencesAdmin, type UserAdminResponseDto, type UserPreferencesResponseDto } from '@immich/sdk';
  import { Field, Switch, toastManager } from '@immich/ui';
  import { t } from 'svelte-i18n';

  type Props = {
    user: UserAdminResponseDto;
    preferences: UserPreferencesResponseDto;
  };

  let { user, preferences }: Props = $props();

  // Follows the loaded preferences; overridden locally while a change is saved or reverted.
  let allowed = $derived(!preferences.cast.adminDisabled);
  let saving = $state(false);

  const onCheckedChange = async (next: boolean) => {
    allowed = next;
    saving = true;
    try {
      const response = await updateUserPreferencesAdmin({
        id: user.id,
        userPreferencesUpdateDto: { cast: { adminDisabled: !next } },
      });
      allowed = !response.cast.adminDisabled;
      toastManager.primary(
        allowed
          ? $t('frameleaf_users_cast_allowed', { values: { name: user.name } })
          : $t('frameleaf_users_cast_turned_off', { values: { name: user.name } }),
      );
    } catch (error) {
      allowed = !next;
      handleError(error, $t('errors.unable_to_update_settings'));
    } finally {
      saving = false;
    }
  };
</script>

<Field
  label={$t('frameleaf_users_cast_allow')}
  description={$t('frameleaf_users_cast_allow_description')}
  disabled={saving || !!user.deletedAt}
>
  <Switch checked={allowed} {onCheckedChange} />
</Field>
