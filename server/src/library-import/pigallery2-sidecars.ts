import { posix } from 'node:path';
import { importFilePathSchema } from 'src/library-import/manifest.js';

/** Preserve every existing candidate; native photos stop at the first parsed sidecar, while videos merge all four. */
export const pigallery2SidecarCandidates = (originalPath: unknown): string[] => {
  const source = importFilePathSchema.safeParse(originalPath);
  if (source.success) {
    const stem = posix.join(posix.dirname(source.data), posix.parse(source.data).name);
    const paths = [...new Set([source.data + '.xmp', source.data + '.XMP', stem + '.xmp', stem + '.XMP'])];
    if (paths.every((path) => importFilePathSchema.safeParse(path).success)) return paths;
  }
  throw new Error('PiGallery2 source refused: PIGALLERY2_FILES_INVALID');
};
