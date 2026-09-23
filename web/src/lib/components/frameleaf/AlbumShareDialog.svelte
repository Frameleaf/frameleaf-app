<script lang="ts">
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
  import { mdiAccountPlusOutline, mdiLinkVariant } from '@mdi/js';
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
  let inviteRole = $state<AlbumUserRole>(AlbumUserRole.Editor);
  let linkFormOpen = $state(false);

  const currentUserId = $derived(authManager.user.id);
  const isOwner = $derived(
    album.albumUsers.some(({ user, role }) => user.id === currentUserId && role === AlbumUserRole.Owner),
  );
  const members = $derived(album.albumUsers);
  const memberIds = $derived(new Set(album.albumUsers.map(({ user }) => user.id)));
  const available = $derived(candidates.filter((user) => !memberIds.has(user.id)));

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
    <section aria-label={$t('frameleaf_albums_members')}>
      <h3>{$t('frameleaf_albums_members')}</h3>
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
              <button type="button" class="remove" disabled={busy} onclick={() => void remove(member.user)}>
                {$t('remove')}
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
      <section aria-label={$t('invite_people')}>
        <h3>{$t('invite_people')}</h3>
        {#if loading}
          <Status message={$t('loading')} busy />
        {:else if available.length === 0}
          <Status message={$t('album_share_no_users')} />
        {:else}
          <div class="invite">
            <label class="grow">
              <span class="sr-only">{$t('search_people')}</span>
              <select bind:value={invitee} disabled={busy}>
                <option value="">{$t('search_people')}</option>
                {#each available as user (user.id)}
                  <option value={user.id}>{user.name} · {user.email}</option>
                {/each}
              </select>
            </label>
            <label>
              <span class="sr-only">{$t('role')}</span>
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
        {/if}
      </section>

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

<style>
  .share {
    display: flex;
    flex-direction: column;
    gap: 1.25rem;
    margin-block-start: 1rem;
    width: min(32rem, calc(100vw - 4rem));
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
    flex-wrap: wrap;
    gap: 0.5rem;
    align-items: center;
  }
  .grow {
    flex: 1;
    min-width: 10rem;
  }
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
