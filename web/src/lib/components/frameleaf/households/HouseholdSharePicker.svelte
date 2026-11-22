<script lang="ts">
  /**
   * "Other households" in the Share sheet (prototype `ShareSheet`, LinkedHouseholds.jsx): people on
   * linked servers, by name with their household under it, a role, and Invite. There is no search
   * by address because no address exists for these people.
   */
  import Button from '$lib/components/frameleaf/Button.svelte';
  import type {
    HouseholdCandidate,
    HouseholdShareState,
  } from '$lib/components/frameleaf/households/household-share.svelte';
  import { rovingFocus } from '$lib/frameleaf/roving-focus';
  import { handleError } from '$lib/utils/handle-error';
  import { Icon } from '@frameleaf/ui';
  import { mdiAccountPlusOutline, mdiInformationOutline } from '@mdi/js';
  import { t } from 'svelte-i18n';

  let { share }: { share: HouseholdShareState } = $props();

  let picked = $state<string>();
  let role = $state('viewer');

  const keyOf = (candidate: HouseholdCandidate) => `${candidate.linkId}:${candidate.id}`;
  const chosen = $derived(share.candidates.find((candidate) => keyOf(candidate) === picked));
  const unreachable = $derived(share.links.filter((link) => !link.reachable));
  const initials = (name: string) =>
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase())
      .join('');
  const roleName = (value: string) =>
    value === 'contributor' ? $t('frameleaf_households_role_contributor') : $t('frameleaf_album_role_viewer');

  const invite = async () => {
    if (!chosen) {
      return;
    }
    const { name } = chosen;
    try {
      await share.invite(chosen, role);
      share.said = $t('frameleaf_households_share_invited', { values: { name, role: roleName(role) } });
      picked = undefined;
    } catch (error) {
      handleError(error, $t('frameleaf_households_error'));
    }
  };
</script>

<section class="others" aria-labelledby="household-share-title">
  <h3 id="household-share-title">{$t('frameleaf_households_share_section')}</h3>
  {#if share.links.length === 0}
    <p class="lead">{$t('frameleaf_households_share_none')}</p>
  {:else}
    <p class="lead">{$t('frameleaf_households_share_lead')}</p>
    {#each unreachable as link (link.linkId)}
      <p class="said" role="status">
        <Icon icon={mdiInformationOutline} size="16" aria-hidden />
        {$t('frameleaf_households_share_unreachable', { values: { name: link.householdName } })}
      </p>
    {/each}
    {#if share.candidates.length === 0}
      {#if unreachable.length === 0}
        <p class="lead">{$t('frameleaf_households_share_no_people')}</p>
      {/if}
    {:else}
      <ul role="listbox" use:rovingFocus aria-label={$t('frameleaf_households_share_people')}>
        {#each share.candidates as candidate (keyOf(candidate))}
          <li>
            <button
              type="button"
              role="option"
              aria-selected={picked === keyOf(candidate)}
              onclick={() => (picked = picked === keyOf(candidate) ? undefined : keyOf(candidate))}
            >
              <span class="initials" aria-hidden="true">{initials(candidate.name)}</span>
              <span class="who">
                {candidate.name}
                <small>
                  {$t('frameleaf_households_household_name', { values: { name: candidate.householdName } })}
                </small>
              </span>
            </button>
          </li>
        {/each}
      </ul>
      <div class="invite-row">
        <label>
          {$t('role')}
          <select bind:value={role} disabled={share.busy}>
            <option value="viewer">{$t('frameleaf_album_role_viewer')}</option>
            <option value="contributor">{$t('frameleaf_households_role_contributor')}</option>
          </select>
        </label>
        <Button variant="primary" disabled={share.busy || !chosen} onclick={() => void invite()}>
          <Icon icon={mdiAccountPlusOutline} size="16" aria-hidden />
          {$t('frameleaf_album_share_invite')}
        </Button>
      </div>
      <p class="lead">
        {role === 'contributor'
          ? $t('frameleaf_households_role_contributor_help')
          : $t('frameleaf_households_role_viewer_help')}
      </p>
    {/if}
  {/if}
  {#if share.said}
    <p class="said" role="status">
      <Icon icon={mdiInformationOutline} size="16" aria-hidden />
      {share.said}
    </p>
  {/if}
</section>

<style>
  .others {
    display: flex;
    flex-direction: column;
    gap: 10px;
    margin-top: var(--fl-space-1);
  }
  h3 {
    margin: 0;
    color: var(--fl-muted);
    font-size: 0.75rem;
    font-weight: 600;
    letter-spacing: 0.01em;
  }
  .lead {
    margin: 0;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
    line-height: 1.5;
  }
  ul {
    max-height: 14rem;
    margin: 0;
    padding: 0;
    overflow-y: auto;
    list-style: none;
  }
  li button {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    min-height: 48px;
    padding: 5px 8px;
    border: 1px solid transparent;
    border-radius: var(--fl-radius-control);
    background: none;
    color: var(--fl-text);
    font: inherit;
    text-align: start;
    cursor: pointer;
  }
  li button:hover {
    background: var(--fl-raised);
  }
  li button[aria-selected='true'] {
    border-color: var(--fl-accent);
    background: var(--fl-accent-soft);
  }
  .initials {
    display: grid;
    flex-shrink: 0;
    place-items: center;
    width: 28px;
    height: 28px;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-sm);
    background: var(--fl-raised);
    color: var(--fl-muted);
    font-size: var(--fl-font-micro);
  }
  .who small {
    display: block;
    color: var(--fl-muted);
    font-size: var(--fl-font-micro);
  }
  .invite-row {
    display: flex;
    align-items: end;
    gap: 10px;
  }
  .invite-row label {
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: 6px;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  select {
    width: 100%;
    min-height: var(--fl-control-height);
    padding: 0 var(--fl-space-2);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
    background: var(--fl-raised);
    color: var(--fl-text);
    font: inherit;
  }
  .said {
    display: flex;
    align-items: flex-start;
    gap: var(--fl-space-2);
    margin: 0;
    padding: 10px var(--fl-space-3);
    border-radius: var(--fl-radius-control);
    background: var(--fl-raised);
    font-size: var(--fl-font-small);
    line-height: 1.5;
  }
  .said :global(svg) {
    flex-shrink: 0;
    margin-top: 1px;
    color: var(--fl-muted);
  }
</style>
