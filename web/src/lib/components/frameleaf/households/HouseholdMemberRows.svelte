<script lang="ts">
  /**
   * People from linked households under "Who has access": name, household badge, and their state
   * (invited, a role, or left). Rendered as `<li>`s inside the sheet's own member list. Removing an
   * accepted person asks first and says they keep their copies; withdrawing an invitation and
   * clearing someone who already left change nothing they hold, so those happen at once.
   */
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import HouseholdTag from '$lib/components/frameleaf/households/HouseholdTag.svelte';
  import type {
    HouseholdMember,
    HouseholdShareState,
  } from '$lib/components/frameleaf/households/household-share.svelte';
  import { handleError } from '$lib/utils/handle-error';
  import { Icon } from '@frameleaf/ui';
  import { mdiClose } from '@mdi/js';
  import { t } from 'svelte-i18n';

  let { share }: { share: HouseholdShareState } = $props();

  let removing = $state<{ open: boolean; member?: HouseholdMember }>({ open: false });

  const initials = (name: string) =>
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase())
      .join('');

  const changeRole = async (member: HouseholdMember, select: HTMLSelectElement) => {
    try {
      await share.setRole(member, select.value);
    } catch (error) {
      select.value = member.role;
      handleError(error, $t('frameleaf_households_error'));
    }
  };

  const remove = async (member: HouseholdMember, said?: string) => {
    try {
      await share.remove(member);
      share.said = said ?? '';
      removing.open = false;
    } catch (error) {
      handleError(error, $t('frameleaf_households_error'));
    }
  };
</script>

{#each share.members as member (`${member.shareId}:${member.remoteUserId}`)}
  {@const left = member.state === 'left'}
  {@const pending = member.state === 'invited'}
  <li class="remote" class:left>
    <span class="initials" aria-hidden="true">{initials(member.displayName)}</span>
    <span class="who">
      <span class="line">
        <strong>{member.displayName}</strong>
        <HouseholdTag name={member.householdName} />
      </span>
      {#if pending}<small>{$t('frameleaf_households_share_pending')}</small>{/if}
      {#if left}<small>{$t('frameleaf_households_share_left')}</small>{/if}
    </span>
    {#if !left}
      <label>
        <span class="sr-only">{$t('frameleaf_households_role_for', { values: { name: member.displayName } })}</span>
        <select
          value={member.role}
          disabled={share.busy}
          onchange={(event) => void changeRole(member, event.currentTarget)}
        >
          <option value="viewer">{$t('frameleaf_album_role_viewer')}</option>
          <option value="contributor">{$t('frameleaf_households_role_contributor')}</option>
        </select>
      </label>
    {/if}
    <button
      type="button"
      class="remove fl-control"
      disabled={share.busy}
      aria-label={left
        ? $t('frameleaf_households_clear', { values: { name: member.displayName } })
        : pending
          ? $t('frameleaf_households_cancel_invite', { values: { name: member.displayName } })
          : $t('frameleaf_households_remove_for', { values: { name: member.displayName } })}
      onclick={() => (left || pending ? void remove(member) : (removing = { open: true, member }))}
    >
      <Icon icon={mdiClose} size="18" aria-hidden />
    </button>
  </li>
{/each}

{#if removing.member}
  {@const member = removing.member}
  <Dialog
    title={$t('frameleaf_households_remove_title', { values: { name: member.displayName } })}
    closeLabel={$t('close')}
    bind:open={removing.open}
  >
    {#snippet actions()}
      <Button initialFocus onclick={() => (removing.open = false)}>{$t('cancel')}</Button>
      <Button
        variant="danger"
        disabled={share.busy}
        onclick={() =>
          void remove(member, $t('frameleaf_households_removed', { values: { name: member.displayName } }))}
      >
        {$t('frameleaf_households_remove_confirm')}
      </Button>
    {/snippet}
    <div class="remove-who">
      <span class="initials large" aria-hidden="true">{initials(member.displayName)}</span>
      <div>
        <strong>{member.displayName}</strong>
        <HouseholdTag name={member.householdName} />
      </div>
    </div>
    <p class="body">{$t('frameleaf_households_remove_body', { values: { name: member.displayName } })}</p>
  </Dialog>
{/if}

<style>
  .remote {
    display: flex;
    align-items: center;
    gap: 0.625rem;
    min-height: 45px;
  }
  .initials {
    display: grid;
    flex-shrink: 0;
    place-items: center;
    width: 30px;
    height: 30px;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-sm);
    background: var(--fl-raised);
    color: var(--fl-muted);
    font-size: var(--fl-font-micro);
  }
  .initials.large {
    width: 40px;
    height: 40px;
    font-size: var(--fl-font-small);
  }
  .who {
    display: flex;
    flex: 1;
    flex-direction: column;
    min-width: 0;
  }
  .line {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--fl-space-1) var(--fl-space-2);
  }
  .who strong {
    color: var(--fl-text);
    font-size: 0.875rem;
    font-weight: 400;
  }
  .who small {
    color: var(--fl-muted);
    font-size: var(--fl-font-micro);
  }
  .left .who,
  .left .initials {
    opacity: 0.65;
  }
  select {
    min-height: 34px;
    padding: 0 var(--fl-space-2);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
    background: var(--fl-raised);
    color: var(--fl-text);
    font-size: 0.875rem;
  }
  .remove {
    display: grid;
    flex-shrink: 0;
    place-items: center;
    width: 42px;
    min-height: 34px;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
    background: var(--fl-raised);
    color: var(--fl-text);
  }
  .remove:disabled {
    opacity: 0.6;
  }
  .remove-who {
    display: flex;
    align-items: center;
    gap: var(--fl-space-3);
    margin-bottom: var(--fl-space-4);
  }
  .remove-who > div {
    display: grid;
    justify-items: start;
    gap: var(--fl-space-1);
  }
  .body {
    margin: 0;
    color: var(--fl-muted);
    line-height: 1.55;
  }
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    margin: -1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
</style>
