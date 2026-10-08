<script lang="ts">
  import { goto } from '$app/navigation';
  import AlbumConfirmDialog from '$lib/components/frameleaf/AlbumConfirmDialog.svelte';
  import AlbumCreateDialog from '$lib/components/frameleaf/AlbumCreateDialog.svelte';
  import AlbumShareDialog from '$lib/components/frameleaf/AlbumShareDialog.svelte';
  import AlbumTile from '$lib/components/frameleaf/AlbumTile.svelte';
  import EmptyState from '$lib/components/frameleaf/EmptyState.svelte';
  import { listEnter, listFlip, listLeave } from '$lib/components/frameleaf/people/list-motion';
  import SharedSpaceInvitations from '$lib/components/frameleaf/SharedSpaceInvitations.svelte';
  import { OpenQueryParam } from '$lib/constants';
  import { isOwner, canEdit, type AlbumDetailsDraft } from '$lib/frameleaf/album-directory';
  import { backfillProgress } from '$lib/frameleaf/partner-sharing';
  import { ICON_SIZE } from '$lib/frameleaf/tokens';
  import Menu from '$lib/components/frameleaf/Menu.svelte';
  import MenuItem from '$lib/components/frameleaf/MenuItem.svelte';
  import UserAvatar from '$lib/components/shared-components/UserAvatar.svelte';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { eventManager } from '$lib/managers/event-manager.svelte';
  import { Route } from '$lib/route';
  import {
    handleCreateAlbumEntry,
    handleDeleteAlbum,
    handleDownloadAlbum,
    handleEditAlbumDetails,
    handleLeaveAlbum,
  } from '$lib/services/album.service';
  import { openFileUploadDialog } from '$lib/utils/file-uploader';
  import {
    AlbumKind,
    type AlbumResponseDto,
    type CreateAlbumDto,
    type PartnerResponseDto,
    type SharedSpacePreviewResponseDto,
  } from '@frameleaf/sdk';
  import { Icon, toastManager } from '@frameleaf/ui';
  import {
    mdiAccountMultipleOutline,
    mdiAccountPlusOutline,
    mdiDeleteOutline,
    mdiDotsHorizontal,
    mdiDownloadOutline,
    mdiFolderOpenOutline,
    mdiImageMultipleOutline,
    mdiLogoutVariant,
    mdiPencilOutline,
    mdiPlus,
    mdiUpload,
  } from '@mdi/js';
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';

  /**
   * The Shared spaces workspace (FL-55): every top-level shared space (`kind: "space"`
   * albums, the model FL-52 introduced) plus quick access to the account's partners.
   * A shared space is a plain album underneath — same membership, activity, cover and
   * download rules, same sensitive/Locked semantics for anything it shows — so its tiles
   * and menu reuse the exact primitives and services the Albums page uses for every
   * other album kind. This page owns none of that behaviour; it only narrows the album
   * directory down to `spaces` and surfaces partners, who have no album to sit in.
   *
   * A partner is shown as a summary, not a link (FL-326): what a partner shares arrives as your
   * own copies in your own library, so there is no partner library to open. The card says that and
   * how far the copy has come; managing partners is in Settings.
   */
  interface Props {
    spaces: AlbumResponseDto[];
    partners: PartnerResponseDto[];
    /**
     * Shared spaces this account has been invited to and has not answered. They
     * are not memberships, so they are not in `spaces`: nothing about them is
     * reachable until the invitation is accepted.
     */
    invitations?: SharedSpacePreviewResponseDto[];
    /** Re-fetch after a change; the route owns the loader. */
    onRefresh: () => Promise<void> | void;
  }

  let { spaces, partners, invitations = [], onRefresh }: Props = $props();

  const currentUserId = $derived(authManager.user.id);
  let createOpen = $state(false);
  let leaveDialog = $state<{ open: boolean; space?: AlbumResponseDto }>({ open: false });
  let deleteDialog = $state<{ open: boolean; space?: AlbumResponseDto }>({ open: false });
  let editDialog = $state<{ open: boolean; space?: AlbumResponseDto }>({ open: false });
  let shareDialog = $state<{ open: boolean; space?: AlbumResponseDto }>({ open: false });
  let busy = $state(false);

  /** What a partner card says under the name: how far their library has been copied into yours. */
  const partnerSummary = (partner: PartnerResponseDto) => {
    const progress = backfillProgress(partner.backfill);
    if (progress?.state === 'running') {
      return $t('frameleaf_partner_sharing.progress_running', {
        values: { done: progress.done, total: progress.total },
      });
    }
    if (progress?.state === 'queued') {
      return $t('frameleaf_partner_sharing.progress_queued');
    }
    if (progress?.state === 'done' && progress.total > 0) {
      return $t('frameleaf_spaces_partner_copied', { values: { count: progress.total } });
    }
    return $t('frameleaf_spaces_partner_shares');
  };

  const nameOf = (album: AlbumResponseDto | undefined) => album?.albumName || $t('unnamed_album');

  const refresh = async () => {
    await onRefresh();
  };

  onMount(() =>
    eventManager.on({
      AlbumCreate: () => void refresh(),
      AlbumUpdate: () => void refresh(),
      AlbumDelete: () => void refresh(),
      AlbumUserDelete: () => void refresh(),
      AlbumShare: () => void refresh(),
    }),
  );

  const create = async (dto: CreateAlbumDto) => {
    busy = true;
    try {
      const space = await handleCreateAlbumEntry(dto);
      if (!space) {
        return false;
      }
      // A shared space is the workspace itself: open it straight away so its owner can
      // invite people, the way opening a freshly created album does.
      await goto(Route.viewSharedSpace({ id: space.id }));
      return true;
    } finally {
      busy = false;
    }
  };

  /** Delete confirms in the Frameleaf dialog (`DeleteDialog`), as the Albums page does (AL-43). */
  const confirmDelete = async () => {
    const space = deleteDialog.space;
    if (!space) {
      return;
    }
    const deleted = await handleDeleteAlbum(space, { notify: false });
    if (deleted) {
      toastManager.primary($t('frameleaf_albums_deleted', { values: { name: nameOf(space) } }));
    }
    await refresh();
  };

  /** Leave confirms in the Frameleaf dialog with the leave copy, as the space's own header does. */
  const confirmLeave = async () => {
    const space = leaveDialog.space;
    if (!space) {
      return;
    }
    const left = await handleLeaveAlbum(space);
    if (left) {
      toastManager.primary($t('frameleaf_albums_left', { values: { name: nameOf(space) } }));
    }
    await refresh();
  };

  /** The Frameleaf edit and share dialogs (`CollectionFormDialog`, `ShareDialog`); AL-45. */
  const saveDetails = async (draft: AlbumDetailsDraft) => {
    const space = editDialog.space;
    if (!space) {
      return false;
    }
    const saved = await handleEditAlbumDetails(space, draft);
    if (saved) {
      toastManager.primary($t('frameleaf_albums_saved', { values: { name: nameOf(saved) } }));
    }
    return !!saved;
  };
