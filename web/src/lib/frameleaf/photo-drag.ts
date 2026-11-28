/**
 * Photos dragged out of a grid onto an album in the sidebar, which adds them to it. The ids travel here, not in
 * the drag's data: a page may read that only on drop, and the album rows must know what is over them before.
 */
let selection: (() => string[] | undefined) | undefined;
let refused: (() => void) | undefined;
let dragged: string[] | null = null;

/** The grid on screen says what is selected; returns its undo, for when it leaves. */
export const providePhotoSelection = (get: () => string[] | undefined, onRefused?: () => void) => {
  selection = get;
  refused = onRefused;
  return () => {
    if (selection === get) {
      selection = undefined;
      refused = undefined;
    }
  };
};

/** Dragging a selected photo takes the whole selection; any other photo goes alone. */
export const startPhotoDrag = (event: DragEvent, assetId: string) => {
  const selected = selection ? selection() : [];
  if (!selected) {
    // a selection that cannot be listed (every match, not all of them loaded): Add to album takes it whole
    event.preventDefault();
    dragged = null;
    refused?.();
    return;
  }
  dragged = selected.includes(assetId) ? [...selected] : [assetId];
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = 'copy';
    // a type of its own: a browser needs some data to start a drag, and text would be typed into a field it lands on
    event.dataTransfer.setData('application/x-frameleaf-photos', String(dragged.length));
  }
};

export const endPhotoDrag = () => {
  dragged = null;
};

export const draggedPhotos = () => dragged;
