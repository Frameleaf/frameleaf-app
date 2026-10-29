/**
 * Reading an Eagle library on the server (FL-653, "In a folder your server can open").
 *
 * These are the pure parts the server import needs, ported from the browser importer in
 * `web/src/lib/frameleaf/eagle/eagle-import.ts` so a library read here maps exactly as one read in
 * the browser: the same fields, the same limits, the same folder colours, the same "Name (Eagle)"
 * rule at the top level, the same web-address and Added-date rules. Keep the two in step. The check
 * before importing (the plan) and the finish report are worked out in the browser from the lists
 * this module produces, so they stay in one place.
 */

/** Eagle's eight folder colours onto the collection colours (orange and yellow both become amber). */
export const EAGLE_COLOURS: Readonly<Record<string, string>> = {
  red: 'red',
  orange: 'amber',
  yellow: 'amber',
  green: 'green',
  aqua: 'teal',
  blue: 'blue',
  purple: 'purple',
  pink: 'pink',
};

/** File types Boards holds, as in the design. The server's own media types narrow this further. */
export const BOARDS_EXTENSIONS: readonly string[] = [
  'jpg',
  'jpeg',
  'png',
  'webp',
  'avif',
  'gif',
  'svg',
  'heic',
  'tif',
  'tiff',
  'psd',
  'ai',
  'pdf',
  'eps',
  'mp4',
  'mov',
  'webm',
];

/** The default new collection the import goes into. */
export const EAGLE_DEFAULT_COLLECTION = 'Studio References';

export interface EagleFolder {
  id: string;
  name: string;
  description?: string;
  color?: string;
  icon?: string;
  children: EagleFolder[];
}

export interface EagleFlatFolder extends EagleFolder {
  parent: string | null;
  depth: number;
}

export interface EagleComment {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  annotation: string;
}

export interface EagleItem {
  id: string;
  name: string;
  ext: string;
  size: number;
  width: number;
  height: number;
  url: string;
  annotation: string;
  tags: string[];
  folders: string[];
  star: number;
  isDeleted: boolean;
  modificationTime: number;
  comments: EagleComment[];
  /** The item's file was found in its folder. */
  present: boolean;
  /** The item's `metadata.json` could not be read. */
  unreadable?: boolean;
}

export type EagleTarget = { mode: 'top' } | { mode: 'inside'; inside: 'new' | string };

const text = (value: unknown, max = 10_000) => (typeof value === 'string' ? value.slice(0, max) : '');
const number = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const names = (value: unknown) =>
  list(value)
    .map((entry) => text(record(entry).name, 500).trim())
    .filter(Boolean);

/** Eagle's folder tree from the library's `metadata.json`. Folders without an id or name are skipped. */
export function parseEagleFolders(value: unknown, depth = 0): EagleFolder[] {
  if (depth > 64) {
    return [];
  }
  return list(value).flatMap((entry) => {
    const folder = record(entry);
    const id = text(folder.id, 200);
    const name = text(folder.name, 500).trim();
    if (!id || !name) {
      return [];
    }
    const color = text(folder.iconColor || folder.color, 50).toLowerCase();
    return [
      {
        id,
        name,
        ...(text(folder.description).trim() && { description: text(folder.description).trim() }),
        ...(color && { color }),
        ...(text(folder.icon, 100) && { icon: text(folder.icon, 100) }),
        children: parseEagleFolders(folder.children, depth + 1),
      },
    ];
  });
}

/** The library's own `metadata.json`: folders, smart folders, tag groups. */
export function parseEagleLibraryMetadata(value: unknown) {
  const metadata = record(value);
  return {
    folders: parseEagleFolders(metadata.folders),
    smartFolders: names(metadata.smartFolders),
    tagGroups: names(metadata.tagsGroups),
    changed: number(metadata.modificationTime) || undefined,
  };
}

/** One `images/<id>.info/metadata.json`. `fallbackId` is the folder's name without `.info`. */
export function parseEagleItem(value: unknown, fallbackId: string): EagleItem {
  const item = record(value);
  const ext = text(item.ext, 20).toLowerCase().replace(/^\./, '');
  return {
    id: text(item.id, 200) || fallbackId,
    name: text(item.name, 1000) || fallbackId,
    ext,
    size: number(item.size),
    width: number(item.width),
    height: number(item.height),
    url: text(item.url, 4000).trim(),
    annotation: text(item.annotation),
    tags: [
      ...new Set(
        list(item.tags)
          .map((tag) => text(tag, 300).trim())
          .filter(Boolean),
      ),
    ],
    folders: [
      ...new Set(
        list(item.folders)
          .map((id) => text(id, 200))
          .filter(Boolean),
      ),
    ],
    star: Math.max(0, Math.min(5, Math.round(number(item.star)))),
    isDeleted: item.isDeleted === true,
    modificationTime: number(item.modificationTime) || number(item.mtime),
    comments: list(item.comments).map((entry, index) => {
      const comment = record(entry);
      return {
        id: text(comment.id, 200) || String(index + 1),
        x: number(comment.x),
        y: number(comment.y),
        width: number(comment.width),
        height: number(comment.height),
        annotation: text(comment.annotation, 2000),
      };
    }),
    present: false,
  };
}

/** An item whose `metadata.json` could not be read: kept so it is listed, never dropped quietly. */
export const unreadableEagleItem = (id: string): EagleItem => ({ ...parseEagleItem({}, id), unreadable: true });

export const eagleFileName = (item: Pick<EagleItem, 'name' | 'ext'>) =>
  item.ext ? `${item.name}.${item.ext}` : item.name;

