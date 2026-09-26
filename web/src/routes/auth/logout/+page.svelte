<script lang="ts">
  import { consumeLogoutPreference } from '$lib/frameleaf/auth-session-preference';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { LoadingSpinner } from '@immich/ui';

  consumeLogoutPreference();
  void authManager.logout();
</script>

<div class="h-screen w-screen overflow-hidden">
  <div class="m-auto">
    <LoadingSpinner />
  </div>
</div>
