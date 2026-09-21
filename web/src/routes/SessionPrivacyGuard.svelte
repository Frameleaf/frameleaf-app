<script lang="ts">
  import { afterNavigate } from '$app/navigation';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { watchSessionPrivacy } from '$lib/utils/session-privacy-guard';
  import { onMount } from 'svelte';

  let guard: ReturnType<typeof watchSessionPrivacy> | undefined;
  onMount(() => {
    guard = watchSessionPrivacy(() => authManager.authenticated);
    return () => guard?.dispose();
  });
  afterNavigate(() => void guard?.refresh());
</script>
