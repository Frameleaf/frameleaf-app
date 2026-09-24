<script lang="ts">
  import AlbumConfirmDialog from '$lib/components/frameleaf/AlbumConfirmDialog.svelte';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import PersonPhoto from '$lib/components/frameleaf/PersonPhoto.svelte';
  import RecipientGroupsDialog from '$lib/components/frameleaf/RecipientGroupsDialog.svelte';
  import Status from '$lib/components/frameleaf/Status.svelte';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import {
    alreadyInvolvedIds,
    canManageMembers,
    canRemoveMember,
    sortMembers,
    SPACE_ROLE_OPTIONS,
  } from '$lib/frameleaf/shared-space';
  import { goto } from '$app/navigation';
  import { Route } from '$lib/route';
  import { handleLeaveAlbum } from '$lib/services/album.service';
  import { handleError } from '$lib/utils/handle-error';
  import {
    addUsersToAlbum,
    getRecipientGroups,
    removeSharedSpaceInvitation,
    removeUserFromAlbum,
    searchUsers,
    updateAlbumUser,
    AlbumUserRole,
    type AlbumResponseDto,
    type RecipientGroupResponseDto,
    type SharedSpaceMemberResponseDto,
    type UserResponseDto,
  } from '@immich/sdk';
  import { Icon } from '@immich/ui';
  import { mdiAccountGroupOutline, mdiAccountPlusOutline, mdiClockOutline, mdiClose } from '@mdi/js';
  import { t } from 'svelte-i18n';

  /**
   * Who is in a shared space, and who has been invited (FL-55).
   *
   * Membership of a space belongs to its owner, so only the owner sees the
   * invite control, the role menus and the remove actions; everybody else sees
   * the roster and their own Leave. That is a convenience, not the rule: the
   * server refuses the same things again, and `PUT /albums/{id}/users`,
   * `PUT /albums/{id}/user/{userId}` and `DELETE /albums/{id}/user/{userId}`
   * are the existing album endpoints doing the enforcing.
   *
   * A row is either a member or an unanswered invitation. Withdrawing an
   * invitation removes an offer, never a membership, so it uses its own
   * endpoint; the two are not the same act and are not shown as the same act.
   *
   * Inviting follows the prototype's share dialog (`ShareDialog`, CollectionHeader.jsx:556-700):
   * "Invite someone", a searchable "People to invite" list, a role and one primary Invite. Above it
   * sit the owner's named recipient shortcuts (FL-55): applying one opens a review sheet listing
   * the people it would invite — anyone already in the space or invited is shown and left out — and
   * nothing is sent until the owner confirms ("Review recipients when using a group",
   * settings-catalog.mjs:873-878). A shortcut never grants anything by itself, and its name stays
   * with its owner: invitations carry no group name.
   */
  interface Props {
    space: AlbumResponseDto;
    members: SharedSpaceMemberResponseDto[];
    /** Re-fetch after a change; the route owns the loader. */
    onChanged: () => Promise<void> | void;
  }

  let { space, members, onChanged }: Props = $props();

  const currentUserId = $derived(authManager.user.id);
  const owner = $derived(canManageMembers(space, currentUserId));
  const roster = $derived(sortMembers(members));

  let busy = $state(false);
  let status = $state('');
  let inviting = $state(false);
  let candidates: UserResponseDto[] = $state([]);
  let query = $state('');
  let inviteRole: AlbumUserRole = $state(AlbumUserRole.Editor);
  let picked = $state<string | undefined>();
  let groups: RecipientGroupResponseDto[] = $state([]);
  let groupsOpen = $state(false);
  let review = $state<{ open: boolean; group?: RecipientGroupResponseDto; userIds: string[] }>({
    open: false,
    userIds: [],
  });

  const involved = $derived(alreadyInvolvedIds(members));
  const needle = $derived(query.trim().toLowerCase());
  const matches = $derived(
    candidates
      .filter((user) => user.id !== currentUserId && !involved.has(user.id))
      .filter((user) => !needle || `${user.name} ${user.email}`.toLowerCase().includes(needle)),
  );

  const roleLabel = (role: AlbumUserRole) => {
    switch (role) {
      case AlbumUserRole.Owner: {
        return $t('frameleaf_album_role_owner');
      }
      case AlbumUserRole.Viewer: {
        return $t('frameleaf_album_role_viewer');
      }
      default: {
        return $t('frameleaf_album_role_editor');
      }
    }
  };

  const others = $derived(candidates.filter((user) => user.id !== currentUserId));

  const loadGroups = async () => {
    try {
      groups = await getRecipientGroups();
    } catch (error) {
      handleError(error, $t('frameleaf_recipient_groups_error'));
    }
  };

  const openInvite = async () => {
    inviting = true;
    try {
      [candidates] = await Promise.all([searchUsers(), loadGroups()]);
    } catch (error) {
      handleError(error, $t('frameleaf_spaces_error_members'));
    }
  };

  /** Applying a shortcut proposes its people for review; everyone already involved is left out. */
  const applyGroup = (group: RecipientGroupResponseDto) => {
    review = {
      open: true,
      group,
      userIds: group.users.filter((user) => !involved.has(user.id) && user.id !== currentUserId).map(({ id }) => id),
    };
  };
  const toggleReviewed = (userId: string) => {
    review.userIds = review.userIds.includes(userId)
      ? review.userIds.filter((id) => id !== userId)
      : [...review.userIds, userId];
  };
  const sendReviewed = async () => {
    const userIds = review.userIds;
    if (userIds.length === 0) {
      return;
    }
    const sent = await run(
      () =>
        addUsersToAlbum({
          id: space.id,
          addUsersDto: { albumUsers: userIds.map((userId) => ({ userId, role: inviteRole })) },
        }).then(() => {}),
      $t('frameleaf_recipient_groups_invites_sent', { values: { count: userIds.length } }),
    );
    // A failed send keeps the sheet open with the same people picked, so it can be retried.
    if (sent) {
      review = { open: false, userIds: [] };
    }
  };

  const run = async (work: () => Promise<void>, message: string) => {
    busy = true;
    try {
      await work();
      status = message;
      await onChanged();
      return true;
    } catch (error) {
      handleError(error, $t('frameleaf_spaces_error_members'));
      return false;
    } finally {
      busy = false;
    }
  };

  const invite = async () => {
    const user = candidates.find(({ id }) => id === picked);
    if (!user) {
      return;
    }
    await run(
      () =>
        addUsersToAlbum({
          id: space.id,
          addUsersDto: { albumUsers: [{ userId: user.id, role: inviteRole }] },
        }).then(() => {}),
      $t('frameleaf_spaces_invite_sent', { values: { name: user.name } }),
    );
    picked = undefined;
    query = '';
  };

  const changeRole = (member: SharedSpaceMemberResponseDto, role: AlbumUserRole) =>
    run(
      () => updateAlbumUser({ id: space.id, userId: member.user.id, updateAlbumUserDto: { role } }).then(() => {}),
      $t('frameleaf_spaces_role_changed', { values: { name: member.user.name, role: roleLabel(role) } }),
    );

  /**
   * Removing a member or leaving asks first in the Frameleaf dialog (AL-43); withdrawing an
   * unanswered invitation removes only an offer, so it happens at once.
   */
  let confirming = $state<{ open: boolean; member?: SharedSpaceMemberResponseDto }>({ open: false });
  const requestRemove = (member: SharedSpaceMemberResponseDto) => {
    if (member.pending) {
      return remove(member);
    }
    confirming = { open: true, member };
  };

  const remove = async (member: SharedSpaceMemberResponseDto) => {
    const leaving = member.user.id === currentUserId;
    if (leaving && !member.pending) {
      // Leaving is the shared leave action (FL-53): it alone navigates, and the page's
      // "you were removed" handling ignores the removal this tab made.
      busy = true;
      try {
        if (await handleLeaveAlbum(space)) {
          await goto(Route.sharing());
        }
      } finally {
        busy = false;
      }
      return;
    }
    return run(
      () =>
        member.pending
          ? removeSharedSpaceInvitation({ id: space.id, userId: member.user.id }).then(() => {})
          : removeUserFromAlbum({ id: space.id, userId: member.user.id }).then(() => {}),
      leaving
        ? $t('frameleaf_spaces_left', { values: { name: space.albumName } })
        : $t('frameleaf_spaces_member_removed', { values: { name: member.user.name } }),
    );
  };
