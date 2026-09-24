import {
  addAssetsToAlbum as addToAlbum,
  addAssetsToAlbums as addToAlbums,
  addUsersToAlbum,
  AlbumUserRole,
  BulkIdErrorReason,
  createAlbum,
  deleteAlbum,
  getAlbumDescendantCount,
  moveAlbumToCollection,
  removeUserFromAlbum,
  updateAlbumInfo,
  updateAlbumUser,
  type AlbumResponseDto,
  type AlbumsAddAssetsResponseDto,
  type AlbumUserCreateDto,
  type AssetResponseDto,
  type BulkIdResponseDto,
  type CreateAlbumDto,
  type UpdateAlbumDto,
  type UserResponseDto,
} from '@immich/sdk';
import { modalManager, toastManager, type ActionItem } from '@immich/ui';
import { mdiImageOutline, mdiLink, mdiPlus, mdiPlusBoxOutline, mdiShareVariantOutline, mdiUpload } from '@mdi/js';
import { type MessageFormatter } from 'svelte-i18n';
import { goto } from '$app/navigation';
import { authManager } from '$lib/managers/auth-manager.svelte';
import { eventManager } from '$lib/managers/event-manager.svelte';
import AlbumAddUsersModal from '$lib/modals/AlbumAddUsersModal.svelte';
import AlbumOptionsModal from '$lib/modals/AlbumOptionsModal.svelte';
import SharedLinkCreateModal from '$lib/modals/SharedLinkCreateModal.svelte';
import { Route } from '$lib/route';
import { createAlbumAndRedirect } from '$lib/utils/album-utils';
import { downloadArchive } from '$lib/utils/asset-utils';
import { openFileUploadDialog } from '$lib/utils/file-uploader';
import { handleError } from '$lib/utils/handle-error';
import { getFormatter } from '$lib/utils/i18n';

export const getAlbumsActions = ($t: MessageFormatter) => {
  const Create: ActionItem = {
    title: $t('create_album'),
    icon: mdiPlusBoxOutline,
    onAction: () => createAlbumAndRedirect(),
  };

  return { Create };
};

export const getAlbumActions = ($t: MessageFormatter, album: AlbumResponseDto) => {
  const isOwned = album.albumUsers[0].user.id === authManager.user.id;

  const Share: ActionItem = {
    title: $t('share'),
    icon: mdiShareVariantOutline,
    $if: () => isOwned,
    onAction: () => modalManager.show(AlbumOptionsModal, { album }),
  };

  const AddUsers: ActionItem = {
    title: $t('invite_people'),
    icon: mdiPlus,
    color: 'primary',
    onAction: () => modalManager.show(AlbumAddUsersModal, { album }),
  };

  const CreateSharedLink: ActionItem = {
    title: $t('create_link'),
    icon: mdiLink,
    color: 'primary',
    onAction: () => modalManager.show(SharedLinkCreateModal, { albumId: album.id }),
  };

  return { Share, AddUsers, CreateSharedLink };
};

export const getAlbumAssetActions = ($t: MessageFormatter, album: AlbumResponseDto, asset: AssetResponseDto) => {
  const SetCover: ActionItem = {
    title: $t('set_as_album_cover'),
    icon: mdiImageOutline,
    onAction: () => handleUpdateThumbnail(album, asset.id),
  };

  return { SetCover };
};

export const getAlbumAssetsActions = ($t: MessageFormatter, album: AlbumResponseDto) => {
  const Upload: ActionItem = {
    title: $t('select_from_computer'),
    description: $t('album_upload_assets'),
    icon: mdiUpload,
    onAction: () => void openFileUploadDialog({ albumId: album.id }),
  };

  return { Upload };
};

export const addAssetsToAlbums = async (albumIds: string[], assetIds: string[], { notify }: { notify: boolean }) => {
  const $t = await getFormatter();

  try {
    if (albumIds.length === 1) {
      const albumId = albumIds[0];
      const results = await addToAlbum({ ...authManager.params, id: albumId, bulkIdsDto: { ids: assetIds } });
      if (notify) {
        notifyAddToAlbum($t, albumId, assetIds, results);
      }
    }

    if (albumIds.length > 1) {
      const results = await addToAlbums({ ...authManager.params, albumsAddAssetsDto: { albumIds, assetIds } });
      if (notify) {
        notifyAddToAlbums($t, albumIds, assetIds, results);
      }
    }

    eventManager.emit('AlbumAddAssets', { assetIds, albumIds });
    return true;
  } catch (error) {
    handleError(error, $t('errors.error_adding_assets_to_album'));
    return false;
  }
};

