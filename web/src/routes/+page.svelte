<script lang="ts">
  import AuthPageLayout from '$lib/components/layouts/AuthPageLayout.svelte';
  import { Route } from '$lib/route';
  import { websocketStore } from '$lib/stores/websocket';
  import { handleError } from '$lib/utils/handle-error';
  import { waitForOnboardingMaintenance } from '$lib/utils/onboarding-maintenance';
  import { startDatabaseRestoreFlow } from '@frameleaf/sdk';
  import { Button, Heading, Stack } from '@frameleaf/ui';
  import { onDestroy } from 'svelte';
  import { t } from 'svelte-i18n';

  let restart: AbortController | undefined;
  onDestroy(() => restart?.abort());

  async function switchToMaintenance() {
    if (restart) {
      return;
    }
    const owner = new AbortController();
    restart = owner;
    try {
      await startDatabaseRestoreFlow({ signal: owner.signal });
      owner.signal.throwIfAborted();
      websocketStore.serverRestarting.set({
        isMaintenanceMode: true,
      });
      await waitForOnboardingMaintenance(owner.signal);
    } catch (error) {
      if (owner.signal.aborted) {
        return;
      }
      websocketStore.serverRestarting.set(undefined);
      handleError(error, $t('admin.maintenance_start_error'));
    } finally {
      restart = undefined;
    }
  }
</script>

<AuthPageLayout>
  <div class="flex flex-col place-items-center gap-12 text-center">
    <Heading size="large" color="primary" tag="h1">{$t('welcome_to_immich')}</Heading>
    <Stack>
      <Button href={Route.register()} size="large" shape="round">
        <span class="px-2 font-semibold">{$t('getting_started')}</span>
      </Button>
      <Button size="small" shape="round" variant="ghost" onclick={switchToMaintenance}>
        <span class="px-2 font-semibold">{$t('maintenance_restore_from_backup')}</span>
      </Button>
    </Stack>
  </div>
</AuthPageLayout>
