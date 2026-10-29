/**
 * Import from Eagle (FL-653, approved prototype `boards-eagle.mjs`, README points 35-41).
 *
 * An Eagle library is a `*.library` folder: `metadata.json` holds the folder tree, smart folders and
 * tag groups, `tags.json` the tags, and each `images/<id>.info/` folder holds one file with its own
 * `metadata.json`. These are the pure parts of the import: reading those lists, the check before
 * importing (the dry run), where the collections go, and the finish report, which must add up to the
 * check. The Eagle library is only ever read.
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

/** File types Boards holds, as in the design. The server's own list narrows this further. */
export const BOARDS_EXTENSIONS: ReadonlySet<string> = new Set([
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
]);
export const VIDEO_EXTENSIONS: ReadonlySet<string> = new Set(['mp4', 'mov', 'webm', 'm4v', 'avi', 'mkv']);

export type UnsupportedReason = 'font' | 'sound' | 'model' | 'other';
const UNSUPPORTED_REASON: Readonly<Record<string, UnsupportedReason>> = {
  otf: 'font',
  ttf: 'font',
  woff: 'font',
  woff2: 'font',
  mp3: 'sound',
  wav: 'sound',
  aac: 'sound',
  flac: 'sound',
  m4a: 'sound',
  ogg: 'sound',
  c4d: 'model',
  blend: 'model',
  obj: 'model',
  fbx: 'model',
  glb: 'model',
  gltf: 'model',
  stl: 'model',
};

export interface EagleFolder {
  id: string;
  name: string;
  description?: string;
  color?: string;
  icon?: string;
  children: EagleFolder[];
}

/** A comment on an Eagle item. One with a width and height marks an area of the picture. */
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
  /** The file itself, when it was found in the item's folder. */
  file?: File;
  /** The item's `metadata.json` could not be read. */
  unreadable?: boolean;
}

export interface EagleLibrary {
  /** The folder's name, such as "Studio References.library". */
  name: string;
  folders: EagleFolder[];
  smartFolders: string[];
  tagGroups: string[];
  items: EagleItem[];
  /** When Eagle last changed the library (ms), if it says. */
  changed?: number;
  /**
   * Tells this library apart from another with the same folder name, so a saved import is only
   * carried on into the library it came from. See `eagleLibraryFingerprint`.
   */
  fingerprint: string;
}

export interface FlatFolder extends EagleFolder {
  parent: string | null;
  depth: number;
}

/** What happened to one item in an earlier run of the same import. */
export interface EagleItemOutcome {
  assetId: string;
  /** The file was already in the library, so it was not stored twice. */
  duplicate: boolean;
}

/* ------------------------------------------------------------------ */
/* Reading the lists                                                   */
/* ------------------------------------------------------------------ */

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

const FINGERPRINT_FIELDS = ['id', 'libraryId', 'createdAt', 'creationTime', 'btime'] as const;

