/**
 * FL-838: the albums "Make an album for each folder" makes, for the preview on a folder's page and on Add a folder.
 * The same rules as the server's sync (`server/src/utils/folder-albums.ts`): a folder with photos becomes an album
 * named after it; a top-level folder holding only folders becomes a collection; deeper, such a folder is an album
 * that holds albums. Photos loose in the import folder go to an album named after the library, listed first.
 */

export type FolderAlbumNode = {
  name: string;
  path: string;
  kind: 'album' | 'collection';
  /** Photos and videos directly in the folder. */
  photos: number;
  /** Photos and videos in it and every folder below. */
  total: number;
  children: FolderAlbumNode[];
};

const trim = (path: string) => (path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path);
const parentOf = (path: string) => path.slice(0, path.lastIndexOf('/')) || '/';
const byName = (a: FolderAlbumNode, b: FolderAlbumNode) => a.name.localeCompare(b.name);

/** `folders` is what the folder estimate found: each folder holding photos, and how many it holds directly. */
export const folderAlbumTree = (
  roots: string[],
  folders: { path: string; count: number }[],
  libraryName: string,
): FolderAlbumNode[] => {
  const tree: FolderAlbumNode[] = [];
  for (const root of new Set(roots.map((root) => trim(root)))) {
    const prefix = root === '/' ? '/' : `${root}/`;
    const nodes = new Map<string, FolderAlbumNode>();
    const top: FolderAlbumNode[] = [];
    let loose = 0;
    const nodeFor = (path: string): FolderAlbumNode => {
      let node = nodes.get(path);
      if (!node) {
        node = { name: path.slice(path.lastIndexOf('/') + 1), path, kind: 'album', photos: 0, total: 0, children: [] };
        nodes.set(path, node);
        const parent = parentOf(path);
        (parent === root ? top : nodeFor(parent).children).push(node);
      }
      return node;
    };
    for (const { path, count } of folders) {
      const folder = trim(path);
      if (count <= 0) {
        continue;
      }
      if (folder === root) {
        loose += count;
        continue;
      }
      if (!folder.startsWith(prefix)) {
        continue;
      }
      nodeFor(folder).photos += count;
      for (let current = folder; current !== root; current = parentOf(current)) {
        nodes.get(current)!.total += count;
      }
    }
    for (const node of top) {
      node.kind = node.photos === 0 ? 'collection' : 'album';
    }
    if (loose > 0) {
      tree.push({ name: libraryName, path: root, kind: 'album', photos: loose, total: loose, children: [] });
    }
    tree.push(...top.sort(byName));
    for (const node of nodes.values()) {
      node.children.sort(byName);
    }
  }
  return tree;
};

/** How many albums and collections a tree makes. */
export const folderAlbumCounts = (tree: FolderAlbumNode[]) => {
  let albums = 0;
  let collections = 0;
  const walk = (node: FolderAlbumNode) => {
    if (node.kind === 'collection') {
      collections++;
    } else {
      albums++;
    }
    for (const child of node.children) {
      walk(child);
    }
  };
  for (const node of tree) {
    walk(node);
  }
  return { albums, collections };
};
