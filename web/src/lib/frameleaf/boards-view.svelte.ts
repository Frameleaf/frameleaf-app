import { browser } from '$app/env';

/**
 * Boards' layout (prototype ProWorkspace.jsx `ViewMenu`): Board keeps each item's shape in
 * columns, Grid crops to even squares. Remembered per device; the thumbnail size and "Show file
 * names" are Boards' own grid preferences (`designLibraryGridPreferences`).
 */
export type BoardsLayout = 'board' | 'grid';

export const BOARDS_LAYOUT_STORAGE_KEY = 'frameleaf-boards-layout';

const read = (): BoardsLayout => {
  if (!browser) {
    return 'board';
  }
  try {
    return localStorage.getItem(BOARDS_LAYOUT_STORAGE_KEY) === 'grid' ? 'grid' : 'board';
  } catch {
    return 'board';
  }
};

class BoardsView {
  #layout = $state<BoardsLayout>(read());

  get layout() {
    return this.#layout;
  }

  set layout(value: BoardsLayout) {
    this.#layout = value;
    if (browser) {
      try {
        localStorage.setItem(BOARDS_LAYOUT_STORAGE_KEY, value);
      } catch {
        // Private windows may refuse storage; the choice still holds for this visit.
      }
    }
  }
}

export const boardsView = new BoardsView();