/** cyrb53: a fast 53-bit string hash. Not for security; it only tells libraries apart. */
function cyrb53(text: string, seed: number) {
  let h1 = 0xde_ad_be_ef ^ seed;
  let h2 = 0x41_c6_ce_57 ^ seed;
  for (let index = 0; index < text.length; index++) {
    const code = text.codePointAt(index) ?? 0;
    h1 = Math.imul(h1 ^ code, 2_654_435_761);
    h2 = Math.imul(h2 ^ code, 1_597_334_677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2_246_822_507) ^ Math.imul(h2 ^ (h2 >>> 13), 3_266_489_909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2_246_822_507) ^ Math.imul(h1 ^ (h1 >>> 13), 3_266_489_909);
  return (4_294_967_296 * (2_097_151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0');
}

/**
 * A stable identity for one Eagle library. Eagle's own id or creation time when its `metadata.json`
 * has one; otherwise a hash of every folder's id and name (Eagle's folder ids are random per
 * library) and the number of items. Two libraries that share a folder name get different ones.
 * The hash is computed in plain script, because `crypto.subtle` is missing on a server reached over
 * plain HTTP on the home network.
 */
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
  };
}

/** An item whose `metadata.json` could not be read: kept so it is listed, never dropped quietly. */
export const unreadableEagleItem = (id: string): EagleItem => ({
  ...parseEagleItem({}, id),
  unreadable: true,
});

export const eagleFileName = (item: Pick<EagleItem, 'name' | 'ext'>) =>
  item.ext ? `${item.name}.${item.ext}` : item.name;

const flatten = (folders: EagleFolder[], parent: string | null = null, depth = 1): FlatFolder[] =>
  folders.flatMap((folder) => [{ ...folder, parent, depth }, ...flatten(folder.children, folder.id, depth + 1)]);
/** Every folder, parents before their children. */
export const eagleFolders = (library: Pick<EagleLibrary, 'folders'>) => flatten(library.folders);

/** The collection colour for an Eagle folder colour, if it has one. */
export const eagleColour = (color?: string) => (color ? EAGLE_COLOURS[color.toLowerCase()] : undefined);

/* ------------------------------------------------------------------ */
/* The check before importing                                          */
/* ------------------------------------------------------------------ */

export interface EaglePlanOptions {
  /** File extensions this server takes (lower case, no dot). Defaults to everything Boards holds. */
  supported?: ReadonlySet<string>;
  /** Items whose file is already in the library, found by its contents before importing. */
  existing?: ReadonlySet<string>;
  /** What earlier runs of this import did, keyed by Eagle item id. */
  outcomes?: Readonly<Record<string, EagleItemOutcome>>;
  /** Annotations can be written (FL-652). Until then, area comments are listed as not brought over. */
  annotations?: boolean;
}

export interface EagleUnsupported {
  name: string;
  reason: UnsupportedReason;
}

/** Whether a record comes over: in the library, of a type Boards holds, and its file is there. */
export function isComing(item: EagleItem, supported: ReadonlySet<string>) {
  return !item.unreadable && !item.isDeleted && supported.has(item.ext) && !!item.file;
}

/** Area comments on a picture: the ones that can become annotations. */
export const areaComments = (item: EagleItem) =>
  VIDEO_EXTENSIONS.has(item.ext) ? [] : item.comments.filter((comment) => comment.width > 0 && comment.height > 0);

export const supportedExtensions = (serverExtensions?: Iterable<string>) => {
  if (!serverExtensions) {
    return BOARDS_EXTENSIONS;
  }
  const server = new Set([...serverExtensions].map((extension) => extension.toLowerCase().replace(/^\./, '')));
  const supported = new Set<string>();
  // A loop rather than Set#intersection, which Chrome 109 lacks.
  for (const extension of BOARDS_EXTENSIONS) {
    if (server.has(extension)) {
      supported.add(extension);
    }
  }
  return supported;
};

/**
 * Items whose file has the same contents as an earlier item in the library. The import stores such a
 * file once, so the check counts every copy after the first as already in your library, as the upload
 * will. `items` are in the order the import sends them.
 */
export function repeatedContents(
  items: readonly Pick<EagleItem, 'id'>[],
  checksums: ReadonlyMap<string, { sha256: string }>,
): Set<string> {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const { id } of items) {
    const sha256 = checksums.get(id)?.sha256;
    if (!sha256) {
      continue;
    }
    if (seen.has(sha256)) {
      repeated.add(id);
    }
    seen.add(sha256);
  }
  return repeated;
}

/** The dry run: everything the import would do, worked out from the library's lists before any file is sent. */
export function planEagleImport(library: EagleLibrary, options: EaglePlanOptions = {}) {
  const supported = options.supported ?? BOARDS_EXTENSIONS;
  const existing = options.existing ?? new Set<string>();
  const outcomes = options.outcomes ?? {};
  const folders = eagleFolders(library);
  const folderIds = new Set(folders.map(({ id }) => id));
  const readable = library.items.filter((item) => !item.unreadable);
  const live = readable.filter((item) => !item.isDeleted);
  const trash = readable.filter((item) => item.isDeleted).map((item) => eagleFileName(item));
  const unsupported: EagleUnsupported[] = live
    .filter((item) => !supported.has(item.ext))
    .map((item) => ({ name: eagleFileName(item), reason: UNSUPPORTED_REASON[item.ext] ?? 'other' }));
  const missing = [
    ...library.items.filter((item) => item.unreadable).map((item) => `${item.id}.info`),
    ...live.filter((item) => supported.has(item.ext) && !item.file).map((item) => eagleFileName(item)),
  ];
  const coming = live.filter((item) => isComing(item, supported));
  const isAlready = (item: EagleItem) =>
    Object.hasOwn(outcomes, item.id) ? outcomes[item.id].duplicate : existing.has(item.id);
  const already = coming.filter((item) => isAlready(item)).length;
  const filedIn = (item: EagleItem) => item.folders.filter((id) => folderIds.has(id));
  const areas = coming.flatMap((item) => areaComments(item)).length;
  return {
    library: library.name,
    found: library.items.length,
    coming: coming.length,
    newFiles: coming.length - already,
    already,
    /** Brought over by an earlier run of this import. */
    done: coming.filter((item) => Object.hasOwn(outcomes, item.id)).length,
    leftOut: trash.length + unsupported.length + missing.length,
    trash,
    unsupported,
    missing,
    collections: folders.length,
    topLevel: library.folders.length,
    depth: folders.length > 0 ? Math.max(...folders.map(({ depth }) => depth)) : 0,
    inSeveral: coming.filter((item) => filedIn(item).length > 1).length,
    unfiled: coming.filter((item) => filedIn(item).length === 0).length,
    tags: new Set(coming.flatMap(({ tags }) => tags)).size,
    rated: coming.filter(({ star }) => star > 0).length,
    notes: coming.filter(({ annotation }) => annotation.trim()).length,
    /** Web addresses. Boards has no way to record them for an uploaded file yet, so they are listed. */
    sources: coming.filter(({ url }) => url).length,
    annotations: options.annotations ? areas : 0,
    /** Area comments that can't come over until annotations can be written. */
    areaCommentsWaiting: options.annotations ? 0 : areas,
    colouredFolders: folders.filter(({ color }) => eagleColour(color)).length,
    notMapped: {
      smartFolders: library.smartFolders,
      tagGroups: library.tagGroups,
      folderIcons: folders.filter(({ icon }) => icon).map(({ name }) => name),
      videoComments: coming
        .filter((item) => VIDEO_EXTENSIONS.has(item.ext) && item.comments.length > 0)
        .map((item) => eagleFileName(item)),
    },
  };
}
export type EaglePlan = ReturnType<typeof planEagleImport>;

