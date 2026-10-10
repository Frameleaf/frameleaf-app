<script lang="ts">
  import { rovingFocus } from '$lib/frameleaf/roving-focus';
  import AlbumConfirmDialog from '$lib/components/frameleaf/AlbumConfirmDialog.svelte';
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import InlineError from '$lib/components/frameleaf/InlineError.svelte';
  import SharedLinkCopyButton from '$lib/components/frameleaf/SharedLinkCopyButton.svelte';
  import SharedLinkForm from '$lib/components/frameleaf/SharedLinkForm.svelte';
  import Skeleton from '$lib/components/frameleaf/Skeleton.svelte';
  import OnEvents from '$lib/components/OnEvents.svelte';
  import UserAvatar from '$lib/components/shared-components/UserAvatar.svelte';
  import { confirmFrameleaf } from '$lib/frameleaf/confirm';
  import { isLinkExpired, relativeTime } from '$lib/frameleaf/shared-link-badges';
  import { ICON_SIZE } from '$lib/frameleaf/tokens';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { eventManager } from '$lib/managers/event-manager.svelte';
  import { Route } from '$lib/route';
  import { asUrl } from '$lib/services/shared-link.service';
  import { handleError } from '$lib/utils/handle-error';
  import {
    handleInviteAlbumUsers,
    handleRemoveUserFromAlbum,
    handleUpdateUserAlbumRole,
  } from '$lib/services/album.service';
  import {
    AlbumKind,
    AlbumUserRole,
    getAllSharedLinks,
    removeSharedLink,
    searchUsers,
    SharedLinkType,
    type AlbumResponseDto,
    type SharedLinkResponseDto,
    type UserResponseDto,
  } from '@frameleaf/sdk';
  import { Icon, toastManager } from '@frameleaf/ui';
  import {
    mdiAccountPlusOutline,
    mdiCheck,
    mdiClose,
    mdiDeleteOutline,
    mdiLinkVariant,
    mdiPencilOutline,
  } from '@mdi/js';
  import { tick } from 'svelte';
  import { locale, t } from 'svelte-i18n';

  /**
   * Members, roles and public links for an album, a collection or a shared space (FL-53),
   * ported from `ShareDialog` in `design/frameleaf/template/src/CollectionHeader.jsx`.
   *
   * Every control here calls an existing album or shared-link endpoint. Membership is the
   * real access grant: invitations go through `PUT /albums/{id}/users`, a role change
   * through `PUT /albums/{id}/user/{userId}` and a removal through
   * `DELETE /albums/{id}/user/{userId}`. No local recipient list is ever treated as access.
   * Only the owner may invite, change a role or remove someone; everyone else sees who the
   * members are and can leave.
   *
   * Several people can be invited in one go: tick them in the list, choose the role they all get
   * and press Invite. This album's public links are listed here too, each with copy, edit and
   * delete, next to Create link, so links are managed where the album is shared; the header's
   * Shared links button opens this dialog at that section (`section="links"`).
   */
  interface Props {
    album: AlbumResponseDto;
    open?: boolean;
    /** Re-reads the album so roles and `hasSharedLink` reflect what the server now holds. */
    onChanged: () => Promise<void> | void;
    onLeave: () => void;
    /** The part to bring into view when the dialog opens. */
    section?: 'people' | 'links';
  }

  let { album, open = $bindable(false), onChanged, onLeave, section = 'people' }: Props = $props();

  let candidates = $state<UserResponseDto[]>([]);
  let loading = $state(false);
  let busy = $state(false);
  let invitees = $state<string[]>([]);
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

    invitees = [];
    query = '';
    inviteRole = AlbumUserRole.Editor;
    void loadCandidates();
    void loadLinks();
    if (section === 'links') {
      void tick().then(() => linksSection?.scrollIntoView({ block: 'nearest' }));
    }
  });

  /** Only people who can still be invited count; a member added elsewhere drops out of the choice. */
  const chosen = $derived(available.filter(({ id }) => invitees.includes(id)));
  const toggleInvitee = (id: string) => {
    invitees = invitees.includes(id) ? invitees.filter((other) => other !== id) : [...invitees, id];
  };

  const invite = async () => {
    if (chosen.length === 0) {
      return;
    }
    busy = true;
    try {
      const added = await handleInviteAlbumUsers(
        album,
        chosen.map(({ id }) => ({ userId: id, role: inviteRole })),
      );
      if (added) {
        invitees = [];
        query = '';
        await onChanged();
      }
    } finally {
      busy = false;
    }
  };

  /* ---- this album's public links ---- */
  let links = $state<SharedLinkResponseDto[]>([]);
  let linksState = $state<'idle' | 'loading' | 'ready' | 'failed'>('idle');
  let linksSection = $state<HTMLElement>();
  let editing = $state<{ open: boolean; link?: SharedLinkResponseDto }>({ open: false });

  const loadLinks = async () => {
    if (!isOwner) {
      return;
    }
    linksState = 'loading';
    try {
      links = (await getAllSharedLinks({ albumId: album.id })) ?? [];
      linksState = 'ready';
    } catch {
      linksState = 'failed';
    }
  };

  const ofThisAlbum = (link: SharedLinkResponseDto) => link.album?.id === album.id;
  const onSharedLinkCreate = (link: SharedLinkResponseDto) => {
    if (!ofThisAlbum(link) || links.some(({ id }) => id === link.id)) {
      return;
    }
    links = [link, ...links];
    void onChanged();
  };
  const onSharedLinkUpdate = (link: SharedLinkResponseDto) => {
    links = links.map((entry) => (entry.id === link.id ? link : entry));
  };
  const onSharedLinkDelete = (link: SharedLinkResponseDto) => {
    links = links.filter(({ id }) => id !== link.id);
  };

  const addressOf = (link: SharedLinkResponseDto) => (link.slug ? `/s/${link.slug}` : asUrl(link));
  const detailOf = (link: SharedLinkResponseDto) =>
    isLinkExpired(link)
      ? $t('expired')
      : link.expiresAt
        ? $t('frameleaf_sharing.badge_expires', {
            values: { when: relativeTime(link.expiresAt, Date.now(), $locale ?? undefined) },
          })
        : $t('frameleaf_sharing.created_when', {
            values: { when: relativeTime(link.createdAt, Date.now(), $locale ?? undefined) },
          });

  const deleteLink = async (link: SharedLinkResponseDto) => {
    const confirmed = await confirmFrameleaf({
      title: $t('delete_shared_link'),
      prompt: $t('frameleaf_sharing.delete_link_body', { values: { name: linkTarget.name } }),
      confirmText: $t('delete_link'),
      danger: true,
    });
    if (!confirmed) {
      return;
    }
    try {
      await removeSharedLink({ id: link.id });
      eventManager.emit('SharedLinkDelete', link);
      toastManager.primary($t('deleted_shared_link'));
      await onChanged();
    } catch (error) {
      handleError(error, $t('errors.unable_to_delete_shared_link'));
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
    previewAssetIds: album.albumThumbnailAssetId ? [album.albumThumbnailAssetId] : [],
    count: album.assetCount,
  });
