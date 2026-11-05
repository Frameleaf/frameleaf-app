/**
 * Boards' "New collection" dialog (prototype `NewCollectionDialog`), opened in place from the rail's
 * "+", Boards' Add menu and a collection's "…" menu. The rail draws the dialog, so whichever of them
 * asks, the person stays where they are.
 */
class BoardsCollectionUi {
  /** The dialog is open, with the collection it starts inside (null = the top level). */
  request = $state<{ parentId: string | null } | null>(null);

  newCollection(parentId: string | null = null) {
    this.request = { parentId };
  }

  close() {
    this.request = null;
  }
}

export const boardsCollectionUi = new BoardsCollectionUi();
