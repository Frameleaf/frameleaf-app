<script lang="ts">
  import Status from '$lib/components/frameleaf/Status.svelte';
  import UserAvatar from '$lib/components/shared-components/UserAvatar.svelte';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import {
    alreadyInvolvedIds,
    canManageMembers,
    canRemoveMember,
    sortMembers,
    SPACE_ROLE_OPTIONS,
  } from '$lib/frameleaf/shared-space';
  import { handleError } from '$lib/utils/handle-error';
  import {
    addUsersToAlbum,
    removeSharedSpaceInvitation,
    removeUserFromAlbum,
    searchUsers,
    updateAlbumUser,
    AlbumUserRole,
    type AlbumResponseDto,
    type SharedSpaceMemberResponseDto,
    type UserResponseDto,
  } from '@immich/sdk';
  import { Icon } from '@immich/ui';
  import { mdiAccountPlusOutline, mdiClockOutline, mdiClose } from '@mdi/js';
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
        return $t('frameleaf_spaces_role_owner');
      }
      case AlbumUserRole.Viewer: {
        return $t('frameleaf_spaces_role_viewer');
      }
      default: {
        return $t('frameleaf_spaces_role_editor');
      }
    }
  };

  const openInvite = async () => {
    inviting = true;
    try {
      candidates = await searchUsers();
    } catch (error) {
      handleError(error, $t('frameleaf_spaces_error_members'));
    }
  };

  const run = async (work: () => Promise<void>, message: string) => {
    busy = true;
    try {
      await work();
      status = message;
      await onChanged();
    } catch (error) {
      handleError(error, $t('frameleaf_spaces_error_members'));
    } finally {
      busy = false;
    }
  };

  const invite = (user: UserResponseDto) =>
    run(
      () =>
        addUsersToAlbum({
          id: space.id,
          addUsersDto: { albumUsers: [{ userId: user.id, role: inviteRole }] },
        }).then(() => {}),
      $t('frameleaf_spaces_invite_sent', { values: { name: user.name } }),
    );

  const changeRole = (member: SharedSpaceMemberResponseDto, role: AlbumUserRole) =>
    run(
      () => updateAlbumUser({ id: space.id, userId: member.user.id, updateAlbumUserDto: { role } }).then(() => {}),
      $t('frameleaf_spaces_role_changed', { values: { name: member.user.name, role: roleLabel(role) } }),
    );

  const remove = (member: SharedSpaceMemberResponseDto) => {
    const leaving = member.user.id === currentUserId;
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
        <UserAvatar user={member.user} size="sm" />
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
            onclick={() => remove(member)}
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
    <div class="invite" aria-label={$t('frameleaf_spaces_invite')}>
      <div class="invite-controls">
        <label>
          <span class="visually-hidden">{$t('frameleaf_spaces_invite_search')}</span>
          <input type="search" bind:value={query} placeholder={$t('frameleaf_spaces_invite_search')} />
        </label>
        <label>
          <span class="visually-hidden">{$t('role')}</span>
          <select bind:value={inviteRole}>
            {#each SPACE_ROLE_OPTIONS as role (role)}
              <option value={role}>{roleLabel(role)}</option>
            {/each}
          </select>
        </label>
      </div>
      <ul class="candidates">
        {#each matches as user (user.id)}
          <li>
            <UserAvatar {user} size="sm" />
            <span class="name">
              <strong>{user.name}</strong>
              <small>{user.email}</small>
            </span>
            <button type="button" disabled={busy} onclick={() => invite(user)}>
              {$t('frameleaf_spaces_invite_send')}
            </button>
          </li>
        {:else}
          <li class="empty">{$t('frameleaf_spaces_invite_none')}</li>
        {/each}
      </ul>
    </div>
  {/if}
</section>

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
  .invite {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    padding: 0.75rem;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius);
    background: var(--fl-panel);
  }
  .invite-controls {
    display: flex;
    gap: 0.5rem;
  }
  .invite-controls label:first-child {
    flex: 1;
  }
  .invite-controls input {
    width: 100%;
  }
  .candidates {
    max-height: 14rem;
    overflow-y: auto;
  }
  .candidates .empty {
    color: var(--fl-muted);
    font-size: 0.8125rem;
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
