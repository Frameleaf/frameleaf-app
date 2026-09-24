<script lang="ts">
  /** Onboarding → Welcome (FL-80 ON-1): the prototype's hello step (`AuthScreens.jsx:895-917`). */
  import cabin from '$lib/assets/frameleaf/auth-cabin.webp';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { serverConfigManager } from '$lib/managers/server-config-manager.svelte';
  import { t } from 'svelte-i18n';

  const server = $derived(authManager.user.isAdmin && !serverConfigManager.value.isOnboarded);
</script>

<div class="ob-hello">
  <div class="ob-hero"><img src={cabin} alt="" /></div>
  <p>
    {server
      ? $t('frameleaf_onboarding_hello_server', { values: { user: authManager.user.name } })
      : $t('frameleaf_onboarding_hello_user', { values: { user: authManager.user.name } })}
  </p>
  <ul class="ob-list">
    <li>
      <strong>{$t('frameleaf_onboarding_hello_minutes')}</strong> — {server
        ? $t('frameleaf_onboarding_hello_minutes_server')
        : $t('frameleaf_onboarding_hello_minutes_user')}
    </li>
    <li>
      <strong>{$t('frameleaf_onboarding_hello_local')}</strong> — {$t('frameleaf_onboarding_hello_local_detail')}
    </li>
  </ul>
</div>
