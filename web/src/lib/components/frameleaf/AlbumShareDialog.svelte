<script lang="ts">
  import AlbumConfirmDialog from '$lib/components/frameleaf/AlbumConfirmDialog.svelte';
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import SharedLinkForm from '$lib/components/frameleaf/SharedLinkForm.svelte';
  import Status from '$lib/components/frameleaf/Status.svelte';
  import UserAvatar from '$lib/components/shared-components/UserAvatar.svelte';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { Route } from '$lib/route';
  import {
    handleInviteAlbumUsers,
    handleRemoveUserFromAlbum,
    handleUpdateUserAlbumRole,
  } from '$lib/services/album.service';
  import {
    AlbumKind,
    AlbumUserRole,
    searchUsers,
    SharedLinkType,
    type AlbumResponseDto,
    type UserResponseDto,
  } from '@immich/sdk';
  import { Icon } from '@immich/ui';
  import { mdiAccountPlusOutline, mdiClose, mdiLinkVariant } from '@mdi/js';
  import { t } from 'svelte-i18n';

  /**
   * Members, roles and public links for an album, a collection or a shared space (FL-53),
   * ported from `ShareDialog` in `design/frameleaf/template/src/CollectionHeader.jsx`.
   *
   * Every control here calls an existing album or shared-link endpoint. Membership is the
   * real access grant: invitations go through `PUT /albums/{id}/users`, a role change
   * through `PUT /albums/{id}/user/{userId}` and a removal through
   * `DELETE /albums/{id}/user/{userId}`. No local recipient list is ever treated as access.
   * Only the owner may invite, change a role or remove someone; everyone else sees who the
   * members are and can leave. Public links are created with the existing shared-link form
   * and managed on the shared links destination.
   */
  interface Props {
    album: AlbumResponseDto;
    open?: boolean;
    /** Re-reads the album so roles and `hasSharedLink` reflect what the server now holds. */
    onChanged: () => Promise<void> | void;
    onLeave: () => void;
  }

  let { album, open = $bindable(false), onChanged, onLeave }: Props = $props();

  let candidates = $state<UserResponseDto[]>([]);
  let loading = $state(false);
  let busy = $state(false);
  let invitee = $state('');
  let query = $state('');
  let inviteRole = $state<AlbumUserRole>(AlbumUserRole.Editor);
  let linkFormOpen = $state(false);

  const currentUserId = $derived(authManager.user.id);
  const isOwner = $derived(
    album.albumUsers.some(({ user, role }) => user.id === currentUserId && role === AlbumUserRole.Owner),
  );
  const members = $derived(album.albumUsers);
  const memberIds = $derived(new Set(album.albumUsers.map(({ user }) => user.id)));
  const available = $derived(candidates.filter((user) => !memberIds.has(user.id)));
  const needle = $derived(query.trim().toLowerCase());
  /** The design's invite search (`ShareDialog`): by name or email, never offering a member. */
  const matches = $derived(
    available.filter((user) => !needle || `${user.name} ${user.email}`.toLowerCase().includes(needle)),
  );

  const kindLabel = $derived(
    album.kind === AlbumKind.Collection
      ? $t('frameleaf_album_kind_collection')
      : album.kind === AlbumKind.Space
        ? $t('frameleaf_album_kind_space')
        : $t('frameleaf_album_kind_album'),
  );

  const roleLabel = (role: AlbumUserRole) =>
    role === AlbumUserRole.Owner
      ? $t('frameleaf_album_role_owner')
      : role === AlbumUserRole.Editor
        ? $t('frameleaf_album_role_editor')
        : $t('frameleaf_album_role_viewer');

  const loadCandidates = async () => {
    if (!isOwner) {
      return;
    }
    loading = true;
    try {
      candidates = (await searchUsers()).filter((user) => user.id !== currentUserId);
    } catch {
      candidates = [];
    } finally {
      loading = false;
    }
  };

  $effect(() => {
    if (!open) {
      return;
    }

    invitee = '';
    query = '';
    inviteRole = AlbumUserRole.Editor;
    void loadCandidates();
  });

  const invite = async () => {
    const user = available.find(({ id }) => id === invitee);
    if (!user) {
      return;
    }
    busy = true;
    try {
      const added = await handleInviteAlbumUsers(album, [{ userId: user.id, role: inviteRole }]);
      if (added) {
        invitee = '';
        query = '';
        await onChanged();
      }
    } finally {
      busy = false;
    }
  };

  const changeRole = async (userId: string, role: AlbumUserRole) => {
    busy = true;
    try {
      await handleUpdateUserAlbumRole({ albumId: album.id, userId, role });
      await onChanged();
    } finally {
      busy = false;
    }
  };

  /**
   * Removing a member asks first, as the space's Members panel does. The design removes at once,
   * but re-adding cannot undo it: a shared space member comes back only by accepting a new
   * invitation, so an Undo would not restore what was there.
   */
  let removing = $state<{ open: boolean; user?: UserResponseDto }>({ open: false });

  const remove = async (user: UserResponseDto) => {
    busy = true;
    try {
      await handleRemoveUserFromAlbum(album, user);
      await onChanged();
    } finally {
      busy = false;
    }
  };

  const linkTarget = $derived({
    type: SharedLinkType.Album,
    albumId: album.id,
    name: album.albumName || $t('unnamed_album'),
  });
