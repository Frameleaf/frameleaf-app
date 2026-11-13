const droppedPaths = new WeakMap<File, string>();
export const rememberDroppedPath = (file: File, fullPath: string) => {
  if (fullPath) {
    droppedPaths.set(file, fullPath.replace(/^\//, ''));
  }
};
export const uploadRelativePath = (file: File) => file.webkitRelativePath || droppedPaths.get(file) || '';

const isXmp = (file: File) => /\.xmp$/i.test(file.name);

export const pairXmpSidecars = (files: File[], accepts: (file: File) => boolean) => {
  const originals = files.filter((file) => !isXmp(file) && accepts(file));
  const sidecars = files.filter((file) => isXmp(file));
  const paths = (file: File) => (uploadRelativePath(file) || file.name).toLowerCase();
  const indexes = new Map<string, File[]>();
  const stems = new Map<string, File[]>();
  for (const original of originals) {
    const path = paths(original);
    const stem = path.replace(/\.[^./]+$/, '');
    for (const [map, key] of [
      [indexes, path],
      [stems, stem],
    ] as const) {
      const matches = map.get(key) ?? [];
      matches.push(original);
      map.set(key, matches);
    }
  }
  const pairs = new Map<File, File>();
  const unmatched = new Set(sidecars);
  for (const lookup of [indexes, stems]) {
    for (const sidecar of unmatched) {
      const matches = lookup.get(paths(sidecar).slice(0, -4));
      if (matches?.length !== 1 || pairs.has(matches[0])) {
        continue;
      }
      pairs.set(matches[0], sidecar);
      unmatched.delete(sidecar);
    }
  }
  return { pairs, unmatched, originals: files.filter((file) => !isXmp(file)) };
};
