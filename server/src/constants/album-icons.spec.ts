import { describe, expect, it } from 'vitest';
import {
  ALBUM_ICON_GROUPS,
  LEGACY_ALBUM_ICON_KEYS,
  MDI_ICON_CATALOGUE_VERSION,
  MDI_ICON_NAMES,
  isMdiIconName,
  isValidAlbumIcon,
} from 'src/constants/album-icons.js';

describe('album icon catalogue', () => {
  it('pins a catalogue version and carries the whole Material Design Icons name set', () => {
    expect(MDI_ICON_CATALOGUE_VERSION).toBe('7.4.47');
    expect(MDI_ICON_NAMES.length).toBeGreaterThan(7000);
    for (const name of MDI_ICON_NAMES) {
      expect(name).toMatch(/^mdi[A-Z][A-Za-z0-9]*$/);
    }
    expect(new Set(MDI_ICON_NAMES).size).toBe(MDI_ICON_NAMES.length);
  });

  it('offers the categorised suggested set of 227 icons, each present in the catalogue', () => {
    const suggested = ALBUM_ICON_GROUPS.flatMap((group) => group.icons);
    expect(ALBUM_ICON_GROUPS.length).toBe(9);
    expect(suggested).toHaveLength(227);
    expect(new Set(suggested.map(({ name }) => name)).size).toBe(227);
    for (const group of ALBUM_ICON_GROUPS) {
      expect(group.label.length).toBeGreaterThan(0);
    }
    for (const { name, label } of suggested) {
      expect(isMdiIconName(name)).toBe(true);
      expect(label.length).toBeGreaterThan(0);
    }
  });

  it('accepts any catalogue name and every legacy key, and rejects anything else', () => {
    expect(isValidAlbumIcon('mdiCameraOutline')).toBe(true);
    expect(isValidAlbumIcon('mdiZodiacVirgo')).toBe(true);
    for (const key of LEGACY_ALBUM_ICON_KEYS) {
      expect(isValidAlbumIcon(key)).toBe(true);
    }
    expect(isValidAlbumIcon('mdiNotARealIcon')).toBe(false);
    expect(isValidAlbumIcon('camera-outline')).toBe(false);
    expect(isValidAlbumIcon('')).toBe(false);
    expect(isValidAlbumIcon('<script>')).toBe(false);
  });
});
