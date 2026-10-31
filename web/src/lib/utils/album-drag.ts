/**
 * Custom MIME type used to carry an album id across drag events. Using a
 * dedicated type means our drop targets only react to album drags — other
 * drag sources (files, text, browser tabs) are ignored automatically.
 */
export const ALBUM_DRAG_MIME = 'application/x-immich-album-id';

export function setAlbumDragData(event: DragEvent, albumId: string) {
  if (!event.dataTransfer) {
    return;
  }
  event.dataTransfer.setData(ALBUM_DRAG_MIME, albumId);
  event.dataTransfer.effectAllowed = 'move';
}

export function getAlbumDragData(event: DragEvent): string | null {
  return event.dataTransfer?.getData(ALBUM_DRAG_MIME) || null;
}

/**
 * Detect the album-drag MIME during dragover/dragenter. We can't call
 * `getData` there (the browser locks the payload for security), but the list
 * of present types is always readable. Use this to gate `preventDefault`.
 */
export function isAlbumDrag(event: DragEvent): boolean {
  return event.dataTransfer?.types.includes(ALBUM_DRAG_MIME) ?? false;
}
