/**
 * The little the rest of Boards needs to know about an Eagle import: whether the dialog is open,
 * and how far a running import has got, so the rail can show it while the dialog is hidden. It is
 * kept apart from the importer so the rail and the page don't load the importer until it is used.
 */
export interface EagleRunStatus {
  readonly state: 'running' | 'stopping' | 'stopped' | 'finished';
  readonly done: number;
  readonly total: number;
}

class EagleImportUi {
  open = $state(false);
  /** The import running in this tab, if any. */
  run = $state<EagleRunStatus | undefined>();
  /** Bumped when a resumable record changes, so the paused banner reads it again. */
  revision = $state(0);

  /** Opens the dialog: at the first step, or where the import in this tab has got to. */
  show() {
    this.open = true;
  }
}

export const eagleImportUi = new EagleImportUi();

/** Rounded percent, never 100 until everything is in. */
export const eaglePercent = ({ done, total }: Pick<EagleRunStatus, 'done' | 'total'>) =>
  total <= 0 ? 0 : done >= total ? 100 : Math.min(99, Math.round((done / total) * 100));
