import { getAlbumTree, type AlbumTreeResponseDto, type LibraryViewScope } from '@frameleaf/sdk';
import { invalidate } from '$app/navigation';
import { onLibraryAccessChange } from '$lib/frameleaf/library-access';

type Entry = {
  tree: AlbumTreeResponseDto;
  json: string;
  /** The loader re-run this entry's own refresh asked for: answer it without reading again. */
  fresh?: boolean;
  revalidating?: boolean;
};

const entries = new Map<string, Entry>();
const access = { generation: 0, watching: false };

/** Installed on first use, before anything is cached. */
const watchAccess = () => {
  if (access.watching) {
    return;
  }
  access.watching = true;
  onLibraryAccessChange(() => {
    access.generation++;
    entries.clear();
  });
};

const read = async (key: string, libraryScope?: LibraryViewScope) => {
  const generation = access.generation;
  const tree = await getAlbumTree({ libraryScope });
  if (generation === access.generation) {
    entries.set(key, { tree, json: JSON.stringify(tree) });
  }
  return tree;
};

const revalidate = async (key: string, libraryScope: LibraryViewScope | undefined, entry: Entry) => {
  entry.revalidating = true;
  const generation = access.generation;
  try {
    const tree = await getAlbumTree({ libraryScope });
    const json = JSON.stringify(tree);
    if (generation !== access.generation || entries.get(key) !== entry || json === entry.json) {
      return;
    }
    entries.set(key, { tree, json, fresh: true });
    await invalidate('album:data');
  } catch {
    // keep showing the last tree; the next visit reads again
  } finally {
    entry.revalidating = false;
  }
};

/**
 * FL-1596: GET /albums/tree, stale-while-revalidate. A tree read before answers at once while a
 * background read checks it; only a changed answer re-runs the album loaders (`album:data`).
 */
export const loadAlbumTree = async (libraryScope?: LibraryViewScope): Promise<AlbumTreeResponseDto> => {
  watchAccess();
  const key = libraryScope ?? '';
  const entry = entries.get(key);
  if (!entry) {
    return read(key, libraryScope);
  }
  if (entry.fresh) {
    entry.fresh = false;
  } else if (!entry.revalidating) {
    void revalidate(key, libraryScope, entry);
  }
  return entry.tree;
};

/** After an edit made here: drop every cached tree so the re-run loaders wait for the new one. */
export const refreshAlbumTrees = () => {
  entries.clear();
  return invalidate('album:data');
};
