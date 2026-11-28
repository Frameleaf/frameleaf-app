/**
 * Photos dragged out of a grid onto an album in the sidebar, which adds them to it. The ids travel here, not in
 * the drag's data: a page may read that only on drop, and the album rows must know what is over them before.
 */
let selection: (() => string[]) | undefined;
let dragged: string[] | null = null;

/** The grid on screen says what is selected; returns its undo, for when it leaves. */
export const providePhotoSelection = (get: () => string[]) => {
  selection = get;
  return () => {
    if (selection === get) {
      selection = undefined;
    }
  };
};

/** Dragging a selected photo takes the whole selection; any other photo goes alone. */
export const startPhotoDrag = (event: DragEvent, assetId: string) => {
  const selected = selection?.() ?? [];
  dragged = selected.includes(assetId) ? [...selected] : [assetId];
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = 'copy';
    event.dataTransfer.setData('text/plain', String(dragged.length));
  }
};

export const endPhotoDrag = () => {
  dragged = null;
};

export const draggedPhotos = () => dragged;