</script>

{#snippet menu(space: AlbumResponseDto)}
  {@const owner = isOwner(space, currentUserId)}
  {@const editor = canEdit(space, currentUserId)}
  <!-- The Frameleaf Menu the Albums page uses for every album kind (AlbumDirectory.svelte), AL-45. -->
  <Menu label={$t('frameleaf_albums_actions_for', { values: { name: nameOf(space) } })} align="end">
    {#snippet trigger()}<Icon icon={mdiDotsHorizontal} size={ICON_SIZE.lg} aria-hidden={true} />{/snippet}
    <MenuItem onSelect={() => goto(Route.viewSharedSpace({ id: space.id }))}>
      <Icon icon={mdiFolderOpenOutline} size={ICON_SIZE.lg} aria-hidden={true} />{$t('open')}
    </MenuItem>
    <MenuItem onSelect={() => goto(Route.viewAlbum({ id: space.id }))}>
      <Icon icon={mdiImageMultipleOutline} size={ICON_SIZE.lg} aria-hidden={true} />{$t('frameleaf_spaces_open_photos')}
    </MenuItem>
    {#if editor}
      <MenuItem onSelect={() => (editDialog = { open: true, space })}>
        <Icon icon={mdiPencilOutline} size={ICON_SIZE.lg} aria-hidden={true} />{$t('edit')}
      </MenuItem>
      <MenuItem onSelect={() => void openFileUploadDialog({ albumId: space.id })}>
        <Icon icon={mdiUpload} size={ICON_SIZE.lg} aria-hidden={true} />{$t('frameleaf_albums_upload')}
      </MenuItem>
    {/if}
    <div class="menu-separator" role="separator"></div>
    <MenuItem onSelect={() => (shareDialog = { open: true, space })}>
      <Icon icon={owner ? mdiAccountPlusOutline : mdiAccountMultipleOutline} size={ICON_SIZE.lg} aria-hidden={true} />
      {owner ? $t('share') : $t('frameleaf_albums_members')}
    </MenuItem>
    <MenuItem disabled={space.assetCount === 0} onSelect={() => handleDownloadAlbum(space)}>
      <Icon icon={mdiDownloadOutline} size={ICON_SIZE.lg} aria-hidden={true} />{$t('download')}
    </MenuItem>
    <div class="menu-separator" role="separator"></div>
    {#if owner}
      <MenuItem onSelect={() => (deleteDialog = { open: true, space })}>
        <Icon icon={mdiDeleteOutline} size={ICON_SIZE.lg} aria-hidden={true} />{$t('delete')}
      </MenuItem>
    {:else}
      <MenuItem onSelect={() => (leaveDialog = { open: true, space })}>
        <Icon icon={mdiLogoutVariant} size={ICON_SIZE.lg} aria-hidden={true} />{$t('leave')}
      </MenuItem>
    {/if}
  </Menu>
{/snippet}

<section class="spaces" aria-labelledby="frameleaf-spaces-heading">
  <header class="head">
    <div class="heading">
      <h1 id="frameleaf-spaces-heading">{$t('frameleaf_spaces_title')}</h1>
      <p>{$t('frameleaf_spaces_intro')}</p>
    </div>
    <button type="button" class="primary" disabled={busy} onclick={() => (createOpen = true)}>
      <Icon icon={mdiPlus} size={ICON_SIZE.md} aria-hidden={true} />
      {$t('frameleaf_spaces_new')}
    </button>
  </header>

  <SharedSpaceInvitations {invitations} onAnswered={refresh} />

  {#if partners.length > 0}
    <section class="partners" aria-labelledby="frameleaf-spaces-partners-heading">
      <div class="partners-head">
        <h2 id="frameleaf-spaces-partners-heading">
          {$t('partners')}<small>{$t('frameleaf_spaces_partners_hint')}</small>
        </h2>
        <a class="partners-manage" href={Route.userSettings({ isOpen: OpenQueryParam.SHARING })}>
          {$t('frameleaf_spaces_partners_manage')}
        </a>
      </div>
      <ul class="partner-row">
        {#each partners as partner (partner.id)}
          <li class="partner">
            <UserAvatar user={partner} size="lg" />
            <span class="partner-text">
              <strong>{partner.name}</strong>
              <small>{partnerSummary(partner)}</small>
            </span>
          </li>
        {/each}
      </ul>
    </section>
  {/if}

  <section class="grid-section" aria-label={$t('frameleaf_spaces_title')}>
    {#if spaces.length > 0}
      <div class="grid">
        {#each spaces as space (space.id)}
          <div
            class="cell"
            animate:listFlip={{ count: spaces.length }}
            in:listEnter={{ count: spaces.length }}
            out:listLeave={{ count: spaces.length }}
          >
            <AlbumTile album={space} {currentUserId} href={Route.viewSharedSpace({ id: space.id })}>
              {#snippet actions()}{@render menu(space)}{/snippet}
            </AlbumTile>
          </div>
        {/each}
      </div>
    {:else}
      <EmptyState
        icon={mdiAccountMultipleOutline}
        title={$t('frameleaf_spaces_empty_title')}
        message={$t('frameleaf_spaces_empty_text')}
        action={{ label: $t('frameleaf_spaces_new'), onClick: () => (createOpen = true), icon: mdiPlus }}
      />
    {/if}
  </section>
</section>

<AlbumCreateDialog bind:open={createOpen} kind={AlbumKind.Space} collections={[]} onCreate={create} />

{#if editDialog.space}
  <AlbumCreateDialog
    bind:open={editDialog.open}
    kind={AlbumKind.Space}
    album={editDialog.space}
    collections={[]}
    onCreate={create}
    onSave={saveDetails}
  />
{/if}

{#if shareDialog.space}
  {@const space = spaces.find(({ id }) => id === shareDialog.space?.id) ?? shareDialog.space}
  <AlbumShareDialog
    album={space}
    bind:open={shareDialog.open}
    onChanged={refresh}
    onLeave={() => (leaveDialog = { open: true, space })}
  />
{/if}

{#if deleteDialog.space}
  <AlbumConfirmDialog
    title={$t('frameleaf_album_delete_title', { values: { name: nameOf(deleteDialog.space) } })}
    body={$t('frameleaf_album_delete_space_body')}
    keepNote={$t('frameleaf_album_delete_keep', { values: { count: deleteDialog.space.assetCount } })}
    confirmLabel={$t('frameleaf_album_delete', { values: { kind: $t('frameleaf_album_kind_space') } })}
    bind:open={deleteDialog.open}
    onConfirm={confirmDelete}
  />
{/if}

{#if leaveDialog.space}
  <AlbumConfirmDialog
    title={$t('frameleaf_album_leave_title', { values: { name: nameOf(leaveDialog.space) } })}
    body={$t('frameleaf_album_leave_body')}
    confirmLabel={$t('frameleaf_album_leave', { values: { kind: $t('frameleaf_album_kind_space') } })}
    bind:open={leaveDialog.open}
    onConfirm={confirmLeave}
  />
{/if}

<style>
  .spaces {
    display: flex;
    flex-direction: column;
    gap: 1.5rem;
    padding: 1rem;
    color: var(--fl-text);
  }
  .head {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-end;
    justify-content: space-between;
    gap: 0.75rem;
  }
  .heading h1 {
    margin: 0;
    font-size: 1.5rem;
    font-weight: 700;
  }
  .heading p {
    margin: 0.125rem 0 0;
    color: var(--fl-muted);
    font-size: 0.875rem;
    max-width: 40rem;
  }
  .primary {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    padding: 0 1rem;
    min-height: var(--fl-control-height);
    border: 1px solid var(--fl-accent);
    border-radius: var(--fl-radius-control);
    background: var(--fl-accent);
    color: var(--fl-accent-text);
    font-weight: 600;
  }
  .partners-head {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    justify-content: space-between;
    gap: 0.25rem 1rem;
    margin: 0 0 0.75rem;
  }
  .partners h2 {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0.5rem;
    margin: 0;
    font-size: 1rem;
    font-weight: 600;
  }
  .partners-manage {
    color: var(--fl-accent);
    font-size: var(--fl-font-callout);
    font-weight: 600;
    text-decoration: none;
  }
  .partners-manage:hover {
    text-decoration: underline;
    text-underline-offset: 3px;
  }
  .partners h2 small {
    color: var(--fl-muted);
    font-size: 0.75rem;
    font-weight: 400;
  }
  .partner-row {
    display: flex;
    flex-wrap: wrap;
    gap: 0.75rem;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  /* A summary, not a control: no hover, no pointer. */
  .partner {
    display: flex;
    align-items: center;
    gap: 0.625rem;
    min-width: 0;
    padding: 0.5rem 0.875rem 0.5rem 0.5rem;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-card);
    background: var(--fl-panel);
    color: var(--fl-text);
  }
  .partner-text {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .partner-text strong {
    font-size: 0.8125rem;
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .partner-text small {
    color: var(--fl-muted);
    font-size: 0.75rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .menu-separator {
    height: 1px;
    margin: 0.25rem 0.375rem;
    background: var(--fl-border);
  }
  /* The Albums page's denser grid (apple-style.css:970-983). */
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(164px, 1fr));
    gap: 18px 12px;
    align-items: start;
  }
  .cell {
    min-width: 0;
  }
  @media (max-width: 640px) {
    .spaces {
      padding: 0.75rem;
    }
  }
  @media (max-width: 700px) {
    .grid {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
  }
</style>
