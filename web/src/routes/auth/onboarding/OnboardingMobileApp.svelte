<script lang="ts">
  /**
   * Onboarding → Get the mobile app (FL-80 ON-1, O-12): the prototype's step
   * (`AuthScreens.jsx:1111-1147`) — this server's address to enter in the app and store-style
   * choices. Frameleaf's apps come from this server's signed releases (FL-82), so the two choices open
   * the existing application setup (downloads, or Obtainium) in a dialog instead of linking to app
   * stores; onboarding continues afterwards.
   */
  import ApplicationSetup from '$lib/components/frameleaf/ApplicationSetup.svelte';
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import { Icon } from '@immich/ui';
  import { mdiCellphoneArrowDownVariant, mdiOpenInNew, mdiPackageVariant } from '@mdi/js';
  import { t } from 'svelte-i18n';

  let setup = $state<'downloads' | 'obtainium' | null>(null);
  let open = $state(false);
  const show = (tool: 'downloads' | 'obtainium') => {
    setup = tool;
    open = true;
  };

  const choices = [
    {
      tool: 'downloads',
      icon: mdiCellphoneArrowDownVariant,
      label: 'library_care_tool_downloads',
      hint: 'frameleaf_onboarding_mobile_downloads_hint',
    },
    {
      tool: 'obtainium',
      icon: mdiPackageVariant,
      label: 'library_care_tool_obtainium',
      hint: 'frameleaf_onboarding_mobile_obtainium_hint',
    },
  ] as const;
</script>

<p>
  {$t('frameleaf_onboarding_mobile_body_before')}
  <code class="auth-server">{location.origin}</code>
  {$t('frameleaf_onboarding_mobile_body_after')}
</p>
<div class="ob-stores">
  {#each choices as choice (choice.tool)}
    <button type="button" class="ob-store" onclick={() => show(choice.tool)}>
      <Icon icon={choice.icon} size="26" aria-hidden={true} />
      <span>
        <strong>{$t(choice.label)}</strong>
        <small>{$t(choice.hint)}</small>
      </span>
      <Icon icon={mdiOpenInNew} size="16" aria-hidden={true} />
    </button>
  {/each}
</div>

{#if setup}
  <Dialog
    title={setup === 'obtainium' ? $t('library_care_tool_obtainium') : $t('library_care_tool_downloads')}
    closeLabel={$t('close')}
    wide
    bind:open
  >
    {#key setup}
      <ApplicationSetup tool={setup} onLeave={() => (open = false)} />
    {/key}
  </Dialog>
{/if}