</script>

<OnEvents {onSharedLinkCreate} {onSharedLinkUpdate} {onSharedLinkDelete} />

<Dialog
  title={isOwner ? $t('frameleaf_album_share_title', { values: { kind: kindLabel } }) : $t('frameleaf_albums_members')}
  closeLabel={$t('close')}
  bind:open
>
  <div class="share">
    {#if isOwner}
      <section aria-label={$t('invite_people')}>
        {#if loading}
          <!-- The people list at its final size, so the dialog does not jump when it arrives. -->
          <div class="people-loading" aria-busy="true" aria-label={$t('loading')}>
            {#each [0, 1, 2] as row (row)}
              <span class="person-loading">
                <Skeleton variant="circle" width="1.75rem" height="1.75rem" />
                <Skeleton variant="text" width="60%" />
              </span>
            {/each}
          </div>
        {:else}
          <div class="invite fl-reveal">
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
            <ul
              class="people"
              role="listbox"
              aria-multiselectable="true"
              use:rovingFocus
              aria-label={$t('frameleaf_album_share_people')}
            >
              {#each matches as user (user.id)}
                {@const picked = invitees.includes(user.id)}
                <li>
                  <button type="button" role="option" aria-selected={picked} onclick={() => toggleInvitee(user.id)}>
                    <span class="avatar" aria-hidden="true"><UserAvatar {user} size="sm" /></span>
                    <span class="who">
                      <strong>{user.name}</strong>
                      <small>{user.email}</small>
                    </span>
                    {#if picked}
                      <span class="picked" aria-hidden="true"><Icon icon={mdiCheck} size={ICON_SIZE.lg} /></span>
                    {/if}
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
              <button
                type="button"
                class="primary"
                disabled={busy || chosen.length === 0}
                onclick={() => void invite()}
              >
                <span aria-hidden="true"><Icon icon={mdiAccountPlusOutline} size={ICON_SIZE.lg} /></span>
                {chosen.length > 1
                  ? $t('frameleaf_album_share_invite_count', { values: { count: chosen.length } })
                  : $t('frameleaf_album_share_invite')}
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
                <Icon icon={mdiClose} size={ICON_SIZE.lg} />
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
      <section aria-label={$t('shared_links')} bind:this={linksSection}>
        <h3>{$t('shared_links')}</h3>
        <p class="hint">{$t('frameleaf_album_links_description')}</p>
        {#if linksState === 'loading'}
          <div class="link-loading" aria-busy="true" aria-label={$t('loading')}>
            <Skeleton variant="block" height="var(--fl-control-height)" />
          </div>
        {:else if linksState === 'failed'}
          <InlineError message={$t('frameleaf_sharing.links_load_failed')} onRetry={() => void loadLinks()} compact />
        {:else if links.length > 0}
          <ul class="link-list fl-reveal" aria-label={$t('frameleaf_album_links_list')}>
            {#each links as link (link.id)}
              {@const address = addressOf(link)}
              <li class:expired={isLinkExpired(link)}>
                <span class="link-text">
                  <strong>{address}</strong>
                  <small>{link.description ? `${link.description} · ${detailOf(link)}` : detailOf(link)}</small>
                </span>
                <SharedLinkCopyButton
                  value={asUrl(link)}
                  label={$t('frameleaf_album_links_copy', { values: { address } })}
                />
                <button
                  type="button"
                  class="remove icon"
                  aria-label={$t('frameleaf_album_links_edit', { values: { address } })}
                  title={$t('edit')}
                  onclick={() => (editing = { open: true, link })}
                >
                  <Icon icon={mdiPencilOutline} size={ICON_SIZE.lg} />
                </button>
                <button
                  type="button"
                  class="remove icon"
                  aria-label={$t('frameleaf_album_links_delete', { values: { address } })}
                  title={$t('delete')}
                  onclick={() => void deleteLink(link)}
                >
                  <Icon icon={mdiDeleteOutline} size={ICON_SIZE.lg} />
                </button>
              </li>
            {/each}
          </ul>
        {/if}
        <div class="links">
          <button type="button" onclick={() => (linkFormOpen = true)}>
            <span aria-hidden="true"><Icon icon={mdiLinkVariant} size={ICON_SIZE.lg} /></span>
            {links.length > 0 ? $t('frameleaf_album_links_create_another') : $t('create_link')}
          </button>
          {#if links.length > 0}
            <a class="manage" href={Route.sharedLinks()}>{$t('frameleaf_album_links_all')}</a>
          {/if}
        </div>
      </section>
    {/if}
  </div>
</Dialog>

<SharedLinkForm bind:open={linkFormOpen} target={linkTarget} />
{#if editing.link}
  <SharedLinkForm bind:open={editing.open} link={editing.link} />
{/if}

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
    gap: var(--fl-space-3);
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: var(--fl-space-2);
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
    border-radius: var(--fl-radius-control);
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
    background: var(--fl-accent-soft);
  }
  .picked {
    display: inline-flex;
    margin-inline-start: auto;
    color: var(--fl-accent);
  }
  .people-loading {
    display: flex;
    flex-direction: column;
    gap: var(--fl-space-3);
    padding: var(--fl-space-3);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
  }
  .person-loading {
    display: flex;
    align-items: center;
    gap: var(--fl-space-3);
  }
  .link-loading {
    margin-block-end: var(--fl-space-2);
  }
  .link-list {
    display: flex;
    flex-direction: column;
    gap: var(--fl-space-1);
    margin: 0 0 var(--fl-space-3);
    padding: 0;
    list-style: none;
  }
  .link-list li {
    display: flex;
    align-items: center;
    gap: var(--fl-space-1);
    padding-inline-start: var(--fl-space-3);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
    background: var(--fl-raised);
  }
  .link-text {
    display: flex;
    flex: 1;
    flex-direction: column;
    min-width: 0;
    padding-block: var(--fl-space-2);
  }
  .link-text strong {
    overflow: hidden;
    color: var(--fl-text);
    font-family: var(--fl-family-mono);
    font-size: var(--fl-font-callout);
    font-weight: 500;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .link-text small {
    overflow: hidden;
    color: var(--fl-muted);
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .link-list li.expired .link-text strong {
    color: var(--fl-muted);
    text-decoration: line-through;
  }
  .link-list .remove {
    border-color: transparent;
    background: transparent;
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
    padding: var(--fl-space-2) var(--fl-space-3);
    color: var(--fl-text);
    background: var(--fl-raised);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
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
    border-radius: var(--fl-radius-control);
    font: inherit;
  }
  .primary {
    background: var(--fl-accent);
    border-color: var(--fl-accent);
    color: var(--fl-accent-text);
  }
  .remove {
    color: var(--fl-muted);
  }
  .remove.icon {
    justify-content: center;
    min-width: var(--fl-control-height);
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