</script>

<section class="members" aria-labelledby="frameleaf-space-members">
  <header>
    <h2 id="frameleaf-space-members">{$t('frameleaf_spaces_members')}</h2>
    <p>{$t('frameleaf_spaces_members_hint')}</p>
    {#if owner}
      <button type="button" class="primary" onclick={openInvite}>
        <Icon icon={mdiAccountPlusOutline} size="16" aria-hidden={true} />
        {$t('frameleaf_spaces_invite')}
      </button>
    {/if}
  </header>

  <Status message={status} {busy} />

  <ul class="roster">
    {#each roster as member (member.user.id)}
      <li class:pending={member.pending}>
        <PersonPhoto user={member.user} />
        <span class="name">
          <strong>{member.user.name}</strong>
          <small>{member.user.email}</small>
        </span>

        {#if member.pending}
          <span class="tag">
            <Icon icon={mdiClockOutline} size="14" aria-hidden={true} />
            {$t('frameleaf_spaces_member_pending')}
          </span>
        {/if}

        {#if owner && member.role !== AlbumUserRole.Owner}
          <label class="role-select">
            <span class="visually-hidden">
              {$t('frameleaf_spaces_role_for', { values: { name: member.user.name } })}
            </span>
            <select
              value={member.role}
              disabled={busy}
              onchange={(event) => changeRole(member, event.currentTarget.value as AlbumUserRole)}
            >
              {#each SPACE_ROLE_OPTIONS as role (role)}
                <option value={role}>{roleLabel(role)}</option>
              {/each}
            </select>
          </label>
        {:else}
          <span class="role">{roleLabel(member.role)}</span>
        {/if}

        {#if canRemoveMember(space, currentUserId, member)}
          <button
            type="button"
            class="remove"
            disabled={busy}
            onclick={() => requestRemove(member)}
            aria-label={member.pending
              ? $t('frameleaf_spaces_withdraw_for', { values: { name: member.user.name } })
              : member.user.id === currentUserId
                ? $t('frameleaf_spaces_leave')
                : $t('frameleaf_spaces_remove_for', { values: { name: member.user.name } })}
          >
            <Icon icon={mdiClose} size="16" aria-hidden={true} />
          </button>
        {/if}
      </li>
    {/each}
  </ul>

  {#if owner && inviting}
    <div class="cl-invite" role="group" aria-label={$t('frameleaf_spaces_invite')}>
      <div class="shortcuts">
        <span class="field-label">{$t('frameleaf_recipient_groups_title')}</span>
        {#if groups.length > 0}
          <div class="shortcut-list">
            {#each groups as group (group.id)}
              <Button
                label={$t('frameleaf_recipient_groups_apply', {
                  values: { name: group.name, count: group.users.length },
                })}
                onclick={() => applyGroup(group)}
              >
                <Icon icon={mdiAccountGroupOutline} size="16" aria-hidden={true} />
                {group.name}
                <small>{group.users.length}</small>
              </Button>
            {/each}
          </div>
        {/if}
        <button type="button" class="link" onclick={() => (groupsOpen = true)}>
          {groups.length > 0 ? $t('frameleaf_recipient_groups_manage') : $t('frameleaf_recipient_groups_new')}
        </button>
      </div>

      <label class="cl-field">
        <span>{$t('frameleaf_spaces_invite_someone')}</span>
        <input data-initial-focus type="search" bind:value={query} placeholder={$t('frameleaf_spaces_invite_search')} />
      </label>
      <ul class="cl-people" role="listbox" aria-label={$t('frameleaf_spaces_people_to_invite')}>
        {#each matches as user (user.id)}
          <li>
            <button
              type="button"
              role="option"
              aria-selected={picked === user.id}
              onclick={() => (picked = picked === user.id ? undefined : user.id)}
            >
              <PersonPhoto {user} />
              <span>
                {user.name}
                <small>{user.email}</small>
              </span>
            </button>
          </li>
        {:else}
          <li class="cl-empty-row">
            {needle ? $t('frameleaf_spaces_invite_no_match') : $t('frameleaf_spaces_invite_none')}
          </li>
        {/each}
      </ul>
      <div class="cl-invite-row">
        <label>
          {$t('role')}
          <select bind:value={inviteRole}>
            {#each SPACE_ROLE_OPTIONS as role (role)}
              <option value={role}>{roleLabel(role)}</option>
            {/each}
          </select>
        </label>
        <Button variant="primary" disabled={busy || !picked} onclick={() => void invite()}>
          <Icon icon={mdiAccountPlusOutline} size="16" aria-hidden={true} />
          {$t('frameleaf_spaces_invite_send')}
        </Button>
      </div>
    </div>
  {/if}
</section>

{#if owner}
  <RecipientGroupsDialog bind:open={groupsOpen} {groups} people={others} onChanged={loadGroups} />
{/if}

{#if review.group}
  {@const group = review.group}
  <!-- The review sheet a shortcut opens: the people it would invite, before anything is sent. -->
  <Dialog
    title={$t('frameleaf_recipient_groups_review_title', { values: { name: group.name } })}
    closeLabel={$t('close')}
    bind:open={review.open}
  >
    <div class="review">
      <p class="note">{$t('frameleaf_recipient_groups_review_note')}</p>
      <ul class="cl-people" role="group" aria-label={$t('frameleaf_spaces_people_to_invite')}>
        {#each group.users as user (user.id)}
          {@const already = involved.has(user.id)}
          <li>
            <label class="review-row" class:already>
              <input
                type="checkbox"
                checked={review.userIds.includes(user.id)}
                disabled={already}
                onchange={() => toggleReviewed(user.id)}
              />
              <PersonPhoto {user} />
              <span>
                {user.name}
                <small>{already ? $t('frameleaf_recipient_groups_already_in') : user.email}</small>
              </span>
            </label>
          </li>
        {/each}
      </ul>
      <div class="cl-invite-row">
        <label>
          {$t('role')}
          <select bind:value={inviteRole}>
            {#each SPACE_ROLE_OPTIONS as role (role)}
              <option value={role}>{roleLabel(role)}</option>
            {/each}
          </select>
        </label>
      </div>
    </div>
    {#snippet actions()}
      <Button onclick={() => (review.open = false)}>{$t('cancel')}</Button>
      <Button variant="primary" disabled={busy || review.userIds.length === 0} onclick={() => void sendReviewed()}>
        {$t('frameleaf_recipient_groups_send', { values: { count: review.userIds.length } })}
      </Button>
    {/snippet}
  </Dialog>
{/if}

{#if confirming.member}
  {@const member = confirming.member}
  {@const self = member.user.id === currentUserId}
  <AlbumConfirmDialog
    title={self
      ? $t('frameleaf_album_leave_title', { values: { name: space.albumName } })
      : $t('frameleaf_album_remove_member_title', { values: { name: member.user.name } })}
    body={self
      ? $t('frameleaf_album_leave_body')
      : $t('frameleaf_album_remove_member_body', { values: { name: space.albumName } })}
    confirmLabel={self
      ? $t('frameleaf_album_leave', { values: { kind: $t('frameleaf_album_kind_space') } })
      : $t('frameleaf_album_remove_member_confirm')}
    bind:open={confirming.open}
    onConfirm={async () => {
      await remove(member);
    }}
  />
{/if}

<style>
  .members {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }
  header {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0.5rem;
  }
  h2 {
    margin: 0;
    font-size: 1rem;
    font-weight: 600;
  }
  header p {
    flex: 1;
    margin: 0;
    color: var(--fl-muted);
    font-size: 0.75rem;
  }
  ul {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  li {
    display: flex;
    align-items: center;
    gap: 0.625rem;
    padding: 0.375rem 0.5rem;
    border: 1px solid transparent;
    border-radius: var(--fl-radius);
  }
  li.pending {
    border-color: var(--fl-border);
    border-style: dashed;
  }
  .name {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-width: 0;
  }
  .name strong {
    font-size: 0.8125rem;
    font-weight: 600;
  }
  .name small {
    color: var(--fl-muted);
    font-size: 0.75rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .tag {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    color: var(--fl-muted);
    font-size: 0.6875rem;
  }
  .role {
    color: var(--fl-muted);
    font-size: 0.75rem;
  }
  select,
  input {
    min-height: 32px;
    padding: 0 0.5rem;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius);
    background: var(--fl-panel);
    color: var(--fl-text);
    font-size: 0.8125rem;
  }
  button {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    padding: 0 0.75rem;
    min-height: 32px;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius);
    background: var(--fl-raised);
    color: var(--fl-text);
    font-size: 0.8125rem;
    font-weight: 600;
  }
  button.primary {
    border-color: var(--fl-accent);
    background: var(--fl-accent);
    color: var(--fl-accent-text);
  }
  button.remove {
    padding: 0 0.375rem;
    background: transparent;
    border-color: transparent;
    color: var(--fl-muted);
  }
  button:disabled {
    opacity: 0.6;
  }
  /* The prototype share dialog's invite controls (collections.css:127-160, 387-445). */
  .cl-invite {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 0.75rem;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-card);
    background: var(--fl-panel);
  }
  .cl-field {
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-width: 0;
  }
  .cl-field > span,
  .field-label {
    font-size: var(--fl-font-small);
    font-weight: 600;
    color: var(--fl-muted);
    letter-spacing: 0.01em;
  }
  .cl-field input,
  .cl-invite-row select {
    width: 100%;
    box-sizing: border-box;
  }
  .cl-people {
    max-height: 14rem;
    overflow-y: auto;
  }
  .cl-people li {
    padding: 0;
  }
  .cl-people button,
  .review-row {
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
    font-weight: 400;
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
  .cl-people small {
    display: block;
    color: var(--fl-muted);
    font-size: var(--fl-font-micro);
  }
  .cl-empty-row {
    padding: 8px;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  .cl-invite-row {
    display: flex;
    align-items: end;
    gap: 10px;
  }
  .cl-invite-row label {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 6px;
    font-size: var(--fl-font-small);
    color: var(--fl-muted);
  }
  /* Named recipient shortcuts: the prototype's compact buttons in a wrapping row, like its chips. */
  .shortcuts {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem;
  }
  .shortcut-list {
    display: flex;
    flex-wrap: wrap;
    gap: 0.375rem;
  }
  .shortcut-list small {
    color: var(--fl-muted);
    font-size: var(--fl-font-micro);
    font-variant-numeric: tabular-nums;
  }
  button.link {
    min-height: 0;
    padding: 0;
    border: 0;
    background: none;
    color: var(--fl-accent);
    font-size: var(--fl-font-small);
  }
  .review {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    min-width: min(24rem, 100%);
  }
  .review .note {
    margin: 0;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
    line-height: 1.5;
  }
  .review-row.already {
    color: var(--fl-muted);
    cursor: default;
  }
  .visually-hidden {
    position: absolute;
    width: 1px;
    height: 1px;
    margin: -1px;
    padding: 0;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
    border: 0;
  }
</style>
