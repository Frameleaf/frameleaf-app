import { mdiCameraBurst, mdiFolderOutline, mdiHeartOutline } from '@mdi/js';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { ALBUM_ICONS, albumIconPath } from '$lib/utils/album-icons';
import {
  buildCatalogueEntries,
  derivedIconLabel,
  iconPathFor,
  loadIconCatalogue,
  loadIconPaths,
  needsIconPaths,
  resetIconCatalogueCache,
  searchCatalogue,
} from './icon-catalogue';

const catalogue = {
  version: '7.4.47',
  names: ['mdiCameraBurst', 'mdiHeartOutline', 'mdiImageAlbum'],
  suggested: [{ label: 'Albums', icons: [{ name: 'mdiImageAlbum', label: 'Photo Album' }] }],
};
const paths = { mdiCameraBurst, mdiHeartOutline };
const response = () => Response.json(paths);
const fetchPaths = vi.fn<typeof fetch>();

beforeEach(() => {
  resetIconCatalogueCache();
  fetchPaths.mockReset();
  sdkMock.getAlbumIconCatalogue.mockReset();
  vi.stubGlobal('fetch', fetchPaths);
});
afterEach(() => {
  resetIconCatalogueCache();
  vi.unstubAllGlobals();
});

it('shares one pending path request and reuses its successful result', async () => {
  let finish!: (response: Response) => void;
  fetchPaths.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const first = loadIconPaths();
  expect(loadIconPaths()).toBe(first);
  finish(response());
  await expect(first).resolves.toEqual(paths);
  expect(loadIconPaths()).toBe(first);
  expect(fetchPaths).toHaveBeenCalledExactlyOnceWith('/mdi-icon-paths.json');
});

it.each([404, 429, 503])('rejects HTTP %s JSON errors and retries the path request', async (status) => {
  fetchPaths.mockResolvedValueOnce(Response.json({ message: 'unavailable' }, { status }));
  fetchPaths.mockResolvedValueOnce(response());
  await expect(loadIconPaths()).rejects.toThrow(`HTTP ${status}`);
  await expect(loadIconPaths()).resolves.toEqual(paths);
  expect(fetchPaths).toHaveBeenCalledTimes(2);
});

it('retries a malformed JSON response', async () => {
  fetchPaths.mockResolvedValueOnce(new Response('<html>unavailable</html>')).mockResolvedValueOnce(response());
  await expect(loadIconPaths()).rejects.toThrow();
  await expect(loadIconPaths()).resolves.toEqual(paths);
  expect(fetchPaths).toHaveBeenCalledTimes(2);
});

it('retries a rejected network request', async () => {
  const error = new Error('offline');
  fetchPaths.mockRejectedValueOnce(error).mockResolvedValueOnce(response());
  await expect(loadIconPaths()).rejects.toBe(error);
  await expect(loadIconPaths()).resolves.toEqual(paths);
});

it('shares the SDK catalogue request, retains success, and clears it on reset', async () => {
  sdkMock.getAlbumIconCatalogue.mockResolvedValue(catalogue);
  const first = loadIconCatalogue();
  expect(loadIconCatalogue()).toBe(first);
  await expect(first).resolves.toBe(catalogue);
  expect(loadIconCatalogue()).toBe(first);
  expect(sdkMock.getAlbumIconCatalogue).toHaveBeenCalledOnce();
  resetIconCatalogueCache();
  await expect(loadIconCatalogue()).resolves.toBe(catalogue);
  expect(sdkMock.getAlbumIconCatalogue).toHaveBeenCalledTimes(2);
});

it('retries a failed SDK catalogue request', async () => {
  const error = new Error('offline');
  sdkMock.getAlbumIconCatalogue.mockRejectedValueOnce(error).mockResolvedValueOnce(catalogue);
  await expect(loadIconCatalogue()).rejects.toBe(error);
  await expect(loadIconCatalogue()).resolves.toBe(catalogue);
  expect(sdkMock.getAlbumIconCatalogue).toHaveBeenCalledTimes(2);
});

it('keeps legacy icon paths local and falls back for unknown or inherited keys', () => {
  expect(Object.keys(ALBUM_ICONS)).toHaveLength(31);
  expect(albumIconPath('folder')).toBe(mdiFolderOutline);
  expect(albumIconPath('heart')).toBe(mdiHeartOutline);
  expect(iconPathFor('heart')).toBe(mdiHeartOutline);
  expect(needsIconPaths('heart')).toBe(false);
  for (const key of [null, undefined, '', 'unknown', '__proto__', 'constructor']) {
    expect(albumIconPath(key)).toBe(mdiFolderOutline);
    expect(iconPathFor(key)).toBe(mdiFolderOutline);
    expect(needsIconPaths(key)).toBe(false);
  }
  expect(fetchPaths).not.toHaveBeenCalled();
});

it('uses known MDI geometry only when loaded and retains valid-name fallback', () => {
  expect(needsIconPaths('mdiCameraBurst')).toBe(true);
  expect(iconPathFor('mdiCameraBurst')).toBe(mdiFolderOutline);
  expect(iconPathFor('mdiCameraBurst', paths)).toBe(mdiCameraBurst);
  expect(iconPathFor('mdiUnknown', paths)).toBe(mdiFolderOutline);
  for (const name of ['mdi', 'mdi1bad', 'mdiCamera<script>', 'mdi' + 'A'.repeat(81)]) {
    expect(needsIconPaths(name)).toBe(false);
    expect(iconPathFor(name, paths)).toBe(mdiFolderOutline);
  }
});

it('retains curated labels and derives searchable words for other catalogue names', () => {
  expect(derivedIconLabel('mdiImageAlbum')).toBe('image album');
  expect(derivedIconLabel('mdiNumeric12Box')).toBe('numeric 12 box');
  const entries = buildCatalogueEntries(catalogue);
  expect(entries).toEqual([
    { name: 'mdiCameraBurst', label: 'camera burst', text: 'camera burst' },
    { name: 'mdiHeartOutline', label: 'heart outline', text: 'heart outline' },
    { name: 'mdiImageAlbum', label: 'Photo Album', text: 'photo album image album' },
  ]);
  expect(searchCatalogue(entries, '  ')).toBe(entries);
  expect(searchCatalogue(entries, 'ALBUM photo')).toEqual([entries[2]]);
  expect(searchCatalogue(entries, 'outline camera')).toEqual([]);
});
