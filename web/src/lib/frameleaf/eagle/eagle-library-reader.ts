import {
  eagleFileName,
  eagleLibraryFingerprint,
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
    const fileName = findEagleItemFile(item, files.keys());
    return fileName ? { ...item, ext: originalExtension(fileName), file: files.get(fileName) } : item;
  });

  const fingerprint = eagleLibraryFingerprint(metadata, library.folders, folders.length);
  return { name, ...library, items, fingerprint };
}

/** Resolve copied originals by name before falling back to an unambiguous file of the declared type. */
function findEagleItemFile(item: Pick<EagleItem, 'name' | 'ext'>, fileNames: Iterable<string>) {
  const fold = (name: string) => name.normalize('NFC').toLowerCase();
  const name = fold(item.name);
  const candidates = [...fileNames].filter((fileName) => {
    const folded = fold(fileName);
    const ext = originalExtension(folded);
    return (
      folded !== 'metadata.json' &&
      !folded.startsWith('._') &&
      !folded.endsWith('_thumbnail.png') &&
      (item.ext ? ext === item.ext : !folded.startsWith('.') && ext !== 'xmp')
    );
  });
  const exact = eagleFileName(item);
  if (candidates.includes(exact)) {
    return exact;
  }
  const named = candidates.filter((fileName) => {
    const folded = fold(fileName);
    const dot = folded.lastIndexOf('.');
    return folded === name || (dot > 0 && folded.slice(0, dot) === name);
  });
  return named.length === 1 ? named[0] : candidates.length === 1 ? candidates[0] : undefined;
}

const originalExtension = (fileName: string) => {
  const dot = fileName.lastIndexOf('.');
  return dot > 0 ? fileName.slice(dot + 1).toLowerCase() : '';
};

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
