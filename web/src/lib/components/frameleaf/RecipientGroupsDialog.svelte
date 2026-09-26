<script lang="ts">
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import Status from '$lib/components/frameleaf/Status.svelte';
  import PersonPhoto from '$lib/components/frameleaf/PersonPhoto.svelte';
  import { handleError } from '$lib/utils/handle-error';
  import {
    createRecipientGroup,
    deleteRecipientGroup,
    updateRecipientGroup,
    type RecipientGroupResponseDto,
    type UserResponseDto,
  } from '@immich/sdk';
  import { Icon } from '@immich/ui';
  import { mdiAccountMultiplePlusOutline, mdiDeleteOutline, mdiPencilOutline } from '@mdi/js';
  import { t } from 'svelte-i18n';

  /**
   * Named recipient shortcuts (FL-55): the owner's saved groups of people to invite together.
   *
   * A group is only a shortcut — the settings policy "Recipient shortcuts do not grant access"
   * (settings-advanced.mjs:620-624) and "Changing a group never changes existing access"
   * (settings-catalog.mjs:866-879). Saving, renaming, editing or deleting one never invites
   * anybody or changes anybody's access; its name is shown to its owner only. The people list and
   * form reuse the prototype's share dialog controls (`ShareDialog`, CollectionHeader.jsx:556-700;
   * `.cl-field`, `.cl-people`, collections.css:127-470).
   */
  interface Props {
    open?: boolean;
    groups: RecipientGroupResponseDto[];
    /** People the owner may put in a group (everyone else with an account). */
    people: UserResponseDto[];
    onChanged: () => Promise<void> | void;
  }

  let { open = $bindable(false), groups, people, onChanged }: Props = $props();

  let editing = $state<{ id?: string; name: string; userIds: string[] } | undefined>();
  let query = $state('');
  let busy = $state(false);
  let status = $state('');
  let error = $state('');

  const needle = $derived(query.trim().toLowerCase());
  const matches = $derived(
    people.filter((user) => !needle || `${user.name} ${user.email}`.toLowerCase().includes(needle)),
  );

  const startNew = () => {
    editing = { name: '', userIds: [] };
    query = '';
    error = '';
  };
  const startEdit = (group: RecipientGroupResponseDto) => {
    editing = { id: group.id, name: group.name, userIds: group.users.map(({ id }) => id) };
    query = '';
    error = '';
  };
  const toggle = (userId: string) => {
    if (!editing) {
      return;
    }
    editing.userIds = editing.userIds.includes(userId)
      ? editing.userIds.filter((id) => id !== userId)
      : [...editing.userIds, userId];
  };

  const save = async () => {
    if (!editing) {
      return;
    }
    const name = editing.name.trim();
    if (!name) {
      error = $t('frameleaf_recipient_groups_name_required');
      return;
    }
    busy = true;
    try {
      if (editing.id) {
        await updateRecipientGroup({ id: editing.id, recipientGroupUpdateDto: { name, userIds: editing.userIds } });
      } else {
        await createRecipientGroup({ recipientGroupCreateDto: { name, userIds: editing.userIds } });
      }
      status = $t('frameleaf_recipient_groups_saved', { values: { name } });
      editing = undefined;
      await onChanged();
    } catch (error_) {
      handleError(error_, $t('frameleaf_recipient_groups_error'));
    } finally {
      busy = false;
    }
  };

  const remove = async (group: RecipientGroupResponseDto) => {
    busy = true;
    try {
      await deleteRecipientGroup({ id: group.id });
      status = $t('frameleaf_recipient_groups_deleted', { values: { name: group.name } });
      if (editing?.id === group.id) {
        editing = undefined;
      }
      await onChanged();
    } catch (error_) {
      handleError(error_, $t('frameleaf_recipient_groups_error'));
    } finally {
      busy = false;
    }
  };
</script>