/* ------------------------------------------------------------------ */
/* Where it goes                                                       */
/* ------------------------------------------------------------------ */

/** The default new collection the import goes into. */
export const EAGLE_DEFAULT_COLLECTION = 'Studio References';

export type EagleTarget = { mode: 'top' } | { mode: 'inside'; inside: 'new' | string };

const sameName = (a: string, b: string) => a.trim().toLocaleLowerCase() === b.trim().toLocaleLowerCase();

/**
 * The names Eagle's top folders get. Inside a collection they keep their names. At the top level a
 * folder whose name matches one of your top-level collections is called "Name (Eagle)", so nothing
 * is merged.
 */
export function topFolderNames(library: Pick<EagleLibrary, 'folders'>, target: EagleTarget, existingTop: string[]) {
  return new Map(
    library.folders.map((folder) => [
      folder.id,
      target.mode === 'top' && existingTop.some((name) => sameName(name, folder.name))
        ? `${folder.name} (Eagle)`
        : folder.name,
    ]),
  );
}

/** What the "Where should it go?" step shows. `insideName` is the chosen collection's name. */
export function previewTarget(
  library: Pick<EagleLibrary, 'folders'>,
  target: EagleTarget,
  insideName: string,
  existingTop: string[],
) {
  const named = topFolderNames(library, target, existingTop);
  const clashes = library.folders.filter((folder) => named.get(folder.id) !== folder.name).map(({ name }) => name);
  return {
    inside: target.mode === 'inside' ? insideName : undefined,
    top: library.folders.map((folder) => named.get(folder.id) ?? folder.name),
    clashes,
  };
}

/* ------------------------------------------------------------------ */
/* The finish report                                                   */
/* ------------------------------------------------------------------ */

export interface EagleResultInput {
  outcomes: Readonly<Record<string, EagleItemOutcome>>;
  /** Items that could not be sent this time, by file name. They can be tried again. */
  failed?: ReadonlySet<string>;
  /** How many collections were made. */
  collections: number;
  stopped: boolean;
  supported?: ReadonlySet<string>;
  annotations?: boolean;
}

/**
 * The finish report. Every item found is counted exactly once:
 * found = added + already + leftOut + notReached. The other counts are for what actually came over,
 * worked out from the same records as the check.
 */
export function importResult(plan: EaglePlan, library: EagleLibrary, input: EagleResultInput) {
  const supported = input.supported ?? BOARDS_EXTENSIONS;
  const coming = library.items.filter((item) => isComing(item, supported));
  const done = coming.filter((item) => Object.hasOwn(input.outcomes, item.id));
  const failed = coming
    .filter((item) => !Object.hasOwn(input.outcomes, item.id) && input.failed?.has(item.id))
    .map((item) => eagleFileName(item));
  const already = done.filter((item) => input.outcomes[item.id].duplicate).length;
  return {
    stopped: input.stopped,
    found: plan.found,
    added: done.length - already,
    already,
    failed,
    leftOut: plan.leftOut + failed.length,
    notReached: coming.length - done.length - failed.length,
    collections: input.collections,
    tags: new Set(done.flatMap(({ tags }) => tags)).size,
    rated: done.filter(({ star }) => star > 0).length,
    notes: done.filter(({ annotation }) => annotation.trim()).length,
    annotations: input.annotations ? done.flatMap((item) => areaComments(item)).length : 0,
  };
}
export type EagleResult = ReturnType<typeof importResult>;

/**
 * Whether the report adds up. Every import must account for every item found; a finished import
 * with nothing failed must also match the check exactly.
 */
export function reconciles(plan: EaglePlan, result: EagleResult) {
  const sum = result.added + result.already + result.leftOut + result.notReached === plan.found;
  if (!sum || result.stopped || result.failed.length > 0) {
    return sum;
  }
  return (
    result.notReached === 0 &&
    result.added === plan.newFiles &&
    result.already === plan.already &&
    result.collections === plan.collections &&
    (['tags', 'rated', 'notes', 'annotations'] as const).every((key) => result[key] === plan[key])
  );
}

/** A stable key for the resumable record: the same account and the same library folder. */
export const eagleImportKey = (ownerId: string, libraryName: string) => `${ownerId}:${libraryName}`;
