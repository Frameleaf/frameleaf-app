<script lang="ts">
  /**
   * Password, from the `password` section of the design template's `PersonalAccess`. The template
   * shows when the password last changed; the server does not record that per secret, so the row
   * says whether a new password is required instead of inventing a date.
   */
  import Button from '$lib/components/frameleaf/Button.svelte';
  import PasswordDialog from '$lib/components/frameleaf/access/PasswordDialog.svelte';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { modalManager } from '@immich/ui';
  import { t } from 'svelte-i18n';
  import './access.css';

  let { onSessionsChanged }: { onSessionsChanged?: () => void } = $props();

  const change = async () => {
    const result = await modalManager.show(PasswordDialog, {});
    if (result?.signedOutOthers) {
      onSessionsChanged?.();
    }
  };
</script>

<section class="fl-access-section" aria-labelledby="fl-access-password">
  <div class="fl-access-head">
    <div>
      <h3 id="fl-access-password">{$t('frameleaf_access_password_title')}</h3>
      <p>
        {authManager.user.shouldChangePassword
          ? $t('frameleaf_access_password_change_required')
          : $t('frameleaf_access_password_description')}
      </p>
    </div>
    <Button onclick={change}>{$t('frameleaf_access_password_change')}</Button>
  </div>
</section>
