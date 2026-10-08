<script lang="ts">
  import AuthShell from '$lib/components/frameleaf/AuthShell.svelte';
  import Spinner from '$lib/components/frameleaf/Spinner.svelte';
  import { consumeLogoutPreference } from '$lib/frameleaf/auth-session-preference';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { t } from 'svelte-i18n';

  consumeLogoutPreference();
  void authManager.logout();
</script>

<AuthShell withHeader={false}>
  <div class="auth-signing-out" role="status">
    <Spinner size="xl" decorative />
    <span>{$t('frameleaf_auth_signing_out')}</span>
  </div>
</AuthShell>
