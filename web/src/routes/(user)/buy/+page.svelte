<script lang="ts">
  import { goto } from '$app/navigation';
  import UserPageLayout from '$lib/components/layouts/UserPageLayout.svelte';
  import LicenseActivationSuccess from '$lib/components/shared-components/purchasing/PurchaseActivationSuccess.svelte';
  import LicenseContent from '$lib/components/shared-components/purchasing/PurchaseContent.svelte';
  import SupporterBadge from './SupporterBadge.svelte';
  import { frameleafShell } from '$lib/frameleaf/rollout';
  import '$lib/frameleaf/tokens.css';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { Route } from '$lib/route';
  import { Alert, Container, Stack, Theme as AppTheme, themeManager } from '@immich/ui';
  import { mdiAlertCircleOutline } from '@mdi/js';
  import { t } from 'svelte-i18n';
  import type { PageData } from './$types';

  interface Props {
    data: PageData;
  }

  let { data }: Props = $props();
  let showLicenseActivated = $state(false);

  // Frameleaf shell rollout (FL-30/FL-80): the supporter page keeps the production
  // license/activation endpoints and success flow; only the surrounding card is restyled.
  const appTheme = $derived(themeManager.value === AppTheme.Dark ? 'dark' : 'light');
</script>

<UserPageLayout title={data.meta.title}>
  <Container size="medium" center>
    <div
      class:frameleaf={$frameleafShell}
      class:fl-supporter-panel={$frameleafShell}
      data-theme={$frameleafShell ? appTheme : undefined}
    >
      <Stack gap={4} class="mt-4">
        {#if data.isActivated === false}
          <Alert icon={mdiAlertCircleOutline} color="danger" title={$t('purchase_failed_activation')} />
        {/if}

        {#if authManager.isPurchased}
          <SupporterBadge logoSize="lg" centered />
        {/if}

        {#if showLicenseActivated || data.isActivated === true}
          <LicenseActivationSuccess onDone={() => goto(Route.photos(), { replaceState: false })} />
        {:else}
          <LicenseContent
            onActivate={() => {
              showLicenseActivated = true;
            }}
          />
        {/if}
      </Stack>
    </div>
  </Container>
</UserPageLayout>

<style>
  .fl-supporter-panel {
    padding: 1.5rem;
    color: var(--fl-text);
    background: var(--fl-panel);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-dialog);
    box-shadow: var(--fl-shadow-1);
  }
</style>
