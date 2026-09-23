<script lang="ts">
  import Dialog from './Dialog.svelte';
  import SharedLinkForm from './SharedLinkForm.svelte';
  import UserAvatar from '$lib/components/shared-components/UserAvatar.svelte';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { handleError } from '$lib/utils/handle-error';
  import {
    createPartner,
    getPartners,
    PartnerDirection,
    removePartner,
    searchUsers,
    SharedLinkType,
    type UserResponseDto,
  } from '@immich/sdk';
  import { toastManager } from '@immich/ui';
  import { t } from 'svelte-i18n';

  let {
    open = $bindable(false),
    assetIds,
  }: {
    open?: boolean;
    assetIds: string[];
  } = $props();

  let mode: 'people' | 'link' = $state('people');
  let people: UserResponseDto[] = $state([]);
  let recipients: Set<string> = $state(new Set());
  let initialRecipients: Set<string> = $state(new Set());
  let loading = $state(true);
  let saving = $state(false);
  let linkFormOpen = $state(false);

  const subject = $derived($t('frameleaf_sharing.individual_items', { values: { count: assetIds.length } }));

  const loadPeople = async () => {
    loading = true;
    try {
      const [users, partners] = await Promise.all([
        searchUsers(),
        getPartners({ direction: PartnerDirection.SharedBy }),
      ]);
      people = users.filter((user) => user.id !== authManager.user.id);
      recipients = new Set(partners.map((partner) => partner.id));
      initialRecipients = new Set(recipients);
    } finally {
      loading = false;
    }
  };

  $effect(() => {
    if (!open) {
      return;
    }

    mode = 'people';
    void loadPeople();
  });

  const toggle = (id: string) => {
    const next = new Set(recipients);
    if (next.has(id)) {
      next.delete(id);
    } else {
      next.add(id);
    }
    recipients = next;
  };

  const selectedNames = $derived(people.filter((person) => recipients.has(person.id)).map((person) => person.name));

  const primaryLabel = $derived(
    selectedNames.length === 1
      ? $t('frameleaf_sharing.share_with_person', { values: { name: selectedNames[0] } })
      : selectedNames.length > 1
        ? $t('frameleaf_sharing.share_with_count', { values: { count: selectedNames.length } })
        : $t('frameleaf_sharing.save_sharing'),
  );

  /** Members of `set` that `other` lacks (Set#difference is newer than the supported browsers). */
  const onlyIn = (set: Set<string>, other: Set<string>) => {
    const result: string[] = [];
    for (const id of set) {
      if (!other.has(id)) {
        result.push(id);
      }
    }
    return result;
  };

  const saveSharing = async () => {
    saving = true;
    const toAdd = onlyIn(recipients, initialRecipients);
    const toRemove = onlyIn(initialRecipients, recipients);
    try {
      await Promise.all(toAdd.map((sharedWithId) => createPartner({ partnerCreateDto: { sharedWithId } })));
    } catch (error) {
      handleError(error, $t('errors.unable_to_add_partners'));
      saving = false;
      return;
    }
    try {
      await Promise.all(toRemove.map((id) => removePartner({ id })));
    } catch (error) {
      handleError(error, $t('errors.unable_to_remove_partner'));
      saving = false;
      return;
    }
    toastManager.primary($t('saved'));
    saving = false;
    open = false;
  };

  const linkTarget = $derived({ type: SharedLinkType.Individual, assetIds, name: subject });
  const openLinkForm = () => {
    open = false;
    linkFormOpen = true;
  };

  const modeKeys = (event: KeyboardEvent) => {
    if (!['ArrowRight', 'ArrowLeft', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
      return;
    }
    event.preventDefault();
    const next = mode === 'people' ? 'link' : 'people';
    mode = next;
    (event.currentTarget as HTMLElement).querySelector<HTMLElement>(`[data-mode="${CSS.escape(next)}"]`)?.focus();
  };
</script>

<Dialog title={$t('frameleaf_sharing.share_subject', { values: { subject } })} closeLabel={$t('close')} bind:open>
  <div class="ss-options" role="radiogroup" aria-label={$t('share')} onkeydown={modeKeys}>
    <button
      type="button"
      role="radio"
      data-mode="people"
      aria-checked={mode === 'people'}
      tabindex={mode === 'people' ? 0 : -1}
      class="ss-option"
      onclick={() => (mode = 'people')}
    >
      <strong>{$t('frameleaf_sharing.people_option_title')}</strong>
      <small>{$t('frameleaf_sharing.people_option_description')}</small>
    </button>
    <button
      type="button"
      role="radio"
      data-mode="link"
      aria-checked={mode === 'link'}
      tabindex={mode === 'link' ? 0 : -1}
      class="ss-option"
      onclick={() => (mode = 'link')}
    >
      <strong>{$t('frameleaf_sharing.link_option_title')}</strong>
      <small>{$t('frameleaf_sharing.link_option_description')}</small>
    </button>
  </div>

  {#if mode === 'people'}
    {#if loading}
      <p role="status">{$t('loading')}</p>
    {:else if people.length}
      <div class="ss-people" role="group" aria-label={$t('share')}>
        {#each people as person (person.id)}
          {@const selected = recipients.has(person.id)}
          <button
            type="button"
            class="ss-person"
            class:is-selected={selected}
            aria-pressed={selected}
            aria-label={person.name}
            onclick={() => toggle(person.id)}
          >
            <span class="ss-person-avatar" aria-hidden="true">
              <UserAvatar user={person} size="lg" />
            </span>
            <span class="ss-person-name" aria-hidden="true">{person.name}</span>
          </button>
        {/each}
      </div>
      <div class="ss-actions">
        <button type="button" onclick={() => (open = false)}>{$t('cancel')}</button>
        <button type="button" class="primary" disabled={saving} onclick={saveSharing}>{primaryLabel}</button>
      </div>
    {:else}
      <p class="muted">{$t('frameleaf_sharing.no_other_people')}</p>
    {/if}
  {:else}
    <p class="ss-link-copy">{$t('frameleaf_sharing.link_option_description')}</p>
    <div class="ss-actions">
      <button type="button" onclick={() => (open = false)}>{$t('cancel')}</button>
      <button type="button" class="primary" onclick={openLinkForm}>{$t('frameleaf_sharing.create_public_link')}</button>
    </div>
  {/if}
</Dialog>

<SharedLinkForm bind:open={linkFormOpen} target={linkTarget} />

<style>
  .ss-options {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0.5rem;
    margin-bottom: 1rem;
  }
  .ss-option {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    text-align: start;
    background: var(--fl-raised);
    color: var(--fl-text);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius);
    padding: 0.75rem;
  }
  .ss-option[aria-checked='true'] {
    border-color: var(--fl-accent);
  }
  .ss-option small {
    color: var(--fl-muted);
  }
  .ss-people {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(4.5rem, 1fr));
    gap: 0.75rem;
    max-height: 16rem;
    overflow-y: auto;
  }
  .ss-person {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.375rem;
    background: transparent;
    border: 0;
    color: var(--fl-text);
  }
  .ss-person-avatar {
    display: inline-flex;
    border-radius: 50%;
    outline: 2px solid transparent;
    outline-offset: 2px;
  }
  .ss-person.is-selected .ss-person-avatar {
    outline-color: var(--fl-accent);
  }
  .ss-person-name {
    font-size: 0.75rem;
    overflow-wrap: anywhere;
    text-align: center;
  }
  .ss-link-copy {
    color: var(--fl-muted);
  }
  .ss-actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
    margin-top: 1rem;
  }
  .ss-actions button {
    background: var(--fl-raised);
    color: var(--fl-text);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius);
    padding: 0 0.75rem;
  }
  .ss-actions button.primary {
    background: var(--fl-accent);
    color: var(--fl-accent-text);
    border-color: var(--fl-accent);
  }
  .muted {
    color: var(--fl-muted);
  }
</style>
