<script lang="ts">
  /** What this server calls a household. The name stays here: the other server never sees it. */
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import { handleError } from '$lib/utils/handle-error';
  import { updateHouseholdLink, type HouseholdLinkDto } from '@frameleaf/sdk';
  import { untrack } from 'svelte';
  import { t } from 'svelte-i18n';

  let {
    link,
    open = $bindable(false),
    onRenamed,
  }: {
    link: HouseholdLinkDto;
    open?: boolean;
    onRenamed: (link: HouseholdLinkDto) => void;
  } = $props();

  let name = $state(untrack(() => link.householdName));
  let busy = $state(false);
  const next = $derived(name.trim());

  const save = async () => {
    busy = true;
    try {
      const renamed = await updateHouseholdLink({ id: link.id, householdLinkUpdateDto: { householdName: next } });
      open = false;
      onRenamed(renamed);
    } catch (error) {
      handleError(error, $t('frameleaf_households_error'));
    } finally {
      busy = false;
    }
  };
</script>

<Dialog
  title={$t('frameleaf_households_rename_title', { values: { name: link.householdName } })}
  closeLabel={$t('close')}
  bind:open
>
  {#snippet actions()}
    <Button onclick={() => (open = false)}>{$t('cancel')}</Button>
    <Button variant="primary" disabled={busy || !next || next === link.householdName} onclick={() => void save()}>
      {$t('save')}
    </Button>
  {/snippet}
  <p class="lead">{$t('frameleaf_households_rename_lead', { values: { server: link.peerName } })}</p>
  <label class="field">
    <span>{$t('frameleaf_households_rename_field')}</span>
    <input data-initial-focus bind:value={name} maxlength="80" autocomplete="off" />
    <small>{$t('frameleaf_households_name_help')}</small>
  </label>
</Dialog>

<style>
  .lead {
    margin: 0 0 var(--fl-space-5);
    color: var(--fl-muted);
    line-height: 1.55;
  }
  .field {
    display: grid;
    gap: var(--fl-space-2);
  }
  .field > span {
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
    font-weight: 600;
  }
  .field input {
    width: 100%;
    min-height: 40px;
    padding: 0 var(--fl-space-3);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
    background: var(--fl-raised);
    color: var(--fl-text);
    font: inherit;
  }
  .field small {
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
    line-height: 1.5;
  }
</style>
