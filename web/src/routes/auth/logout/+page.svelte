<script lang="ts">
  import AuthShell from '$lib/components/frameleaf/AuthShell.svelte';
  import Spinner from '$lib/components/frameleaf/Spinner.svelte';
  import { consumeLogoutPreference } from '$lib/frameleaf/auth-session-preference';
  import { goto } from '$app/navigation';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { Route } from '$lib/route';
  import { t } from 'svelte-i18n';

  consumeLogoutPreference();
  // FL-1771: when the server could not end the session, the person is still signed in; leave the
  // "Signing out" page rather than wait on it or pretend the sign-out happened
  void authManager.logout().then((signedOut) => {
    if (signedOut) {
      return;
    }
    if (history.length > 1) {
      history.back();
    } else {
      void goto(Route.photos(), { replaceState: true });
    }
  });
</script>

<AuthShell withHeader={false}>
  <div class="auth-signing-out" role="status">
    <Spinner size="xl" decorative />
    <span>{$t('frameleaf_auth_signing_out')}</span>
  </div>
</AuthShell>
