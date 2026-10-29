import {
  parseEagleItem,
  parseEagleLibraryMetadata,
  unreadableEagleItem,
  type EagleItem,
  type EagleLibrary,
} from '$lib/frameleaf/eagle/eagle-import';

/**
 * Reads an Eagle library folder chosen in the browser. Only the library's lists and each item's
 * `metadata.json` are read here; the files themselves are only opened when they are sent. Nothing
 * is ever written to the library.
 */

/** One file inside the library, with its path below the `.library` folder (`images/K1.info/a.jpg`). */
export interface LibraryEntry {
  path: string;
  file: File;
}

export class EagleLibraryError extends Error {
  constructor(public readonly reason: 'not-library' | 'unreadable') {
    super(reason);
    this.name = 'EagleLibraryError';
  }
}

const INFO_FOLDER = /^images\/([^/]+)\.info\/([^/]+)$/;
const READ_CONCURRENCY = 16;

const readJson = async (file: File | undefined): Promise<unknown> => {
  if (!file) {
    return undefined;
  }
  try {
    return JSON.parse(await file.text()) as unknown;
  } catch {
    return undefined;
  }
};

async function mapLimit<T, R>(values: T[], limit: number, run: (value: T) => Promise<R>): Promise<R[]> {
  const results = Array.from<R>({ length: values.length });
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, values.length) }, async () => {
      while (next < values.length) {
        const index = next++;
        results[index] = await run(values[index]);
      }
    }),
  );
  return results;
}

/** Builds the library from its files. `name` is the chosen folder's name. */
export async function readEagleLibrary(
  name: string,
  entries: LibraryEntry[],
  onProgress?: (read: number, total: number) => void,
): Promise<EagleLibrary> {
  if (!name.toLowerCase().endsWith('.library')) {
    throw new EagleLibraryError('not-library');
  }
  const byPath = new Map(entries.map((entry) => [entry.path, entry.file]));
  const metadataFile = byPath.get('metadata.json');
  if (!metadataFile) {
    throw new EagleLibraryError('not-library');
  }
  const metadata = await readJson(metadataFile);
  if (metadata === undefined) {
    throw new EagleLibraryError('unreadable');
  }
  const library = parseEagleLibraryMetadata(metadata);

  const infoFolders = new Map<string, Map<string, File>>();
  for (const { path, file } of entries) {
    const match = INFO_FOLDER.exec(path);
    if (match) {
      const [, id, fileName] = match;
      const files = infoFolders.get(id) ?? new Map<string, File>();
      files.set(fileName, file);
      infoFolders.set(id, files);
    }
  }

  let read = 0;
  const folders = [...infoFolders].sort(([a], [b]) => a.localeCompare(b));
  const items = await mapLimit(folders, READ_CONCURRENCY, async ([id, files]): Promise<EagleItem> => {
    const json = await readJson(files.get('metadata.json'));
    onProgress?.(++read, folders.length);
    if (json === undefined) {
      return unreadableEagleItem(id);
    }
    const item = parseEagleItem(json, id);
    const file = findItemFile(item, files);
    return file ? { ...item, file } : item;
  });

  return { name, ...library, items };
}

/** The item's own file: `<name>.<ext>`, or the one other file of that type beside its metadata. */
function findItemFile(item: EagleItem, files: Map<string, File>): File | undefined {
  const exact = files.get(`${item.name}.${item.ext}`);
  if (exact) {
    return exact;
  }
  const candidates = [...files].filter(
    ([fileName]) =>
      fileName !== 'metadata.json' &&
      !fileName.endsWith('_thumbnail.png') &&
      fileName.toLowerCase().endsWith(`.${item.ext}`),
  );
  return candidates.length === 1 ? candidates[0][1] : undefined;
}

/** Files from `<input webkitdirectory>`: their paths start with the chosen folder's name. */
export function entriesFromFileList(files: Iterable<File>): { name: string; entries: LibraryEntry[] } {
  let name = '';
  const entries: LibraryEntry[] = [];
  for (const file of files) {
    const relative = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
    const [root, ...rest] = relative.split('/');
    name ||= root;
    if (root === name && rest.length > 0) {
      entries.push({ path: rest.join('/'), file });
    }
  }
  return { name, entries };
}

/** The small part of the File System Access API this reader uses. */
export interface DirectoryHandleLike {
  kind: 'directory';
  name: string;
  values(): AsyncIterable<DirectoryHandleLike | FileHandleLike>;
}
export interface FileHandleLike {
  kind: 'file';
  name: string;
  getFile(): Promise<File>;
}

/** Files from `showDirectoryPicker()`. Only the lists and `images/` are walked; backups are left alone. */
export async function entriesFromDirectory(
  root: DirectoryHandleLike,
): Promise<{ name: string; entries: LibraryEntry[] }> {
  const entries: LibraryEntry[] = [];
  const walk = async (directory: DirectoryHandleLike, prefix: string, depth: number) => {
    for await (const handle of directory.values()) {
      const path = `${prefix}${handle.name}`;
      if (handle.kind === 'file') {
        if (depth === 0 ? ['metadata.json', 'tags.json'].includes(handle.name) : true) {
          entries.push({ path, file: await handle.getFile() });
        }
      } else if ((depth === 0 && handle.name === 'images') || (depth === 1 && handle.name.endsWith('.info'))) {
        await walk(handle, `${path}/`, depth + 1);
      }
    }
  };
  await walk(root, '', 0);
  return { name: root.name, entries };
}

type DirectoryPicker = (options?: { id?: string; mode?: 'read' }) => Promise<DirectoryHandleLike>;
/** `showDirectoryPicker`, where the browser has it. */
export const directoryPicker = (): DirectoryPicker | undefined =>
  (globalThis as unknown as { showDirectoryPicker?: DirectoryPicker }).showDirectoryPicker?.bind(globalThis);