const FINGERPRINT_FIELDS = ['id', 'libraryId', 'createdAt', 'creationTime', 'btime'] as const;

/** cyrb53: a fast 53-bit string hash. Not for security; it only tells libraries apart. */
function cyrb53(value: string, seed: number) {
  let h1 = 0xde_ad_be_ef ^ seed;
  let h2 = 0x41_c6_ce_57 ^ seed;
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    h1 = Math.imul(h1 ^ code, 2_654_435_761);
    h2 = Math.imul(h2 ^ code, 1_597_334_677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2_246_822_507) ^ Math.imul(h2 ^ (h2 >>> 13), 3_266_489_909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2_246_822_507) ^ Math.imul(h1 ^ (h1 >>> 13), 3_266_489_909);
  return (4_294_967_296 * (2_097_151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0');
}

const flatten = (folders: EagleFolder[], parent: string | null = null, depth = 1): EagleFlatFolder[] =>
  folders.flatMap((folder) => [{ ...folder, parent, depth }, ...flatten(folder.children, folder.id, depth + 1)]);

/** Every folder, parents before their children. */
export const eagleFolders = (folders: EagleFolder[]) => flatten(folders);

/** The same identity the browser gives a library (`eagleLibraryFingerprint` in the web importer). */
export function eagleLibraryFingerprint(metadata: unknown, folders: EagleFolder[], itemCount: number) {
  const fields = record(metadata);
  for (const field of FINGERPRINT_FIELDS) {
    const value = fields[field];
    if ((typeof value === 'string' && value.trim()) || (typeof value === 'number' && Number.isFinite(value))) {
      return `eagle:${field}:${String(value).trim()}`;
    }
  }
  const source = JSON.stringify([flatten(folders).map(({ id, name }) => [id, name]), itemCount]);
  return `hash:${cyrb53(source, 1)}${cyrb53(source, 2)}`;
}

/** The collection colour for an Eagle folder colour, if it has one. */
export const eagleColour = (color?: string) => (color ? EAGLE_COLOURS[color.toLowerCase()] : undefined);

/** Whether an item comes over: in the library, of a type Boards holds, and its file is there. */
export const isComing = (item: EagleItem, supported: ReadonlySet<string>) =>
  !item.unreadable && !item.isDeleted && supported.has(item.ext) && item.present;

const sameName = (a: string, b: string) => a.trim().toLocaleLowerCase() === b.trim().toLocaleLowerCase();

/** At the top level a folder whose name matches one of your top-level collections is "Name (Eagle)". */
export function topFolderNames(folders: EagleFolder[], target: EagleTarget, existingTop: readonly string[]) {
  return new Map(
    folders.map((folder) => [
      folder.id,
      target.mode === 'top' && existingTop.some((name) => sameName(name, folder.name))
        ? `${folder.name} (Eagle)`
        : folder.name,
    ]),
  );
}

/** The item's web address as Boards records it: http(s), without a sign-in in it. */
export function eagleSourceUrl(item: Pick<EagleItem, 'url'>) {
  const value = item.url.trim();
  if (!value || value.length > 8192 || !URL.canParse(value)) {
    return;
  }
  const url = new URL(value);
  return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? value : undefined;
}

/** When the item was last changed in Eagle, if that is a time in the past. */
export function eagleAddedDate(item: Pick<EagleItem, 'modificationTime'>, now = Date.now()) {
  const time = item.modificationTime;
  return time > 0 && time < now ? new Date(time) : undefined;
}

/** A single path segment that can't leave its folder: no separators, no `.` or `..`, no NUL. */
export const isSafeSegment = (value: string) =>
  value.length > 0 && value.length <= 255 && value !== '.' && value !== '..' && !/[/\\\0]/.test(value);

/** The item's own file among the names in its folder: `<name>.<ext>`, or the one other file of that type. */
export function findEagleItemFile(item: Pick<EagleItem, 'name' | 'ext'>, fileNames: readonly string[]) {
  const exact = `${item.name}.${item.ext}`;
  if (fileNames.includes(exact)) {
    return exact;
  }
  const candidates = fileNames.filter(
    (fileName) =>
      fileName !== 'metadata.json' &&
      !fileName.endsWith('_thumbnail.png') &&
      fileName.toLowerCase().endsWith(`.${item.ext}`),
  );
  return candidates.length === 1 ? candidates[0] : undefined;
}

export interface EagleServerItem extends EagleItem {
  /** The name of the item's file in its folder, when it was found. */
  fileName?: string;
}

export interface EagleServerLibrary {
  name: string;
  folders: EagleFolder[];
  smartFolders: string[];
  tagGroups: string[];
  changed?: number;
  items: EagleServerItem[];
  fingerprint: string;
}

/** Builds the library from its lists, as the browser's reader does from the chosen folder. */
export function buildEagleLibrary(
  name: string,
  metadata: unknown,
  infoFolders: readonly { id: string; metadata: unknown; fileNames: readonly string[] }[],
): EagleServerLibrary | undefined {
  if (metadata === undefined) {
    return;
  }
  const library = parseEagleLibraryMetadata(metadata);
  const items = infoFolders.map(({ id, metadata: details, fileNames }): EagleServerItem => {
    if (details === undefined) {
      return unreadableEagleItem(id);
    }
    // The folder name locates the item's files: the id in its own JSON is never used for a path.
    const item = { ...parseEagleItem(details, id), id };
    const fileName = findEagleItemFile(item, fileNames);
    return fileName ? { ...item, present: true, fileName } : item;
  });
  const fingerprint = eagleLibraryFingerprint(metadata, library.folders, infoFolders.length);
  return { name, ...library, items, fingerprint };
}
