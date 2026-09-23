<script lang="ts">
  import { goto } from '$app/navigation';
  import AlbumIcon from '$lib/components/frameleaf/AlbumIcon.svelte';
  import SharedSpaceAddMatching from '$lib/components/frameleaf/SharedSpaceAddMatching.svelte';
  import SharedSpaceMembers from '$lib/components/frameleaf/SharedSpaceMembers.svelte';
  import Status from '$lib/components/frameleaf/Status.svelte';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { canContribute, isSpaceOwner, spaceOwner } from '$lib/frameleaf/shared-space';
  import AlbumEditModal from '$lib/modals/AlbumEditModal.svelte';
  import { Route } from '$lib/route';
  import { handleDeleteAlbum, handleDownloadAlbum, handleRemoveUserFromAlbum } from '$lib/services/album.service';
  import { handleError } from '$lib/utils/handle-error';
  import type { AlbumResponseDto, SharedSpaceMemberResponseDto } from '@immich/sdk';
  import { Icon, modalManager } from '@immich/ui';
  import {
    mdiArrowLeft,
    mdiDeleteOutline,
    mdiDownloadOutline,
    mdiImageMultipleOutline,
    mdiLogoutVariant,
    mdiPencilOutline,
  } from '@mdi/js';
  import { t } from 'svelte-i18n';

  /**
   * One shared space (FL-55).
   *
   * The space's photos stay where they already are — a space is an album, so
   * the album view owns the timeline, the viewer, activity, the cover and the
   * download — and this page owns what a space adds on top: who is in it, what
   * role each person holds, the invitations nobody has answered, and adding
   * everything matching a source into it. Leaving and deleting are here too,
   * and they mean what they say: leaving takes you out and keeps the space,
   * deleting removes the space and keeps every original file in its owner's
   * library.
   */
  interface Props {
    space: AlbumResponseDto;
    members: SharedSpaceMemberResponseDto[];
    /** Albums the signed-in person can read, offered as bulk-add sources. */
    albums?: AlbumResponseDto[];
    /** Re-fetch after a change; the route owns the loader. */
    onRefresh: () => Promise<void> | void;
  }

  let { space, members, albums = [], onRefresh }: Props = $props();

  const currentUserId = $derived(authManager.user.id);
  const owner = $derived(isSpaceOwner(space, currentUserId));
  const contributor = $derived(canContribute(space, currentUserId));
  const ownerUser = $derived(spaceOwner(space));

  let busy = $state(false);
  let status = $state('');

  const edit = async () => {
    await modalManager.show(AlbumEditModal, { album: space });
    await onRefresh();
  };

  const leave = async () => {
    busy = true;
    try {
      await handleRemoveUserFromAlbum(space, authManager.user);
      await goto(Route.sharing());
    } catch (error) {
      handleError(error, $t('frameleaf_spaces_error_members'));
    } finally {
      busy = false;
    }
  };

  const remove = async () => {
    busy = true;
    try {
      const deleted = await handleDeleteAlbum(space);
      if (deleted) {
        await goto(Route.sharing());
      }
    } catch (error) {
      handleError(error, $t('frameleaf_spaces_error_members'));
    } finally {
      busy = false;
    }
  };
</script>

<section class="space" aria-labelledby="frameleaf-space-heading">
  <a class="back" href={Route.sharing()}>
    <Icon icon={mdiArrowLeft} size="16" aria-hidden={true} />
    {$t('frameleaf_spaces_all')}
  </a>

  <header class="head">
    <AlbumIcon name={space.icon} size="36" />
    <div class="heading">
      <h1 id="frameleaf-space-heading">{space.albumName}</h1>
      <p>
        {#if ownerUser}
          {$t('frameleaf_spaces_owned_by', { values: { name: ownerUser.name } })} ·
        {/if}
        {$t('frameleaf_albums_items', { values: { count: space.assetCount } })}
      </p>
      {#if space.description}
        <p class="description">{space.description}</p>
      {/if}
    </div>

    <div class="actions">
      <a class="button primary" href={Route.viewAlbum({ id: space.id })}>
        <Icon icon={mdiImageMultipleOutline} size="16" aria-hidden={true} />
        {$t('frameleaf_spaces_open_photos')}
      </a>
      {#if contributor}
        <button type="button" onclick={edit}>
          <Icon icon={mdiPencilOutline} size="16" aria-hidden={true} />
          {$t('edit')}
        </button>
      {/if}
      {#if space.assetCount > 0}
        <button type="button" onclick={() => handleDownloadAlbum(space)}>
          <Icon icon={mdiDownloadOutline} size="16" aria-hidden={true} />
          {$t('download')}
        </button>
      {/if}
      {#if owner}
        <button type="button" class="danger" disabled={busy} onclick={remove}>
          <Icon icon={mdiDeleteOutline} size="16" aria-hidden={true} />
          {$t('frameleaf_spaces_delete')}
        </button>
      {:else}
        <button type="button" class="danger" disabled={busy} onclick={leave}>
          <Icon icon={mdiLogoutVariant} size="16" aria-hidden={true} />
          {$t('frameleaf_spaces_leave')}
        </button>
      {/if}
    </div>
  </header>

  <Status message={status} {busy} />

  <SharedSpaceMembers {space} {members} onChanged={onRefresh} />

  {#if contributor}
    <SharedSpaceAddMatching {space} {albums} />
  {/if}
</section>

<style>
  .space {
    display: flex;
    flex-direction: column;
    gap: 1.5rem;
    padding: 1rem;
    color: var(--fl-text);
  }
  .back {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    color: var(--fl-muted);
    font-size: 0.8125rem;
    text-decoration: none;
    width: fit-content;
  }
  .head {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-start;
    gap: 0.75rem;
  }
  .heading {
    flex: 1;
    min-width: 12rem;
  }
  h1 {
    margin: 0;
    font-size: 1.5rem;
    font-weight: 700;
  }
  .heading p {
    margin: 0.125rem 0 0;
    color: var(--fl-muted);
    font-size: 0.875rem;
  }
  .heading .description {
    max-width: 40rem;
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
  }
  button,
  .button {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    padding: 0 0.875rem;
    min-height: 36px;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius);
    background: var(--fl-raised);
    color: var(--fl-text);
    font-size: 0.8125rem;
    font-weight: 600;
    text-decoration: none;
  }
  .button.primary,
  button.primary {
    border-color: var(--fl-accent);
    background: var(--fl-accent);
    color: var(--fl-accent-text);
  }
  button.danger {
    color: var(--fl-danger, #c0392b);
  }
  button:disabled {
    opacity: 0.6;
  }
  @media (max-width: 640px) {
    .space {
      padding: 0.75rem;
    }
  }
</style>
