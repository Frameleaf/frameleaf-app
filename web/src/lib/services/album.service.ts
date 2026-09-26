import {
  addAssetsToAlbum as addToAlbum,
  addAssetsToAlbums as addToAlbums,
  addUsersToAlbum,
  AlbumUserRole,
  BulkIdErrorReason,
  createAlbum,
  deleteAlbum,
  moveAlbumToCollection,
  removeUserFromAlbum,
  setAlbumOrder,
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
import { toastManager, type ActionItem } from '@immich/ui';
import { mdiImageOutline, mdiPlusBoxOutline, mdiUpload } from '@mdi/js';
import { type MessageFormatter } from 'svelte-i18n';
import { goto } from '$app/navigation';
import { type AlbumDetailsDraft } from '$lib/frameleaf/album-directory';
import { authManager } from '$lib/managers/auth-manager.svelte';
import { eventManager } from '$lib/managers/event-manager.svelte';
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

/**
 * Remove a member from an album, a collection or a shared space. The caller has already asked
 * in the Frameleaf confirmation: re-inviting cannot undo a removal from a shared space, whose
 * members come back only by accepting a new invitation.
 */
export const handleRemoveUserFromAlbum = async (album: AlbumResponseDto, albumUser: UserResponseDto) => {
  const $t = await getFormatter();

  try {
    await removeUserFromAlbum({ id: album.id, userId: albumUser.id });
    eventManager.emit('AlbumUserDelete', { albumId: album.id, userId: albumUser.id });
    return true;
  } catch (error) {
    handleError(error, $t('errors.unable_to_remove_album_users'));
    return false;
  }
};

/**
 * Leave an album, a collection or a shared space you are a member of (FL-53).
 *
 * `DELETE /albums/{id}/user/me` is the server's own "remove myself" form, so the caller can
 * never be tricked into removing someone else. The confirmation is the Frameleaf dialog's
 * job; this only performs the removal and announces it so the page can navigate away.
 */
/**
 * Albums this tab left itself, and when (FL-53). The leave action navigates away on its own, so the
 * "you were removed" handling on an open album or space page ignores the removal it caused — the
 * local announcement and the server's websocket echo alike — and exactly one navigation happens.
 */
const localLeaves = new Map<string, number>();
const LOCAL_LEAVE_WINDOW = 60_000;

export const leftLocally = (albumId: string, now = Date.now()) => {
  const at = localLeaves.get(albumId);
  return at !== undefined && now - at < LOCAL_LEAVE_WINDOW;
};

export const handleLeaveAlbum = async (album: AlbumResponseDto) => {
  const $t = await getFormatter();

  localLeaves.set(album.id, Date.now());
  try {
    await removeUserFromAlbum({ id: album.id, userId: 'me' });
    eventManager.emit('AlbumUserDelete', { albumId: album.id, userId: authManager.user.id });
    return true;
  } catch (error) {
    localLeaves.delete(album.id);
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
 * Save the Frameleaf edit dialog (`CollectionFormDialog`, FL-52): name, description and icon
 * through `PATCH /albums/{id}`, then the move when the dialog offered the collection field and
 * it changed. Returns the album as the server stored it, or nothing when anything failed.
 *
 * The two writes are separate requests. If the details save but the move fails, the saved
 * details are still announced (`AlbumUpdate`) so every view shows them, and the move error is
 * reported on its own; the dialog stays open so the move can be tried again.
 */
export const handleEditAlbumDetails = async (album: AlbumResponseDto, draft: AlbumDetailsDraft) => {
  const $t = await getFormatter();
  const { parentId, ...details } = draft;

  let saved: AlbumResponseDto;
  try {
    saved = await updateAlbumInfo({ id: album.id, updateAlbumDto: details });
  } catch (error) {
    handleError(error, $t('errors.unable_to_update_album_info'));
    return;
  }

  if (parentId === undefined || parentId === (album.parentId ?? null)) {
    eventManager.emit('AlbumUpdate', saved);
    return saved;
  }

  try {
    saved = await moveAlbumToCollection({ id: album.id, moveAlbumDto: { collectionId: parentId } });
  } catch (error) {
    eventManager.emit('AlbumUpdate', saved);
    handleError(error, $t('frameleaf_albums_move_failed'));
    return;
  }
  eventManager.emit('AlbumUpdate', saved);
  return saved;
};

/**
 * Move an album into a collection, or out of one (`collectionId: null`) so it
 * stands on its own. The server enforces the one-level rule and ownership; the
 * caller decides whether to refresh the directory.
 */
/** A 409 from the album directory endpoints: the change was decided on an outdated directory (FL-52). */
export const isStaleDirectoryError = (error: unknown) => (error as { status?: number } | undefined)?.status === 409;

/**
 * Move an album into or out of a collection. The server is told where this page last saw the album,
 * so a move made from an outdated directory (it was moved elsewhere since) comes back as `'stale'`
 * for the caller to reload, instead of silently undoing the other move (FL-52).
 */
export const handleMoveAlbumToCollection = async (album: AlbumResponseDto, collectionId: string | null) => {
  const $t = await getFormatter();

  try {
    const response = await moveAlbumToCollection({
      id: album.id,
      moveAlbumDto: { collectionId, expectedParentId: album.parentId },
    });
    eventManager.emit('AlbumUpdate', response);
    return response;
  } catch (error) {
    if (isStaleDirectoryError(error)) {
      return 'stale' as const;
    }
    handleError(error, $t('errors.unable_to_update_album_info'));
  }
};

/**
 * Save the person's own order for one group of their album directory (FL-52). `'stale'` when the
 * group changed since the page loaded it (the caller reloads); `false` on any other failure.
 */
export const handleSetAlbumOrder = async (parentId: string | null, albumIds: string[]) => {
  const $t = await getFormatter();

  try {
    await setAlbumOrder({ albumOrderDto: { parentId, albumIds } });
    return true;
  } catch (error) {
    if (isStaleDirectoryError(error)) {
      return 'stale' as const;
    }
    handleError(error, $t('frameleaf_albums_order_failed'));
    return false;
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

/**
 * Delete an album, a collection or a shared space. Every caller asks first in the Frameleaf
 * `AlbumConfirmDialog` (the design's `DeleteDialog`, AL-4), so this only performs the delete.
 */
export const handleDeleteAlbum = async (album: AlbumResponseDto, options?: { notify?: boolean }) => {
  const $t = await getFormatter();
  const { notify = true } = options ?? {};

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
  // The download's row (panel or public strip) shows a failure or a cancel with its recovery, so
  // callers that fire and forget get no unhandled rejection.
  await downloadArchive(album.albumName, { albumId: album.id }).catch(() => {});
};