</script>

<Dialog
  title={isOwner ? $t('frameleaf_album_share_title', { values: { kind: kindLabel } }) : $t('frameleaf_albums_members')}
  closeLabel={$t('close')}
  bind:open
>
  <div class="share">
    {#if isOwner}
      <section aria-label={$t('invite_people')}>
        {#if loading}
          <Status message={$t('loading')} busy />
        {:else}
          <div class="invite">
            <label class="field">
              <span>{$t('frameleaf_album_share_invite_label')}</span>
              <input
                type="search"
                bind:value={query}
                data-initial-focus
                placeholder={$t('frameleaf_album_share_invite_search')}
                disabled={busy}
              />
            </label>
            <ul class="people" role="listbox" aria-label={$t('frameleaf_album_share_people')}>
              {#each matches as user (user.id)}
                <li>
                  <button
                    type="button"
                    role="option"
                    aria-selected={invitee === user.id}
                    onclick={() => (invitee = invitee === user.id ? '' : user.id)}
                  >
                    <span class="avatar" aria-hidden="true"><UserAvatar {user} size="sm" /></span>
                    <span class="who">
                      <strong>{user.name}</strong>
                      <small>{user.email}</small>
                    </span>
                  </button>
                </li>
              {:else}
                <li class="empty-row">
                  {needle ? $t('frameleaf_album_share_no_match') : $t('frameleaf_album_share_everyone')}
                </li>
              {/each}
            </ul>
            <div class="invite-row">
              <label>
                {$t('role')}
                <select bind:value={inviteRole} disabled={busy}>
                  <option value={AlbumUserRole.Editor}>{$t('frameleaf_album_role_editor')}</option>
                  <option value={AlbumUserRole.Viewer}>{$t('frameleaf_album_role_viewer')}</option>
                </select>
              </label>
              <button type="button" class="primary" disabled={busy || !invitee} onclick={() => void invite()}>
                <span aria-hidden="true"><Icon icon={mdiAccountPlusOutline} size="18" /></span>
                {$t('frameleaf_album_share_invite')}
              </button>
            </div>
          </div>
        {/if}
      </section>
    {/if}

    <section aria-label={$t('frameleaf_album_share_access')}>
      <h3>{$t('frameleaf_album_share_access')}</h3>
      <ul class="members">
        {#each members as member (member.user.id)}
          {@const self = member.user.id === currentUserId}
          <li>
            <span class="avatar" aria-hidden="true"><UserAvatar user={member.user} size="md" /></span>
            <span class="who">
              <strong>{self ? $t('frameleaf_album_you') : member.user.name}</strong>
              <small>{member.user.email}</small>
            </span>
            {#if member.role === AlbumUserRole.Owner || !isOwner}
              <span class="role-static">{roleLabel(member.role)}</span>
            {:else}
              <label class="role">
                <span class="sr-only">{$t('role')}</span>
                <select
                  value={member.role}
                  disabled={busy}
                  onchange={(event) => void changeRole(member.user.id, event.currentTarget.value as AlbumUserRole)}
                >
                  <option value={AlbumUserRole.Editor}>{$t('frameleaf_album_role_editor')}</option>
                  <option value={AlbumUserRole.Viewer}>{$t('frameleaf_album_role_viewer')}</option>
                </select>
              </label>
              <button
                type="button"
                class="remove icon"
                disabled={busy}
                aria-label={$t('frameleaf_album_share_remove', { values: { name: member.user.name } })}
                title={$t('frameleaf_album_share_remove', { values: { name: member.user.name } })}
                onclick={() => (removing = { open: true, user: member.user })}
              >
                <Icon icon={mdiClose} size="18" />
              </button>
            {/if}
            {#if self && member.role !== AlbumUserRole.Owner}
              <button
                type="button"
                class="remove"
                onclick={() => {
                  open = false;
                  onLeave();
                }}
              >
                {$t('leave')}
              </button>
            {/if}
          </li>
        {/each}
      </ul>
    </section>

    {#if isOwner}
      <section aria-label={$t('shared_links')}>
        <h3>{$t('shared_links')}</h3>
        <p class="hint">{$t('frameleaf_album_links_description')}</p>
        <div class="links">
          <button
            type="button"
            onclick={() => {
              open = false;
              linkFormOpen = true;
            }}
          >
            <span aria-hidden="true"><Icon icon={mdiLinkVariant} size="18" /></span>
            {$t('create_link')}
          </button>
          {#if album.hasSharedLink}
            <a class="manage" href={Route.sharedLinks()}>{$t('shared_link_manage_links')}</a>
          {/if}
        </div>
      </section>
    {/if}
  </div>
</Dialog>

<SharedLinkForm bind:open={linkFormOpen} target={linkTarget} />

{#if removing.user}
  {@const user = removing.user}
  <AlbumConfirmDialog
    title={$t('frameleaf_album_remove_member_title', { values: { name: user.name } })}
    body={$t('frameleaf_album_remove_member_body', { values: { name: album.albumName || $t('unnamed_album') } })}
    confirmLabel={$t('frameleaf_album_remove_member_confirm')}
    bind:open={removing.open}
    onConfirm={() => remove(user)}
  />
{/if}

<style>
  .share {
    display: flex;
    flex-direction: column;
    gap: 1.25rem;
    margin-block-start: 1rem;
    width: min(32rem, 100%);
  }
  h3 {
    margin: 0 0 0.5rem;
    font-size: 0.75rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--fl-muted);
  }
  .members {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    max-height: 16rem;
    overflow-y: auto;
  }
  .members li {
    display: flex;
    align-items: center;
    gap: 0.625rem;
  }
  .avatar {
    display: inline-flex;
    flex-shrink: 0;
  }
  .who {
    display: flex;
    flex-direction: column;
    min-width: 0;
    flex: 1;
  }
  .who strong {
    font-size: 0.875rem;
    color: var(--fl-text);
  }
  .who small {
    color: var(--fl-muted);
    overflow-wrap: anywhere;
  }
  .role-static {
    color: var(--fl-muted);
    font-size: 0.875rem;
  }
  .invite {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    font-size: 0.75rem;
    font-weight: 600;
    color: var(--fl-muted);
  }
  .people {
    list-style: none;
    margin: 0;
    padding: 0.25rem;
    max-height: 12rem;
    overflow-y: auto;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius);
  }
  .people button {
    width: 100%;
    min-height: 44px;
    border: 0;
    background: transparent;
    text-align: start;
    gap: 0.625rem;
  }
  .people button[aria-selected='true'] {
    background: var(--fl-selected, var(--fl-raised));
    outline: 2px solid var(--fl-accent);
    outline-offset: -2px;
  }
  .empty-row {
    padding: 0.5rem;
    color: var(--fl-muted);
    font-size: 0.875rem;
  }
  .invite-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
  }
  .invite-row label {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.875rem;
  }
  .invite-row select {
    width: auto;
  }
  input,
  select {
    width: 100%;
    padding: 0.5rem 0.5rem;
    color: var(--fl-text);
    background: var(--fl-raised);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius);
    font: inherit;
  }
  .hint {
    margin: 0 0 0.5rem;
    color: var(--fl-muted);
    font-size: 0.875rem;
  }
  .links {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  button,
  .manage {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    padding: 0 0.75rem;
    min-height: 44px;
    color: var(--fl-text);
    background: var(--fl-raised);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius);
    font: inherit;
  }
  .primary {
    background: var(--fl-accent);
    border-color: var(--fl-accent);
    color: var(--fl-accent-text);
  }
  .remove {
    min-height: 36px;
    color: var(--fl-muted);
  }
  .remove.icon {
    justify-content: center;
    min-width: 36px;
    padding: 0;
  }
  button:disabled {
    opacity: 0.6;
  }
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
</style>
