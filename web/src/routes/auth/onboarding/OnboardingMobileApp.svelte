<script lang="ts">
  /** Onboarding → mobile app (FL-82): the same application setup as Library Care, from this server's signed releases. */
  import ApplicationSetup from '$lib/components/frameleaf/ApplicationSetup.svelte';
  import { Button, HStack } from '@immich/ui';
  import { mdiCellphoneArrowDownVariant, mdiLinkEdit } from '@mdi/js';
  import { t } from 'svelte-i18n';

  let setup = $state<'downloads' | 'obtainium' | null>(null);
  let setupOpen = $state(false);
  const show = (tool: 'downloads' | 'obtainium') => {
    setup = tool;
    setupOpen = true;
  };
</script>

<p>{$t('mobile_app_download_onboarding_note')}</p>

<HStack>
  <Button
    size="medium"
    shape="semi-round"
    fullWidth
    onclick={() => show('downloads')}
    leadingIcon={mdiCellphoneArrowDownVariant}
  >
    {$t('library_care_tool_downloads')}
  </Button>

  <Button size="medium" shape="semi-round" fullWidth onclick={() => show('obtainium')} leadingIcon={mdiLinkEdit}>
    {$t('library_care_tool_obtainium')}
  </Button>
</HStack>

{#if setup}
  {#key setup}
    <ApplicationSetup tool={setup} bind:open={setupOpen} />
  {/key}
{/if}
