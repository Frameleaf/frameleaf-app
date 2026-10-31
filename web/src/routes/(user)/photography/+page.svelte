<script lang="ts">
  import { goto } from '$app/navigation';
  import ClientsIntro from '$lib/components/frameleaf/ClientsIntro.svelte';
  import PhotographyWorkspace from '$lib/components/frameleaf/PhotographyWorkspace.svelte';
  import UserPageLayout from '$lib/components/layouts/UserPageLayout.svelte';
  import { isClientsEnabled } from '$lib/frameleaf/navigation';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { Route } from '$lib/route';
  import { handleError } from '$lib/utils/handle-error';
  import { updateMyPreferences } from '@frameleaf/sdk';
  import { toastManager } from '@frameleaf/ui';
  import { t } from 'svelte-i18n';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  /**
   * Clients is opt-in (owner, October 28): until the account starts using it, this page is the
   * introduction; once started it is the workspace, and Clients sits in the top bar. The choice is
   * the account's own `clients.enabled` preference, so it follows the account to every device.
   */
  const enabled = $derived(authManager.authenticated && isClientsEnabled(authManager.preferences));
  let saving = $state(false);
  /** Removing from the top bar keeps the workspace on screen until Library opens, never the introduction. */
  let leaving = $state(false);

  const setClients = async (on: boolean) => {
    if (saving) {
      return false;
    }
    saving = true;
    try {
      authManager.setPreferences(await updateMyPreferences({ userPreferencesUpdateDto: { clients: { enabled: on } } }));
      return true;
    } catch (error) {
      handleError(error, $t('frameleaf_clients_update_failed'));
      return false;
    } finally {
      saving = false;
    }
  };

  const start = () => void setClients(true);

  /** "Remove from the top bar": Clients goes back under Tools; shoots and galleries are kept. */
  const removeFromTopBar = async () => {
    leaving = true;
    if (await setClients(false)) {
      await goto(Route.photos());
      toastManager.primary($t('frameleaf_clients_removed'));
    }
    leaving = false;
  };
</script>

<UserPageLayout rail={false} fill>
  {#if enabled || leaving}
    <PhotographyWorkspace
      initialShoot={data.shoot}
      initialSection={data.section}
      onRemoveFromTopBar={removeFromTopBar}
      removing={saving}
    />
  {:else}
    <ClientsIntro onStart={start} starting={saving} />
  {/if}
</UserPageLayout>
