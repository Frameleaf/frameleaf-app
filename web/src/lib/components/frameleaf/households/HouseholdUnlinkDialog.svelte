<script lang="ts">
  /** Unlinking asks first, and says the one thing people fear: nothing is deleted on either side. */
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import Notice from '$lib/components/frameleaf/settings/kit/Notice.svelte';
  import { handleError } from '$lib/utils/handle-error';
  import { endHouseholdLink, type HouseholdLinkDto } from '@frameleaf/sdk';
  import { mdiShieldCheckOutline } from '@mdi/js';
  import { t } from 'svelte-i18n';

  let {
    link,
    open = $bindable(false),
    onUnlinked,
  }: {
    link: HouseholdLinkDto;
    open?: boolean;
    onUnlinked: (link: HouseholdLinkDto) => void;
  } = $props();

  let busy = $state(false);

  const unlink = async () => {
    busy = true;
    try {
      await endHouseholdLink({ id: link.id });
      open = false;
      onUnlinked(link);
    } catch (error) {
      handleError(error, $t('frameleaf_households_error'));
    } finally {
      busy = false;
    }
  };
</script>

<Dialog
  title={$t('frameleaf_households_unlink_title', { values: { name: link.householdName } })}
  closeLabel={$t('close')}
  bind:open
>
  {#snippet actions()}
    <Button initialFocus onclick={() => (open = false)}>{$t('frameleaf_households_stay_linked')}</Button>
    <Button variant="danger" disabled={busy} onclick={() => void unlink()}>
      {$t('frameleaf_households_unlink_action')}
    </Button>
  {/snippet}
  <Notice tone="info" icon={mdiShieldCheckOutline} title={$t('frameleaf_households_unlink_keep')} />
  <ul>
    <li>{$t('frameleaf_households_unlink_effect_kept')}</li>
    <li>{$t('frameleaf_households_unlink_effect_theirs')}</li>
    <li>{$t('frameleaf_households_unlink_effect_members')}</li>
  </ul>
</Dialog>

<style>
  ul {
    display: grid;
    gap: var(--fl-space-3);
    margin: var(--fl-space-5) 0 0;
    padding: 0 0 0 var(--fl-space-5);
    color: var(--fl-muted);
    line-height: 1.5;
    list-style: disc;
  }
</style>