<Dialog title={$t('frameleaf_recipient_groups_title')} closeLabel={$t('close')} bind:open>
  <div class="groups">
    <p class="note">{$t('frameleaf_recipient_groups_note')}</p>
    <Status message={status} {busy} />

    {#if editing}
      <form
        class="cl-invite"
        onsubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <label class="cl-field">
          <span>{$t('frameleaf_recipient_groups_name')}</span>
          <input
            data-initial-focus
            type="text"
            maxlength="100"
            bind:value={editing.name}
            placeholder={$t('frameleaf_recipient_groups_name_placeholder')}
            aria-invalid={error ? 'true' : undefined}
          />
        </label>
        {#if error}
          <p class="cl-error" role="alert">{error}</p>
        {/if}
        <label class="cl-field">
          <span>{$t('frameleaf_recipient_groups_people')}</span>
          <input type="search" bind:value={query} placeholder={$t('frameleaf_spaces_invite_search')} />
        </label>
        <ul
          class="cl-people"
          role="listbox"
          aria-multiselectable="true"
          aria-label={$t('frameleaf_recipient_groups_people')}
        >
          {#each matches as user (user.id)}
            <li>
              <button
                type="button"
                role="option"
                aria-selected={editing.userIds.includes(user.id)}
                onclick={() => toggle(user.id)}
              >
                <PersonPhoto {user} />
                <span>
                  {user.name}
                  <small>{user.email}</small>
                </span>
              </button>
            </li>
          {:else}
            <li class="cl-empty-row">{$t('frameleaf_recipient_groups_no_match')}</li>
          {/each}
        </ul>
        <div class="row-actions">
          <Button onclick={() => (editing = undefined)}>{$t('cancel')}</Button>
          <Button type="submit" variant="primary" disabled={busy}>
            {$t('frameleaf_recipient_groups_save', { values: { count: editing.userIds.length } })}
          </Button>
        </div>
      </form>
    {:else}
      <ul class="cl-members">
        {#each groups as group (group.id)}
          <li>
            <span class="cl-member-name">
              {group.name}
              <small>
                {group.users.length > 0
                  ? group.users.map(({ name }) => name).join(', ')
                  : $t('frameleaf_recipient_groups_empty_group')}
              </small>
            </span>
            <Button
              label={$t('frameleaf_recipient_groups_edit_named', { values: { name: group.name } })}
              onclick={() => startEdit(group)}
            >
              <Icon icon={mdiPencilOutline} size="16" aria-hidden={true} />
              {$t('edit')}
            </Button>
            <button
              type="button"
              class="danger"
              disabled={busy}
              aria-label={$t('frameleaf_recipient_groups_delete_named', { values: { name: group.name } })}
              onclick={() => void remove(group)}
            >
              <Icon icon={mdiDeleteOutline} size="16" aria-hidden={true} />
              {$t('delete')}
            </button>
          </li>
        {:else}
          <li class="cl-empty-row">{$t('frameleaf_recipient_groups_none')}</li>
        {/each}
      </ul>
      <div class="row-actions">
        <Button onclick={startNew}>
          <Icon icon={mdiAccountMultiplePlusOutline} size="16" aria-hidden={true} />
          {$t('frameleaf_recipient_groups_new')}
        </Button>
      </div>
    {/if}
  </div>

  {#snippet actions()}
    <Button onclick={() => (open = false)}>{$t('done')}</Button>
  {/snippet}
</Dialog>

<style>
  /* The prototype share dialog's invite controls (collections.css:127-160, 387-470). */
  .groups {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    min-width: min(26rem, 100%);
  }
  .note {
    margin: 0;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
    line-height: 1.5;
  }
  .cl-invite {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .cl-field {
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-width: 0;
  }
  .cl-field > span {
    font-size: var(--fl-font-small);
    font-weight: 600;
    color: var(--fl-muted);
    letter-spacing: 0.01em;
  }
  .cl-field input {
    font: inherit;
    color: var(--fl-text);
    background: var(--fl-raised);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
    min-height: 34px;
    padding: 6px 10px;
    width: 100%;
    box-sizing: border-box;
  }
  .cl-error {
    margin: 0;
    color: var(--fl-danger);
    font-size: var(--fl-font-small);
  }
  .cl-people,
  .cl-members {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .cl-people {
    max-height: 16rem;
    overflow-y: auto;
  }
  .cl-people button {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    min-height: 40px;
    padding: 5px 8px;
    border: 1px solid transparent;
    border-radius: var(--fl-radius-control);
    background: none;
    color: var(--fl-text);
    font: inherit;
    text-align: left;
    cursor: pointer;
  }
  .cl-people button:hover {
    background: var(--fl-raised);
  }
  .cl-people button[aria-selected='true'] {
    border-color: var(--fl-accent);
    background: var(--fl-accent-soft);
  }
  .cl-people small,
  .cl-member-name small {
    display: block;
    color: var(--fl-muted);
    font-size: var(--fl-font-micro);
  }
  .cl-empty-row {
    padding: 8px;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  .cl-members li {
    display: flex;
    align-items: center;
    gap: 10px;
    min-height: 44px;
    padding: 4px 0;
    border-bottom: 1px solid var(--fl-border);
  }
  .cl-members li:last-child {
    border-bottom: 0;
  }
  .cl-member-name {
    flex: 1;
    min-width: 0;
  }
  .row-actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
  }
  .danger {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    padding: 0.4375rem 0.6875rem;
    color: var(--fl-danger);
    background: var(--fl-raised);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
  }
</style>