const notifyAddToAlbum = ($t: MessageFormatter, albumId: string, assetIds: string[], results: BulkIdResponseDto[]) => {
  const successCount = results.filter(({ success }) => success).length;
  const duplicateCount = results.filter(({ error }) => error === 'duplicate').length;
  let description: string | undefined;

  if (duplicateCount === assetIds.length) {
    description = $t('assets_were_part_of_album_count', { values: { count: duplicateCount } });
  } else if (successCount === assetIds.length) {
    description = $t('assets_added_to_album_count', { values: { count: successCount } });
  } else if (successCount > 0) {
    description = $t('assets_added_to_album_partial_count', { values: { successCount, totalCount: assetIds.length } });
  }

  const button = { label: $t('view_album'), onclick: () => goto(Route.viewAlbum({ id: albumId })) };
  if (description) {
    toastManager.primary({ description, button }, { timeout: 5000 });
    return;
  }

  toastManager.danger(
    { description: $t('assets_cannot_be_added_to_album_count', { values: { count: assetIds.length } }), button },
    { timeout: 5000 },
  );
};

const notifyAddToAlbums = (
  $t: MessageFormatter,
  albumIds: string[],
  assetIds: string[],
  results: AlbumsAddAssetsResponseDto,
) => {
  if (results.error === BulkIdErrorReason.Duplicate) {
    toastManager.info($t('assets_were_part_of_albums_count', { values: { count: assetIds.length } }));
  } else if (results.error) {
    toastManager.warning($t('assets_cannot_be_added_to_albums', { values: { count: assetIds.length } }));
  } else {
    toastManager.primary(
      $t('assets_added_to_albums_count', {
        values: { albumTotal: albumIds.length, assetTotal: assetIds.length },
      }),
    );
  }
};

export const handleUpdateUserAlbumRole = async ({
  albumId,
  userId,
  role,
}: {
  albumId: string;
  userId: string;
  role: AlbumUserRole;
}) => {
  const $t = await getFormatter();

  try {
    await updateAlbumUser({ id: albumId, userId, updateAlbumUserDto: { role } });
    eventManager.emit('AlbumUserUpdate', { albumId, userId, role });
  } catch (error) {
    handleError(error, $t('errors.unable_to_change_album_user_role'));
  }
};

export const handleAddUsersToAlbum = async (album: AlbumResponseDto, users: UserResponseDto[]) => {
  const $t = await getFormatter();

  try {
    await addUsersToAlbum({ id: album.id, addUsersDto: { albumUsers: users.map(({ id }) => ({ userId: id })) } });
    eventManager.emit('AlbumShare');
    return true;
  } catch (error) {
    handleError(error, $t('errors.error_adding_users_to_album'));
  }
};

/**
 * Invite people to an album, a collection or a shared space with an explicit role (FL-53).
 *
 * `handleAddUsersToAlbum` above is the picker's call and lets the server apply its default
 * role; the Frameleaf share dialog chooses Editor or Viewer at invitation time, so it sends
 * the role with each member. The grant is the album membership the server stores — never a
 * local recipient list.
 */
export const handleInviteAlbumUsers = async (album: AlbumResponseDto, albumUsers: AlbumUserCreateDto[]) => {
  const $t = await getFormatter();

  try {
    await addUsersToAlbum({ id: album.id, addUsersDto: { albumUsers } });
    eventManager.emit('AlbumShare');
    return true;
  } catch (error) {
    handleError(error, $t('errors.error_adding_users_to_album'));
    return false;
  }
};

export const handleRemoveUserFromAlbum = async (album: AlbumResponseDto, albumUser: UserResponseDto) => {
  const $t = await getFormatter();

  const confirmed = await modalManager.showDialog({
    title: $t('album_remove_user'),
    prompt: $t('album_remove_user_confirmation', { values: { user: albumUser.name } }),
    confirmText: $t('remove_user'),
  });

  if (!confirmed) {
    return;
  }

  try {
    await removeUserFromAlbum({ id: album.id, userId: albumUser.id });
    eventManager.emit('AlbumUserDelete', { albumId: album.id, userId: albumUser.id });
  } catch (error) {
    handleError(error, $t('errors.unable_to_remove_album_users'));
  }
};

/**
 * Leave an album, a collection or a shared space you are a member of (FL-53).
 *
 * `DELETE /albums/{id}/user/me` is the server's own "remove myself" form, so the caller can
 * never be tricked into removing someone else. The confirmation is the Frameleaf dialog's
 * job; this only performs the removal and announces it so the page can navigate away.
 */
