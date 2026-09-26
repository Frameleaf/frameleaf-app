<script lang="ts">
  import AccountSetupTool from '$lib/components/frameleaf/setup/AccountSetupTool.svelte';
  import FirstRunSetup from '$lib/components/frameleaf/setup/FirstRunSetup.svelte';
  import { loadLocalSetup, resumeSetup } from '$lib/frameleaf/first-run-setup';
  import type { PageData } from './$types';

  const { data }: { data: PageData } = $props();
</script>

{#if data.mode === 'setup' && data.flow}
  {#key data.flow}
    <FirstRunSetup
      initial={resumeSetup(
        data.flow,
        { server: data.saved?.progress, local: loadLocalSetup(data.flow) },
        data.signedIn,
      )}
      authenticated={data.signedIn}
    />
  {/key}
{:else}
  <AccountSetupTool />
{/if}
