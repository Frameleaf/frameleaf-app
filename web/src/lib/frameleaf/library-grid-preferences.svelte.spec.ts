import { beforeEach, describe, expect, it } from 'vitest';
import { THUMBNAIL_SIZE_DEFAULT, THUMBNAIL_SIZE_MAX, THUMBNAIL_SIZE_MIN } from '$lib/frameleaf/library-grid';
import {
  LibraryGridPreferences,
  THUMBNAIL_SIZE_STORAGE_KEY,
  WORK_FILE_NAMES_STORAGE_KEY,
} from '$lib/frameleaf/library-grid-preferences.svelte';

describe('LibraryGridPreferences', () => {
  beforeEach(() => localStorage.clear());

  it('starts at the default size with file names hidden', () => {
    const preferences = new LibraryGridPreferences();
    expect(preferences.thumbnailSize).toBe(THUMBNAIL_SIZE_DEFAULT);
    expect(preferences.showFileNames).toBe(false);
  });

  it('remembers the Thumbnail size on this device, snapped to the scale', () => {
    const preferences = new LibraryGridPreferences();
    preferences.thumbnailSize = 262;
    expect(preferences.thumbnailSize).toBe(260);
    expect(localStorage.getItem(THUMBNAIL_SIZE_STORAGE_KEY)).toBe('260');
    expect(new LibraryGridPreferences().thumbnailSize).toBe(260);
  });

  it('ignores a stored size it cannot read, or one outside the scale', () => {
    localStorage.setItem(THUMBNAIL_SIZE_STORAGE_KEY, 'large');
    expect(new LibraryGridPreferences().thumbnailSize).toBe(THUMBNAIL_SIZE_DEFAULT);
    localStorage.setItem(THUMBNAIL_SIZE_STORAGE_KEY, '9000');
    expect(new LibraryGridPreferences().thumbnailSize).toBe(THUMBNAIL_SIZE_MAX);
  });

  it('offers the next size only while one exists', () => {
    const preferences = new LibraryGridPreferences();
    preferences.thumbnailSize = THUMBNAIL_SIZE_MAX;
    expect(preferences.canZoomIn).toBe(false);
    expect(preferences.nextSize(1)).toBeNull();
    expect(preferences.nextSize(-1)).toBe(260);
    preferences.thumbnailSize = THUMBNAIL_SIZE_MIN;
    expect(preferences.canZoomOut).toBe(false);
    expect(preferences.nextSize(-1)).toBeNull();
  });

  it('remembers the Work file-name toggle under the template key', () => {
    const preferences = new LibraryGridPreferences();
    preferences.toggleFileNames();
    expect(preferences.showFileNames).toBe(true);
    expect(localStorage.getItem(WORK_FILE_NAMES_STORAGE_KEY)).toBe('true');
    expect(new LibraryGridPreferences().showFileNames).toBe(true);
    preferences.toggleFileNames();
    expect(new LibraryGridPreferences().showFileNames).toBe(false);
  });
});