export const handleLeaveAlbum = async (album: AlbumResponseDto) => {
  const $t = await getFormatter();

  try {
    await removeUserFromAlbum({ id: album.id, userId: 'me' });
    eventManager.emit('AlbumUserDelete', { albumId: album.id, userId: authManager.user.id });
    return true;
  } catch (error) {
    handleError(error, $t('errors.unable_to_remove_album_users'));
    return false;
  }
};

const handleUpdateThumbnail = async (album: AlbumResponseDto, assetId: string) => {
  const $t = await getFormatter();

  try {
    const response = await updateAlbumInfo({
      id: album.id,
      updateAlbumDto: {
        albumThumbnailAssetId: assetId,
      },
    });
    eventManager.emit('AlbumUpdate', response);
    toastManager.primary($t('album_cover_updated'));
  } catch (error) {
    handleError(error, $t('errors.unable_to_update_album_cover'));
  }
};

/**
 * Write album details from the album detail page (FL-53) and return what the server stored,
 * so the page renders the saved album rather than an optimistic guess. `handleUpdateAlbum`
 * below is the one the album list uses: it reports success with a "view album" button,
 * which is wrong when you are already on the album.
 */
export const handleUpdateAlbumInfo = async (id: string, dto: UpdateAlbumDto, options?: { message?: string }) => {
  const $t = await getFormatter();

  try {
    const response = await updateAlbumInfo({ id, updateAlbumDto: dto });
    eventManager.emit('AlbumUpdate', response);
    if (options?.message) {
      toastManager.primary(options.message);
    }
    return response;
  } catch (error) {
    handleError(error, $t('errors.unable_to_update_album_info'));
  }
};

export const handleUpdateAlbum = async ({ id }: { id: string }, dto: UpdateAlbumDto) => {
  const $t = await getFormatter();

  try {
    const response = await updateAlbumInfo({ id, updateAlbumDto: dto });
    eventManager.emit('AlbumUpdate', response);
    toastManager.primary({
      description: $t('album_info_updated'),
      button: { label: $t('view_album'), onclick: () => goto(Route.viewAlbum({ id })) },
    });

    return true;
  } catch (error) {
    handleError(error, $t('errors.unable_to_update_album_info'));
  }
};

/**
 * Move an album into a collection, or out of one (`collectionId: null`) so it
 * stands on its own. The server enforces the one-level rule and ownership; the
 * caller decides whether to refresh the directory.
 */
export const handleMoveAlbumToCollection = async (album: AlbumResponseDto, collectionId: string | null) => {
  const $t = await getFormatter();

  try {
    const response = await moveAlbumToCollection({ id: album.id, moveAlbumDto: { collectionId } });
    eventManager.emit('AlbumUpdate', response);
    return response;
  } catch (error) {
    handleError(error, $t('errors.unable_to_update_album_info'));
  }
};

/** Create an album, a collection or a shared space from the Albums page. */
export const handleCreateAlbumEntry = async (dto: CreateAlbumDto) => {
  const $t = await getFormatter();

  try {
    const album = await createAlbum({ createAlbumDto: dto });
    eventManager.emit('AlbumCreate', album);
    return album;
  } catch (error) {
    handleError(error, $t('errors.failed_to_create_album'));
  }
};

export const handleDeleteAlbum = async (album: AlbumResponseDto, options?: { prompt?: boolean; notify?: boolean }) => {
  const $t = await getFormatter();
  const { prompt = true, notify = true } = options ?? {};

  if (prompt) {
    let descendantCount = 0;
    try {
      const result = await getAlbumDescendantCount({ id: album.id });
      descendantCount = result.count;
    } catch {
      // Permission denied or network error — fall back to the simple confirmation
      // rather than blocking the delete on the count lookup.
    }

    const baseConfirmation =
      album.albumName.length > 0
        ? $t('album_delete_confirmation', { values: { album: album.albumName } })
        : $t('unnamed_album_delete_confirmation');
    const description = $t('album_delete_confirmation_description');
    const nestedNotice =
      descendantCount > 0 ? $t('album_delete_confirmation_nested', { values: { count: descendantCount } }) : '';

    const promptText = [baseConfirmation, nestedNotice, description].filter(Boolean).join(' ');
    const success = await modalManager.showDialog({ prompt: promptText });
    if (!success) {
      return false;
    }
  }

  try {
    await deleteAlbum({ id: album.id });
    eventManager.emit('AlbumDelete', album);
    if (notify) {
      toastManager.primary();
    }
    return true;
  } catch (error) {
    handleError(error, $t('errors.unable_to_delete_album'), { notify });
    return false;
  }
};

export const handleDownloadAlbum = async (album: AlbumResponseDto) => {
  await downloadArchive(album.albumName, { albumId: album.id });
};
