import { MediaQuery } from 'svelte/reactivity';
import {
  clampThumbnailSize,
  stepThumbnailSize,
  THUMBNAIL_SIZE_DEFAULT,
  THUMBNAIL_SIZE_MAX,
  THUMBNAIL_SIZE_MIN,
} from '$lib/frameleaf/library-grid';

/**
 * Per-device library grid preferences (FL-33): the Thumbnail size and whether Work shows file names.
 *
 * Both are remembered on this device only, as the template does (`App.jsx` `frameleaf-work-filenames`
 * in `localStorage`); they are view chrome, not account settings. The shell's status bar mounts
 * `ThumbnailSizeControl` and the library toolbar mounts `WorkFileNamesToggle`; both read and write
 * this one store, and so do the grid's pinch, Ctrl-scroll and +/− gestures.
 */
export const THUMBNAIL_SIZE_STORAGE_KEY = 'frameleaf-thumbnail-size';
/** The template's key, kept so a preference set in the prototype review carries over. */
export const WORK_FILE_NAMES_STORAGE_KEY = 'frameleaf-work-filenames';

const storage = (): Storage | null => {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
};

const read = (key: string): string | null => {
  try {
    return storage()?.getItem(key) ?? null;
  } catch {
    return null;
  }
};

const write = (key: string, value: string) => {
  try {
    storage()?.setItem(key, value);
  } catch {
    // Private mode or a full quota: the preference lasts for this page only.
  }
};

/** Phones: Browse draws three columns and Work two (`apple-style.css` / `styles.css` `max-width: 700px`). */
const phone = new MediaQuery('max-width: 700px');

export class LibraryGridPreferences {
  #thumbnailSize = $state(THUMBNAIL_SIZE_DEFAULT);
  #showFileNames = $state(false);

  constructor() {
    this.reload();
  }

  /** Read both preferences from this device again. */
  reload() {
    const size = read(THUMBNAIL_SIZE_STORAGE_KEY);
    this.#thumbnailSize = size === null ? THUMBNAIL_SIZE_DEFAULT : clampThumbnailSize(size);
    this.#showFileNames = read(WORK_FILE_NAMES_STORAGE_KEY) === 'true';
  }

  get thumbnailSize() {
    return this.#thumbnailSize;
  }

  set thumbnailSize(value: number) {
    const next = clampThumbnailSize(value);
    if (next === this.#thumbnailSize) {
      return;
    }
    this.#thumbnailSize = next;
    write(THUMBNAIL_SIZE_STORAGE_KEY, String(next));
  }

  get canZoomIn() {
    return this.#thumbnailSize < THUMBNAIL_SIZE_MAX;
  }

  get canZoomOut() {
    return this.#thumbnailSize > THUMBNAIL_SIZE_MIN;
  }

  /** The size one step larger or smaller, or `null` at the limit. */
  nextSize(direction: 1 | -1): number | null {
    const next = stepThumbnailSize(this.#thumbnailSize, direction);
    return next === this.#thumbnailSize ? null : next;
  }

  get showFileNames() {
    return this.#showFileNames;
  }

  set showFileNames(value: boolean) {
    this.#showFileNames = value;
    write(WORK_FILE_NAMES_STORAGE_KEY, String(value));
  }

  toggleFileNames() {
    this.showFileNames = !this.#showFileNames;
  }

  /** A phone-sized viewport, where the grids use fixed column counts. */
  get phone() {
    return phone.current;
  }
}

export const libraryGridPreferences = new LibraryGridPreferences();
